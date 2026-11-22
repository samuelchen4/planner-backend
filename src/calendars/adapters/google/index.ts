import type { CalendarProvider, SyncResult, WebhookRequest, WebhookResult } from '../../provider';
import { stubProvider } from '../stub';
import { listCalendarList, listEvents } from './api';
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

/** Google push notifications: X-Goog-* headers, no body. Subscribing arrives in step 6. */
function parseWebhook(req: WebhookRequest): WebhookResult {
  const subscriptionId = req.headers['x-goog-channel-id'];
  const state = req.headers['x-goog-resource-state'];
  if (!subscriptionId || !state) return { kind: 'invalid' };
  if (state === 'sync') return { kind: 'ignore' }; // sent once when a channel is created
  return { kind: 'change', subscriptionId, secret: req.headers['x-goog-channel-token'] ?? null };
}

export const google: CalendarProvider = {
  // Webhooks, pushing and editing are filled in by step 6 and phases 2–3.
  ...stubProvider('google'),
  capabilities: { webhooks: false, pushTasks: false, editEvents: false },
  authUrl,
  exchangeCode,
  accessToken,
  revoke,
  listCalendars: async (token) => (await listCalendarList(token)).items.map(toProviderCalendar),
  syncEvents,
  parseWebhook,
};
