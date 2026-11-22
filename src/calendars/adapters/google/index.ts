import { randomUUID } from 'node:crypto';

import type {
  CalendarProvider,
  Subscription,
  SyncResult,
  WebhookRequest,
  WebhookResult,
} from '../../provider';
import { stubProvider } from '../stub';
import { listCalendarList, listEvents, stopChannel, watchEvents } from './api';
import { toProviderCalendar, toProviderEvent } from './mapping';
import { accessToken, authUrl, exchangeCode, revoke } from './oauth';

/** How far back a full sync reaches. Without a window, Google returns the calendar's whole past. */
const FULL_SYNC_DAYS_BACK = 30;

async function syncEvents(
  token: string,
  calendar: { providerCalendarId: string },
  cursor: string | null,
): Promise<SyncResult> {
  const timeMin = new Date(Date.now() - FULL_SYNC_DAYS_BACK * 24 * 3600 * 1000).toISOString();
  const page = await listEvents(
    token,
    calendar.providerCalendarId,
    cursor ? { syncToken: cursor } : { timeMin },
  );
  if (!page.nextSyncToken) throw new Error('Google returned no sync token');
  const upserts = [];
  const deletes = [];
  for (const item of page.items) {
    const event = toProviderEvent(item, page.timeZone ?? null);
    // Cancelled, or a type Planner doesn't show: make sure we don't keep a copy.
    if (event) upserts.push(event);
    else deletes.push(item.id);
  }
  return {
    upserts,
    deletes,
    cursor: page.nextSyncToken,
    ...(!cursor && { window: { start: timeMin, end: null } }),
  };
}

/** Channels last about a week; the engine replaces them a day before they expire. */
const CHANNEL_TTL_SECONDS = 7 * 24 * 3600;

async function subscribe(
  token: string,
  calendar: { providerCalendarId: string },
  input: { callbackUrl: string; secret: string },
): Promise<Subscription> {
  const id = randomUUID();
  const channel = await watchEvents(token, calendar.providerCalendarId, {
    id,
    address: input.callbackUrl,
    token: input.secret,
    ttlSeconds: CHANNEL_TTL_SECONDS,
  });
  const expiresAt = channel.expiration
    ? new Date(Number(channel.expiration))
    : new Date(Date.now() + CHANNEL_TTL_SECONDS * 1000);
  return {
    id: channel.id ?? id,
    resourceId: channel.resourceId,
    secret: input.secret,
    expiresAt: expiresAt.toISOString(),
  };
}

async function unsubscribe(token: string, subscription: Subscription) {
  // Without the resource id Google can't stop it; it expires on its own within the week.
  if (!subscription.resourceId) return;
  await stopChannel(token, { id: subscription.id, resourceId: subscription.resourceId });
}

/** Google push notifications: X-Goog-* headers, no body. */
function parseWebhook(req: WebhookRequest): WebhookResult {
  const subscriptionId = req.headers['x-goog-channel-id'];
  const state = req.headers['x-goog-resource-state'];
  if (!subscriptionId || !state) return { kind: 'invalid' };
  if (state === 'sync') return { kind: 'ignore' }; // sent once when a channel is created
  return { kind: 'change', subscriptionId, secret: req.headers['x-goog-channel-token'] ?? null };
}

export const google: CalendarProvider = {
  // Pushing tasks and editing events are filled in by phases 2–3.
  ...stubProvider('google'),
  capabilities: { webhooks: true, pushTasks: false, editEvents: false },
  authUrl,
  exchangeCode,
  accessToken,
  revoke,
  listCalendars: async (token) => (await listCalendarList(token)).items.map(toProviderCalendar),
  syncEvents,
  subscribe,
  // Google channels can't be extended: a new channel replaces the old (the engine stops it).
  renew: (token, calendar, _old, input) => subscribe(token, calendar, input),
  unsubscribe,
  parseWebhook,
};
