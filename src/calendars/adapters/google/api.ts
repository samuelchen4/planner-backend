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

async function get<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => null)) as {
    error?: { errors?: { reason?: string }[]; message?: string };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason;
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
    const page = await get<Page<T>>(token, path, { ...params, ...(pageToken && { pageToken }) });
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
