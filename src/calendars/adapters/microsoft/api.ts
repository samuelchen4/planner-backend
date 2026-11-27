import { CalendarNotFound, CursorExpired, RateLimited } from '../../provider';

// A thin fetch client for the few Microsoft Graph endpoints we use, mapping Graph's errors to the
// contract's (CursorExpired, RateLimited, CalendarNotFound).

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Times in UTC, bodies as plain text, big pages. */
const PREFER = 'odata.maxpagesize=200, outlook.timezone="UTC", outlook.body-content-type="text"';

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEvent {
  id: string;
  '@removed'?: { reason: string };
  '@odata.etag'?: string;
  changeKey?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  originalStartTimeZone?: string;
  originalStart?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  responseStatus?: { response?: string };
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
  webLink?: string;
  lastModifiedDateTime?: string;
}

export interface GraphCalendar {
  id: string;
  name?: string;
  color?: string;
  hexColor?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
}

export interface GraphSubscription {
  id: string;
  expirationDateTime: string;
}

interface GraphError {
  error?: { code?: string; message?: string };
}

/** Sync position errors: the delta token is too old, unknown or malformed. Start over. */
const CURSOR_CODES = new Set([
  'SyncStateNotFound',
  'syncStateNotFound',
  'SyncStateInvalid',
  'ErrorInvalidSyncStateData',
  'resyncRequired',
]);

async function request<T>(
  token: string,
  url: string,
  init: { method?: string; body?: unknown; cursorRequest?: boolean } = {},
): Promise<T> {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: PREFER,
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => null)) as GraphError | null;
  const code = body?.error?.code;
  if (res.status === 429 || res.status === 503) {
    throw new RateLimited(Number(res.headers.get('retry-after')) || 30);
  }
  if (res.status === 410 || (code && CURSOR_CODES.has(code))) throw new CursorExpired(code);
  // A resumed delta link that Graph can't read (e.g. "Badly formed token"): start over.
  if (init.cursorRequest && res.status === 400) throw new CursorExpired(code);
  if (res.status === 404) throw new CalendarNotFound();
  throw new Error(`Graph ${init.method ?? 'GET'} failed (${res.status}${code ? `, ${code}` : ''})`);
}

interface Page<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export async function listCalendars(token: string): Promise<GraphCalendar[]> {
  const items: GraphCalendar[] = [];
  let next: string | undefined = '/me/calendars?$top=100';
  while (next) {
    const page: Page<GraphCalendar> = await request(token, next);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}

/**
 * One delta round of a calendar's events in a fixed window: from the start (`window`) or resuming
 * a saved delta link (`deltaLink`). Repeating events come expanded into occurrences. Returns
 * every item and the delta link for next time.
 */
export async function eventsDelta(
  token: string,
  calendarId: string,
  from: { deltaLink: string } | { window: { start: string; end: string } },
) {
  let next: string | undefined =
    'deltaLink' in from
      ? from.deltaLink
      : `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${new URLSearchParams({
          startDateTime: from.window.start,
          endDateTime: from.window.end,
        })}`;
  const items: GraphEvent[] = [];
  while (next) {
    const page: Page<GraphEvent> = await request(token, next, {
      cursorRequest: 'deltaLink' in from,
    });
    items.push(...(page.value ?? []));
    if (page['@odata.deltaLink']) return { items, deltaLink: page['@odata.deltaLink'] };
    next = page['@odata.nextLink'];
  }
  throw new Error('Graph delta ended without a delta link');
}

/**
 * Change notifications for one calendar's events. Graph checks `notificationUrl` before this
 * returns (it POSTs a validationToken the webhook must echo).
 */
export function createSubscription(
  token: string,
  input: { calendarId: string; notificationUrl: string; clientState: string; expiresAt: string },
) {
  return request<GraphSubscription>(token, '/subscriptions', {
    body: {
      changeType: 'created,updated,deleted',
      notificationUrl: input.notificationUrl,
      resource: `/me/calendars/${input.calendarId}/events`,
      expirationDateTime: input.expiresAt,
      clientState: input.clientState,
      latestSupportedTlsVersion: 'v1_2',
    },
  });
}

/** Graph subscriptions are extended in place (same id and clientState). */
export function extendSubscription(token: string, id: string, expiresAt: string) {
  return request<GraphSubscription>(token, `/subscriptions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { expirationDateTime: expiresAt },
  });
}

/** Already gone (404) counts as deleted. */
export async function deleteSubscription(token: string, id: string) {
  try {
    await request<void>(token, `/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    if (!(e instanceof CalendarNotFound)) throw e;
  }
}
