import { randomBytes } from 'node:crypto';

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db } from '../../db/client';
import { calendarAccounts, calendars, calendarSyncState } from '../../db/schema';
import { calendarEnv } from '../env';
import type { Subscription } from '../provider';
import { providerFor } from '../registry';
import { withAccess } from './accounts';

// Live updates: a provider subscription ("watch") per selected calendar, so the provider pings
// /webhooks/<provider> when something changes. Subscriptions expire (Google: about a week), so a
// daily job replaces any expiring within RENEW_AHEAD_HOURS. Calendars that can't be watched (some
// Google calendars, e.g. public holidays) still get the scheduled poll.

const RENEW_AHEAD_HOURS = 24;

/** Where providers send pings; null when this service has no public HTTPS address (local dev). */
export function webhookUrl(provider: string): string | null {
  const base = calendarEnv().CALENDAR_PUBLIC_URL;
  if (!base?.startsWith('https://')) return null;
  return `${base.replace(/\/$/, '')}/webhooks/${provider}`;
}

function storedSubscription(state: {
  subscription_id: string | null;
  subscription_resource_id: string | null;
  subscription_secret: string | null;
  subscription_expires_at: string | null;
}): Subscription | null {
  if (!state.subscription_id || !state.subscription_secret) return null;
  return {
    id: state.subscription_id,
    resourceId: state.subscription_resource_id,
    secret: state.subscription_secret,
    expiresAt: state.subscription_expires_at ?? new Date(0).toISOString(),
  };
}

const CLEARED = {
  subscription_id: null,
  subscription_resource_id: null,
  subscription_secret: null,
  subscription_expires_at: null,
};

/**
 * Start (or replace) the subscription for a selected calendar. The new one is saved before the
 * old one is stopped, so there's no moment without one. Does nothing without a public URL, for
 * providers without webhooks, or for calendars that aren't selected.
 */
export async function subscribeCalendar(calendarId: string) {
  const [cal] = await db
    .select({
      calendar: calendars,
      provider: calendarAccounts.provider,
      state: calendarSyncState,
    })
    .from(calendars)
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.account_id))
    .leftJoin(calendarSyncState, eq(calendarSyncState.calendar_id, calendars.id))
    .where(eq(calendars.id, calendarId));
  if (!cal || !cal.calendar.is_selected || cal.calendar.is_planner_calendar) return;
  const callbackUrl = webhookUrl(cal.provider);
  if (!callbackUrl || !providerFor(cal.provider).capabilities.webhooks) return;

  await withAccess(cal.calendar.account_id, async (token, provider) => {
    const ref = {
      providerCalendarId: cal.calendar.provider_calendar_id,
      windowStart: cal.state?.window_start ?? null,
      windowEnd: cal.state?.window_end ?? null,
    };
    const input = { callbackUrl, secret: randomBytes(24).toString('base64url') };
    const old = cal.state ? storedSubscription(cal.state) : null;
    const next = old
      ? await provider.renew(token, ref, old, input)
      : await provider.subscribe(token, ref, input);

    const kept = await db.transaction(async (tx) => {
      const [still] = await tx
        .select({ selected: calendars.is_selected })
        .from(calendars)
        .where(eq(calendars.id, calendarId))
        .for('update');
      if (!still?.selected) return false; // switched off meanwhile
      await tx.insert(calendarSyncState).values({ calendar_id: calendarId }).onConflictDoNothing();
      await tx
        .update(calendarSyncState)
        .set({
          subscription_id: next.id,
          subscription_resource_id: next.resourceId,
          subscription_secret: next.secret,
          subscription_expires_at: next.expiresAt,
          updated_at: sql`now()`,
        })
        .where(eq(calendarSyncState.calendar_id, calendarId));
      return true;
    });

    const stop = [...(kept ? [] : [next]), ...(old && old.id !== next.id ? [old] : [])];
    for (const s of stop) {
      await provider
        .unsubscribe(token, s)
        .catch((e) => console.warn('[calendars] stopping a subscription failed (ignored)', e));
    }
  });
}

/** Stop a calendar's subscription (best effort) and forget it. */
export async function unsubscribeCalendar(calendarId: string) {
  const [cal] = await db
    .select({ accountId: calendars.account_id, state: calendarSyncState })
    .from(calendars)
    .innerJoin(calendarSyncState, eq(calendarSyncState.calendar_id, calendars.id))
    .where(eq(calendars.id, calendarId));
  const existing = cal && storedSubscription(cal.state);
  if (!cal || !existing) return;
  await withAccess(cal.accountId, (token, provider) => provider.unsubscribe(token, existing)).catch(
    (e) => console.warn('[calendars] unsubscribe failed (ignored)', e),
  );
  await db
    .update(calendarSyncState)
    .set({ ...CLEARED, updated_at: sql`now()` })
    .where(eq(calendarSyncState.calendar_id, calendarId));
}

/**
 * Scheduled daily: subscribe every selected calendar that has no subscription or one expiring
 * within RENEW_AHEAD_HOURS. Also picks up calendars whose subscribing failed earlier.
 */
export async function renewSubscriptions() {
  if (!calendarEnv().CALENDAR_PUBLIC_URL?.startsWith('https://')) return;
  const rows = await db
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.account_id))
    .leftJoin(calendarSyncState, eq(calendarSyncState.calendar_id, calendars.id))
    .where(
      and(
        eq(calendars.is_selected, true),
        eq(calendars.is_planner_calendar, false),
        eq(calendarAccounts.status, 'active'),
        or(
          isNull(calendarSyncState.subscription_id),
          lt(
            calendarSyncState.subscription_expires_at,
            sql`now() + make_interval(hours => ${RENEW_AHEAD_HOURS})`,
          ),
        ),
      ),
    );
  for (const { id } of rows) {
    await subscribeCalendar(id).catch((e) =>
      console.warn(`[calendars] subscribing calendar ${id} failed`, e),
    );
  }
}
