import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCalendarEnv } from '../../env';
import { CalendarNotFound, CursorExpired, NeedsReconnect, RateLimited } from '../../provider';
import type { GoogleEvent } from './api';
import { google } from './index';
import { toProviderEvent } from './mapping';

// The Google adapter against recorded-shape payloads and a faked fetch (no network, no secrets).

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  resetCalendarEnv();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  resetCalendarEnv();
});

const requestedUrl = (call = 0) => new URL(String(fetchMock.mock.calls[call]![0]));

describe('mapping', () => {
  const base: GoogleEvent = { id: 'e1', etag: '"1"', status: 'confirmed', summary: 'Review' };

  it('maps a timed event to UTC, keeping its zone', () => {
    const e = toProviderEvent(
      {
        ...base,
        start: { dateTime: '2026-11-17T15:00:00-05:00', timeZone: 'America/Toronto' },
        end: { dateTime: '2026-11-17T16:00:00-05:00', timeZone: 'America/Toronto' },
        updated: '2026-11-16T19:02:11.000Z',
        htmlLink: 'https://calendar.google.com/event?eid=x',
      },
      'America/Edmonton',
    );
    expect(e).toMatchObject({
      id: 'e1',
      title: 'Review',
      startAt: '2026-11-17T20:00:00.000Z',
      endAt: '2026-11-17T21:00:00.000Z',
      timeZone: 'America/Toronto',
      allDayStart: null,
      version: '"1"',
      webLink: 'https://calendar.google.com/event?eid=x',
    });
  });

  it("falls back to the calendar's zone when the event omits it", () => {
    const e = toProviderEvent(
      {
        ...base,
        start: { dateTime: '2026-11-17T09:00:00-07:00' },
        end: { dateTime: '2026-11-17T10:00:00-07:00' },
      },
      'America/Edmonton',
    );
    expect(e?.timeZone).toBe('America/Edmonton');
  });

  it('maps a multi-day all-day event with an exclusive end', () => {
    const e = toProviderEvent(
      { ...base, start: { date: '2026-11-20' }, end: { date: '2026-11-23' } },
      'UTC',
    );
    expect(e).toMatchObject({
      allDayStart: '2026-11-20',
      allDayEnd: '2026-11-23',
      startAt: null,
      timeZone: null,
    });
  });

  it('keeps which series and occurrence a repeating instance is', () => {
    const e = toProviderEvent(
      {
        ...base,
        id: 'e1_20261118T150000Z',
        recurringEventId: 'e1',
        originalStartTime: { dateTime: '2026-11-18T10:00:00-05:00' },
        start: { dateTime: '2026-11-18T11:00:00-05:00' },
        end: { dateTime: '2026-11-18T12:00:00-05:00' },
      },
      'UTC',
    );
    expect(e).toMatchObject({ seriesId: 'e1', originalStartAt: '2026-11-18T15:00:00.000Z' });
  });

  it('drops cancelled events and types Planner does not show', () => {
    const times = { start: { date: '2026-11-20' }, end: { date: '2026-11-21' } };
    expect(toProviderEvent({ ...base, ...times, status: 'cancelled' }, null)).toBeNull();
    expect(toProviderEvent({ ...base, ...times, eventType: 'workingLocation' }, null)).toBeNull();
    expect(toProviderEvent({ ...base, ...times, eventType: 'birthday' }, null)).toBeNull();
    expect(toProviderEvent({ ...base, ...times, eventType: 'fromGmail' }, null)).not.toBeNull();
    expect(toProviderEvent({ ...base, ...times, eventType: 'outOfOffice' }, null)).not.toBeNull();
  });

  it('marks tentative events', () => {
    const e = toProviderEvent(
      { ...base, status: 'tentative', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } },
      null,
    );
    expect(e?.status).toBe('tentative');
  });
});

