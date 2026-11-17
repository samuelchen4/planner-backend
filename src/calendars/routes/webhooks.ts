import { timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db/client';
import { calendarSyncState } from '../../db/schema';
import { enqueueCalendarJob } from '../engine/jobs';
import { isProviderId, providerFor } from '../registry';

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * POST /webhooks/:provider: a provider saying "something changed in a calendar". Pings carry no
 * event data; we check the subscription's secret, queue a sync of that calendar, and answer fast
 * (providers retry slow webhooks). Mounted at /webhooks.
 */
export const webhookRoutes = new Hono().post('/:provider', async (c) => {
  const id = c.req.param('provider');
  if (!isProviderId(id)) return c.json({ error: 'Unknown provider' }, 404);

  const result = providerFor(id).parseWebhook({
    headers: Object.fromEntries(
      Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    query: c.req.query(),
    body: await c.req.json().catch(() => null),
  });

  switch (result.kind) {
    case 'handshake':
      return c.text(result.body, 200);
    case 'ignore':
      return c.body(null, 200);
    case 'invalid':
      return c.json({ error: 'Invalid webhook' }, 400);
  }

  const [state] = await db
    .select({
      calendarId: calendarSyncState.calendar_id,
      secret: calendarSyncState.subscription_secret,
    })
    .from(calendarSyncState)
    .where(eq(calendarSyncState.subscription_id, result.subscriptionId));
  // Unknown subscription or wrong secret: 200 anyway (no retries, nothing learned by the caller).
  if (!state?.secret || !result.secret || !sameSecret(state.secret, result.secret)) {
    return c.body(null, 200);
  }
  await enqueueCalendarJob({ type: 'sync-calendar', calendarId: state.calendarId });
  return c.body(null, 202);
});
