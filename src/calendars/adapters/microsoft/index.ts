import type {
  CalendarProvider,
  CalendarRef,
  Subscription,
  SyncResult,
  WebhookRequest,
  WebhookResult,
} from '../../provider';
import { stubProvider } from '../stub';
import {
  createSubscription,
  deleteSubscription,
  eventsDelta,
  extendSubscription,
  listCalendars,
} from './api';
import { toProviderCalendar, toProviderEvent } from './mapping';
import { accessToken, authUrl, exchangeCode, revoke } from './oauth';

// Microsoft Graph (Outlook / Microsoft 365). Differences from Google, all kept in here: the delta
// sync needs a fixed date window (moved forward by the engine's rebaseline job), subscriptions
// last about 3 days and are extended in place, and Graph checks the webhook with a
// validationToken handshake and can batch several notifications in one request.

const DAY = 24 * 3600 * 1000;
/** The window a full sync covers. Events beyond the end appear after the next rebaseline. */
const WINDOW_DAYS_BACK = 30;
const WINDOW_DAYS_AHEAD = 365;
/** Graph's limit for event subscriptions is about 3 days (4230 minutes); stay just under. */
const SUBSCRIPTION_MINUTES = 4200;

async function syncEvents(
  token: string,
  calendar: CalendarRef,
  cursor: string | null,
): Promise<SyncResult> {
  const window = {
    start: new Date(Date.now() - WINDOW_DAYS_BACK * DAY).toISOString(),
    end: new Date(Date.now() + WINDOW_DAYS_AHEAD * DAY).toISOString(),
  };
  const round = await eventsDelta(
    token,
    calendar.providerCalendarId,
    cursor ? { deltaLink: cursor } : { window },
  );
  const upserts = [];
  const deletes = [];
  for (const item of round.items) {
    const event = toProviderEvent(item);
    if (event) upserts.push(event);
    // Removed, cancelled, or not shown: make sure we don't keep a copy.
    else deletes.push(item.id);
  }
  return {
    upserts,
    deletes,
    cursor: round.deltaLink,
    ...(!cursor && { window }),
  };
}

const expiry = () => new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();

async function subscribe(
  token: string,
  calendar: CalendarRef,
  input: { callbackUrl: string; secret: string },
): Promise<Subscription> {
  const created = await createSubscription(token, {
    calendarId: calendar.providerCalendarId,
    notificationUrl: input.callbackUrl,
    clientState: input.secret,
    expiresAt: expiry(),
  });
  return {
    id: created.id,
    resourceId: null,
    secret: input.secret,
    expiresAt: new Date(created.expirationDateTime).toISOString(),
  };
}

/** Extends in place: same id and secret (Graph can't change clientState on renewal). */
async function renew(
  token: string,
  calendar: CalendarRef,
  old: Subscription,
  input: { callbackUrl: string; secret: string },
): Promise<Subscription> {
  try {
    const extended = await extendSubscription(token, old.id, expiry());
    return { ...old, expiresAt: new Date(extended.expirationDateTime).toISOString() };
  } catch {
    // Expired or removed by Graph: start a new one (the engine stops the old id, harmlessly).
    return subscribe(token, calendar, input);
  }
}

async function unsubscribe(token: string, subscription: Subscription) {
  await deleteSubscription(token, subscription.id);
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
}

/**
 * Graph webhooks: a validation request (`?validationToken=…`, echo it as plain text) when a
 * subscription is created, then notifications as a JSON `value` array.
 */
function parseWebhook(req: WebhookRequest): WebhookResult {
  const validationToken = req.query.validationToken;
  if (validationToken) return { kind: 'handshake', body: validationToken };
  const value = (req.body as { value?: GraphNotification[] } | null)?.value;
  if (!Array.isArray(value) || !value.length) return { kind: 'invalid' };
  const changes = value
    .filter((n) => typeof n.subscriptionId === 'string')
    .map((n) => ({ subscriptionId: n.subscriptionId!, secret: n.clientState ?? null }));
  return changes.length ? { kind: 'change', changes } : { kind: 'invalid' };
}

export const microsoft: CalendarProvider = {
  // Pushing tasks and editing events are filled in by phases 2–3.
  ...stubProvider('microsoft'),
  capabilities: { webhooks: true, pushTasks: false, editEvents: false },
  authUrl,
  exchangeCode,
  accessToken,
  revoke,
  listCalendars: async (token) => (await listCalendars(token)).map(toProviderCalendar),
  syncEvents,
  subscribe,
  renew,
  unsubscribe,
  parseWebhook,
};
