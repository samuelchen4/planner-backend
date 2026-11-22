import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { requireUser, type AuthVariables } from '../../auth';
import { db } from '../../db/client';
import { calendarAccounts } from '../../db/schema';
import { connectAccount } from '../engine/accounts';
import { syncCalendarList } from '../engine/calendar-list';
import { enqueueCalendarJob } from '../engine/jobs';
import { calendarEnv } from '../env';
import { isProviderId, providerFor } from '../registry';
import { RETURN_SCHEMES, signState, verifyState } from '../state';

/**
 * This service's public base URL, for OAuth redirect URIs. CALENDAR_PUBLIC_URL when set (it must
 * match a redirect URI registered with the provider); otherwise the request's own origin.
 */
function publicBase(c: Context) {
  const configured = calendarEnv().CALENDAR_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, '');
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${c.req.header('x-forwarded-host') ?? url.host}`;
}

const redirectUri = (c: Context, provider: string) =>
  `${publicBase(c)}/integrations/${provider}/callback`;

const startBody = z.object({ returnScheme: z.enum(RETURN_SCHEMES).default('planner') });

/**
 * Connecting and disconnecting calendar accounts. Mounted at /integrations.
 *   POST   /:provider/start     signed in; body { returnScheme? } → { url } (open in a browser)
 *   GET    /:provider/callback  from the provider → store the account, import its calendars,
 *                               redirect to <returnScheme>://integrations/done (or /error)
 *   DELETE /accounts/:id        signed in → disconnect (queued)
 */
export const integrationRoutes = new Hono<{ Variables: AuthVariables }>()
  .delete('/accounts/:id', requireUser, async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return c.json({ error: 'Not found' }, 404);
    const [owned] = await db
      .select({ id: calendarAccounts.id })
      .from(calendarAccounts)
      .where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.user_id, c.get('userId'))));
    if (!owned) return c.json({ error: 'Not found' }, 404);
    await enqueueCalendarJob({ type: 'disconnect-account', accountId: id });
    return c.json({ ok: true }, 202);
  })

  .post('/:provider/start', requireUser, async (c) => {
    const provider = c.req.param('provider');
    if (!isProviderId(provider)) return c.json({ error: 'Unknown provider' }, 404);
    const body = startBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Bad request', issues: body.error.issues }, 400);
    const state = signState({
      userId: c.get('userId'),
      provider,
      returnScheme: body.data.returnScheme,
      features: ['read'],
    });
    try {
      const url = providerFor(provider).authUrl({
        state,
        redirectUri: redirectUri(c, provider),
        features: ['read'],
      });
      return c.json({ url });
    } catch (e) {
      console.error(`[calendars] ${provider} connect isn't available`, e);
      return c.json({ error: `${provider} calendars aren't available yet` }, 503);
    }
  })

  .get('/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    const state = verifyState(c.req.query('state') ?? '');
    if (!state || state.provider !== provider || !isProviderId(provider)) {
      return c.text('This link has expired. Start connecting again from the app.', 400);
    }
    const back = (path: 'done' | 'error', params: Record<string, string> = {}) =>
      c.redirect(
        `${state.returnScheme}://integrations/${path}?${new URLSearchParams({ provider, ...params })}`,
      );

    const code = c.req.query('code');
    if (!code) return back('error', { reason: c.req.query('error') ?? 'no_code' });
    try {
      const account = await providerFor(provider).exchangeCode({
        code,
        redirectUri: redirectUri(c, provider),
      });
      const accountId = await connectAccount(state.userId, provider, account);
      // Import the calendar list before returning to the app, so it has something to show.
      await syncCalendarList(accountId).catch(async (e) => {
        console.error('[calendars] calendar list after connect failed; retrying in background', e);
        await enqueueCalendarJob({ type: 'sync-calendar-list', accountId });
      });
      return back('done');
    } catch (e) {
      console.error(`[calendars] ${provider} connect failed`, e);
      return back('error', { reason: 'connect_failed' });
    }
  });