describe('syncEvents', () => {
  const cal = { providerCalendarId: 'me@gmail.com', windowStart: null, windowEnd: null };
  const timed = (id: string) => ({
    id,
    etag: `"${id}"`,
    start: { dateTime: '2026-11-17T15:00:00Z' },
    end: { dateTime: '2026-11-17T16:00:00Z' },
  });

  it('does a windowed full sync across pages, taking the token from the last page', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [timed('a')], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(
        json({
          items: [timed('b'), { id: 'c', status: 'cancelled' }],
          nextSyncToken: 'sync-1',
          timeZone: 'America/Edmonton',
        }),
      );
    const result = await google.syncEvents('token', cal, null);
    expect(result.upserts.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.deletes).toEqual(['c']);
    expect(result.cursor).toBe('sync-1');
    expect(result.window?.start).toBeTruthy();

    const first = requestedUrl(0);
    expect(first.pathname).toBe('/calendar/v3/calendars/me%40gmail.com/events');
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(first.searchParams.get('timeMin')).toBeTruthy();
    expect(first.searchParams.has('syncToken')).toBe(false);
    expect(requestedUrl(1).searchParams.get('pageToken')).toBe('p2');
  });

  it('sends only the sync token (and singleEvents) on an incremental sync', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], nextSyncToken: 'sync-2' }));
    const result = await google.syncEvents('token', cal, 'sync-1');
    const url = requestedUrl();
    expect(url.searchParams.get('syncToken')).toBe('sync-1');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.has('timeMin')).toBe(false);
    expect(result.window).toBeUndefined();
  });

  it("maps Google's errors to the contract's", async () => {
    const error = (status: number, reason?: string, headers?: Record<string, string>) =>
      json({ error: { errors: reason ? [{ reason }] : [] } }, status, headers);
    fetchMock.mockResolvedValueOnce(error(410, 'fullSyncRequired'));
    await expect(google.syncEvents('t', cal, 'old')).rejects.toBeInstanceOf(CursorExpired);

    fetchMock.mockResolvedValueOnce(error(429, undefined, { 'retry-after': '12' }));
    await expect(google.syncEvents('t', cal, 'x')).rejects.toMatchObject({
      retryAfterSeconds: 12,
    });

    fetchMock.mockResolvedValueOnce(error(403, 'userRateLimitExceeded'));
    await expect(google.syncEvents('t', cal, 'x')).rejects.toBeInstanceOf(RateLimited);

    fetchMock.mockResolvedValueOnce(error(404, 'notFound'));
    await expect(google.syncEvents('t', cal, 'x')).rejects.toBeInstanceOf(CalendarNotFound);

    fetchMock.mockResolvedValueOnce(error(403, 'forbidden'));
    await expect(google.syncEvents('t', cal, 'x')).rejects.toThrow(/403/);
  });
});

describe('sign-in', () => {
  it('asks for offline, read-only access with consent', () => {
    const url = new URL(
      google.authUrl({ state: 's', redirectUri: 'http://localhost/cb', features: ['read'] }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    expect(url.searchParams.get('state')).toBe('s');
  });

  it('reads the account from the id token on code exchange', async () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: '123', email: 'me@gmail.com' })).toString('base64url')}.y`;
    fetchMock.mockResolvedValueOnce(
      json({ access_token: 'a', refresh_token: 'r', id_token: idToken, scope: 'openid email' }),
    );
    const account = await google.exchangeCode({ code: 'c', redirectUri: 'http://localhost/cb' });
    expect(account).toEqual({
      providerAccountId: '123',
      email: 'me@gmail.com',
      scopes: ['openid', 'email'],
      credentials: { refreshToken: 'r' },
    });
  });

  it('turns a revoked or expired login into NeedsReconnect', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(google.accessToken({ refreshToken: 'r' })).rejects.toBeInstanceOf(NeedsReconnect);
  });
});

describe('webhooks', () => {
  const parse = (headers: Record<string, string>) =>
    google.parseWebhook({ headers, query: {}, body: null });

  it('reads a change ping, ignores the initial sync ping, rejects junk', () => {
    expect(
      parse({
        'x-goog-channel-id': 'ch',
        'x-goog-channel-token': 'sec',
        'x-goog-resource-state': 'exists',
      }),
    ).toEqual({ kind: 'change', subscriptionId: 'ch', secret: 'sec' });
    expect(parse({ 'x-goog-channel-id': 'ch', 'x-goog-resource-state': 'sync' })).toEqual({
      kind: 'ignore',
    });
    expect(parse({})).toEqual({ kind: 'invalid' });
  });
});
