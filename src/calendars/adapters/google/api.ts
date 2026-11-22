import { CalendarNotFound, CursorExpired, RateLimited } from '../../provider';

// A thin fetch client for the few Google Calendar endpoints we use, mapping Google's errors to
// the contract's (CursorExpired, RateLimited, CalendarNotFound).

const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  htmlLink?: string;
  updated?: string;
  eventType?: string;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
}

interface Page<T> {
  items?: T[];
  nextPageToken?: string;
  nextSyncToken?: string;
  /** events.list: the calendar's own time zone (events in it may omit start.timeZone). */
  timeZone?: string;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

async function request<T>(
  token: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${query ? `?${query}` : ''}`, {
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
  });
  if (res.status === 204) return undefined as T;
  if (res.ok) return (await res.json()) as T;

  const failure = (await res.json().catch(() => null)) as {
    error?: { errors?: { reason?: string }[]; message?: string };
  } | null;
  const reason = failure?.error?.errors?.[0]?.reason;
  if (res.status === 410) throw new CursorExpired(reason);
  if (res.status === 429 || (res.status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    throw new RateLimited(Number(res.headers.get('retry-after')) || 30);
  }
  if (res.status === 404) throw new CalendarNotFound();
  throw new Error(`Google ${path} failed (${res.status}${reason ? `, ${reason}` : ''})`);
}

/** Every page of a list endpoint. */
async function getAll<T>(token: string, path: string, params: Record<string, string>) {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await request<Page<T>>(token, path, {
      ...params,
      ...(pageToken && { pageToken }),
    });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    // The sync token (and the calendar's zone) come on the last page only.
    if (!pageToken) return { items, nextSyncToken: page.nextSyncToken, timeZone: page.timeZone };
  }
}

export function listCalendarList(token: string) {
  return getAll<GoogleCalendarListEntry>(token, '/users/me/calendarList', { maxResults: '250' });
}

/**
 * Events for sync. Every request sends singleEvents=true (repeating events expanded): Google
 * doesn't reject a syncToken used with different parameters, it silently changes the results.
 * A full sync passes `timeMin`; an incremental one passes only `syncToken` (both together → 400).
 */
export function listEvents(
  token: string,
  calendarId: string,
  from: { syncToken: string } | { timeMin: string },
) {
  return getAll<GoogleEvent>(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    singleEvents: 'true',
    maxResults: '2500',
    ...from,
  });
}

export interface GoogleChannel {
  id: string;
  resourceId: string;
  /** Milliseconds since the epoch, as a string. */
  expiration?: string;
}

/**
 * Push notifications for a calendar's events: Google POSTs to `address` (HTTPS) with the channel
 * id and `token` in X-Goog-* headers whenever something changes. Channels can't be extended, only
 * replaced; `ttlSeconds` is a request (Google may cap it).
 */
export function watchEvents(
  token: string,
  calendarId: string,
  channel: { id: string; address: string; token: string; ttlSeconds: number },
) {
  return request<GoogleChannel>(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {},
    {
      id: channel.id,
      type: 'web_hook',
      address: channel.address,
      token: channel.token,
      params: { ttl: String(channel.ttlSeconds) },
    },
  );
}

/** Stop a channel. Already stopped or expired (404) counts as done. */
export async function stopChannel(token: string, channel: { id: string; resourceId: string }) {
  try {
    await request<void>(token, '/channels/stop', {}, channel);
  } catch (e) {
    if (!(e instanceof CalendarNotFound)) throw e;
  }
}
