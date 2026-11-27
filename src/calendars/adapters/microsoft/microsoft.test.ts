import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCalendarEnv } from '../../env';
import { CursorExpired, NeedsReconnect, RateLimited } from '../../provider';
import type { GraphEvent } from './api';
import { microsoft } from './index';
import { toProviderCalendar, toProviderEvent } from './mapping';
import { toIanaZone } from './time-zones';

// The Microsoft Graph adapter against Graph-shaped payloads (shapes from the step 8.1 spike) and
// a faked fetch: no network, no secrets.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.MICROSOFT_CLIENT_ID = 'test-client';
  process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
  resetCalendarEnv();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  resetCalendarEnv();
});

const call = (i = 0) => fetchMock.mock.calls[i] as [string, RequestInit];
const sentJson = (i = 0) => JSON.parse(String(call(i)[1].body)) as Record<string, unknown>;
const sentForm = (i = 0) => new URLSearchParams(String(call(i)[1].body));
const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('time zones', () => {
  it('maps Windows names to IANA, keeps IANA names, and gives null for unknown ones', () => {
    expect(toIanaZone('Mountain Standard Time')).toBe('America/Denver');
    expect(toIanaZone('Eastern Standard Time')).toBe('America/New_York');
    expect(toIanaZone('America/Edmonton')).toBe('America/Edmonton');
    expect(toIanaZone('Somewhere Standard Time')).toBeNull();
    expect(toIanaZone(undefined)).toBeNull();
  });
});

describe('mapping', () => {
  const base: GraphEvent = {
    id: 'AAMk1',
    '@odata.etag': 'W/"abc"',
    subject: 'Review',
    type: 'singleInstance',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    start: { dateTime: '2026-11-24T07:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-24T08:00:00.0000000', timeZone: 'UTC' },
    originalStartTimeZone: 'Mountain Standard Time',
    webLink: 'https://outlook.live.com/owa/?itemid=x',
    lastModifiedDateTime: '2026-11-24T06:14:40Z',
  };

  it('maps a timed event (UTC times, IANA zone, etag)', () => {
    expect(toProviderEvent(base)).toMatchObject({
      id: 'AAMk1',
      title: 'Review',
      startAt: '2026-11-24T07:00:00.000Z',
      endAt: '2026-11-24T08:00:00.000Z',
      timeZone: 'America/Denver',
      allDayStart: null,
      status: 'confirmed',
      version: 'W/"abc"',
      webLink: 'https://outlook.live.com/owa/?itemid=x',
    });
  });

  it('maps an all-day event kept at midnight', () => {
    const e = toProviderEvent({
      ...base,
      isAllDay: true,
      start: { dateTime: '2026-11-25T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' },
    });
    expect(e).toMatchObject({
      allDayStart: '2026-11-25',
      allDayEnd: '2026-11-27',
      startAt: null,
      timeZone: null,
    });
  });

  it('maps an all-day event shifted into UTC back to its own days', () => {
    // Midnight in Mountain time (UTC-7 in November) shown as 07:00 UTC.
    const e = toProviderEvent({
      ...base,
      isAllDay: true,
      start: { dateTime: '2026-11-25T07:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-26T07:00:00.0000000', timeZone: 'UTC' },
    });
    expect(e).toMatchObject({ allDayStart: '2026-11-25', allDayEnd: '2026-11-26' });
  });

  it('keeps which series and occurrence a repeating instance is', () => {
    const e = toProviderEvent({
      ...base,
      type: 'occurrence',
      seriesMasterId: 'AAMkMaster',
      originalStart: '2026-11-24T07:00:00Z',
    });
    expect(e).toMatchObject({
      seriesId: 'AAMkMaster',
      originalStartAt: '2026-11-24T07:00:00.000Z',
    });
  });

  it('drops removed, cancelled and series-master items; marks tentative ones', () => {
    expect(toProviderEvent({ id: 'gone', '@removed': { reason: 'deleted' } })).toBeNull();
    expect(toProviderEvent({ ...base, isCancelled: true })).toBeNull();
    expect(toProviderEvent({ ...base, type: 'seriesMaster' })).toBeNull();
    expect(toProviderEvent({ ...base, showAs: 'tentative' })?.status).toBe('tentative');
  });

  it('uses the plain-text body for notes', () => {
    const e = toProviderEvent({
      ...base,
      body: { contentType: 'text', content: '  Bring notes ' },
    });
    expect(e?.description).toBe('Bring notes');
  });

  it('maps calendars, with named or no colours', () => {
    expect(
      toProviderCalendar({
        id: 'c1',
        name: 'Calendar',
        color: 'auto',
        hexColor: '',
        isDefaultCalendar: true,
        canEdit: true,
      }),
    ).toEqual({ id: 'c1', name: 'Calendar', color: null, isPrimary: true, accessRole: 'owner' });
    expect(toProviderCalendar({ id: 'c2', color: 'lightGreen', canEdit: false })).toMatchObject({
      color: '#5CB85C',
      accessRole: 'reader',
    });
    expect(toProviderCalendar({ id: 'c3', hexColor: '#123456', canEdit: true }).color).toBe(
      '#123456',
    );
  });
});

describe('syncEvents', () => {
  const cal = { providerCalendarId: 'cal/1', windowStart: null, windowEnd: null };
  const timed = (id: string) => ({
    id,
    '@odata.etag': `W/"${id}"`,
    type: 'singleInstance',
    start: { dateTime: '2026-11-24T07:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-24T08:00:00.0000000', timeZone: 'UTC' },
  });

  it('does a windowed full sync across pages, ending at the delta link', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ value: [timed('a')], '@odata.nextLink': 'https://graph.microsoft.com/next' }),
      )
      .mockResolvedValueOnce(
        json({
          value: [timed('b'), { id: 'c', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?$deltatoken=t1',
        }),
      );
    const result = await microsoft.syncEvents('token', cal, null);
    expect(result.upserts.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.deletes).toEqual(['c']);
    expect(result.cursor).toBe('https://graph.microsoft.com/delta?$deltatoken=t1');
    expect(result.window?.end).toBeTruthy();
    const days = (Date.parse(result.window!.end!) - Date.parse(result.window!.start)) / 86_400_000;
    expect(Math.round(days)).toBe(395);

    const [firstUrl, init] = call(0);
    const url = new URL(firstUrl);
    expect(url.pathname).toBe('/v1.0/me/calendars/cal%2F1/calendarView/delta');
    expect(url.searchParams.get('startDateTime')).toBe(result.window!.start);
    expect((init.headers as Record<string, string>).Prefer).toContain('outlook.timezone="UTC"');
    expect(call(1)[0]).toBe('https://graph.microsoft.com/next');
  });

  it('resumes from the delta link on an incremental sync', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?$deltatoken=t2' }),
    );
    const result = await microsoft.syncEvents('t', cal, 'https://graph.microsoft.com/delta?t1');
    expect(call(0)[0]).toBe('https://graph.microsoft.com/delta?t1');
    expect(result.cursor).toContain('t2');
    expect(result.window).toBeUndefined();
  });

  it("maps Graph's errors to the contract's", async () => {
    const error = (status: number, code: string, headers?: Record<string, string>) =>
      json({ error: { code, message: 'x' } }, status, headers);

    fetchMock.mockResolvedValueOnce(error(400, 'BadRequest')); // "Badly formed token" (spike)
    await expect(microsoft.syncEvents('t', cal, 'https://g/delta')).rejects.toBeInstanceOf(
      CursorExpired,
    );
    fetchMock.mockResolvedValueOnce(error(410, 'SyncStateNotFound'));
    await expect(microsoft.syncEvents('t', cal, 'https://g/delta')).rejects.toBeInstanceOf(
      CursorExpired,
    );
    fetchMock.mockResolvedValueOnce(error(429, 'TooManyRequests', { 'retry-after': '7' }));
    await expect(microsoft.syncEvents('t', cal, 'https://g/delta')).rejects.toMatchObject({
      retryAfterSeconds: 7,
    });
    // A 400 on a full sync is a real error, not an expired cursor.
    fetchMock.mockResolvedValueOnce(error(400, 'ErrorInvalidParameter'));
    await expect(microsoft.syncEvents('t', cal, null)).rejects.toThrow(/400/);
    fetchMock.mockResolvedValueOnce(error(503, 'ServiceUnavailable'));
    await expect(microsoft.syncEvents('t', cal, null)).rejects.toBeInstanceOf(RateLimited);
  });
});

describe('sign-in', () => {
  it('asks for read access with a refresh token, letting people pick the account', () => {
    const url = new URL(
      microsoft.authUrl({ state: 's', redirectUri: 'http://localhost/cb', features: ['read'] }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'offline_access',
      'User.Read',
      'Calendars.Read',
    ]);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).toBe('s');
  });

  it('identifies a personal account by tenant + sub, with its email', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'a',
        refresh_token: 'r',
        scope: 'openid email User.Read Calendars.Read',
        id_token: idToken({
          sub: 'pairwise-sub',
          tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
          email: 'me@outlook.com',
        }),
      }),
    );
    const account = await microsoft.exchangeCode({ code: 'c', redirectUri: 'http://cb' });
    expect(account).toMatchObject({
      providerAccountId: '9188040d-6c67-4c5b-b112-36a304b66dad:pairwise-sub',
      email: 'me@outlook.com',
      credentials: { refreshToken: 'r' },
    });
    expect(sentForm().get('grant_type')).toBe('authorization_code');
  });

  it('prefers the object id for work accounts', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'a',
        refresh_token: 'r',
        id_token: idToken({
          sub: 's',
          oid: 'object-id',
          tid: 'tenant',
          preferred_username: 'u@co.com',
        }),
      }),
    );
    const account = await microsoft.exchangeCode({ code: 'c', redirectUri: 'http://cb' });
    expect(account).toMatchObject({ providerAccountId: 'tenant:object-id', email: 'u@co.com' });
  });

  it('returns the rotated refresh token so it gets saved', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'a2', refresh_token: 'r2' }));
    const result = await microsoft.accessToken({ refreshToken: 'r1', scope: 'x' });
    expect(result).toEqual({ token: 'a2', credentials: { refreshToken: 'r2', scope: 'x' } });

    fetchMock.mockResolvedValueOnce(json({ access_token: 'a3', refresh_token: 'r2' }));
    expect(await microsoft.accessToken({ refreshToken: 'r2', scope: 'x' })).toEqual({
      token: 'a3',
    });
  });

  it('turns a revoked or expired login into NeedsReconnect', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(microsoft.accessToken({ refreshToken: 'r' })).rejects.toBeInstanceOf(
      NeedsReconnect,
    );
    fetchMock.mockResolvedValueOnce(json({ error: 'interaction_required' }, 400));
    await expect(microsoft.accessToken({ refreshToken: 'r' })).rejects.toBeInstanceOf(
      NeedsReconnect,
    );
  });
});

describe('live updates', () => {
  const cal = { providerCalendarId: 'cal1', windowStart: null, windowEnd: null };
  const input = { callbackUrl: 'https://api.example/webhooks/microsoft', secret: 'sec' };

  it('subscribes to the calendar’s events with our secret', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: 'sub-1', expirationDateTime: '2026-11-27T00:00:00Z' }, 201),
    );
    const sub = await microsoft.subscribe('t', cal, input);
    expect(call(0)[0]).toBe('https://graph.microsoft.com/v1.0/subscriptions');
    expect(sentJson()).toMatchObject({
      changeType: 'created,updated,deleted',
      notificationUrl: 'https://api.example/webhooks/microsoft',
      resource: '/me/calendars/cal1/events',
      clientState: 'sec',
    });
    expect(sub).toEqual({
      id: 'sub-1',
      resourceId: null,
      secret: 'sec',
      expiresAt: '2026-11-27T00:00:00.000Z',
    });
  });

  it('renews in place, keeping the id and secret; recreates one Graph dropped', async () => {
    const old = { id: 'sub-1', resourceId: null, secret: 'old', expiresAt: '2026-11-25T00:00:00Z' };
    fetchMock.mockResolvedValueOnce(
      json({ id: 'sub-1', expirationDateTime: '2026-11-28T00:00:00Z' }),
    );
    const renewed = await microsoft.renew('t', cal, old, input);
    expect(call(0)[1].method).toBe('PATCH');
    expect(renewed).toMatchObject({
      id: 'sub-1',
      secret: 'old',
      expiresAt: '2026-11-28T00:00:00.000Z',
    });

    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 'ResourceNotFound' } }, 404))
      .mockResolvedValueOnce(
        json({ id: 'sub-2', expirationDateTime: '2026-11-28T00:00:00Z' }, 201),
      );
    const recreated = await microsoft.renew('t', cal, old, input);
    expect(recreated).toMatchObject({ id: 'sub-2', secret: 'sec' });
  });

  it('deletes a subscription, treating an already-gone one as deleted', async () => {
    const sub = { id: 'sub-1', resourceId: null, secret: 's', expiresAt: '2026-11-25T00:00:00Z' };
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await microsoft.unsubscribe('t', sub);
    expect(call(0)).toMatchObject([
      'https://graph.microsoft.com/v1.0/subscriptions/sub-1',
      { method: 'DELETE' },
    ]);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'ResourceNotFound' } }, 404));
    await expect(microsoft.unsubscribe('t', sub)).resolves.toBeUndefined();
  });

  it('answers the validation handshake and reads batched notifications', () => {
    const parse = (query: Record<string, string>, body: unknown) =>
      microsoft.parseWebhook({ headers: {}, query, body });
    expect(parse({ validationToken: 'Validation: token 123' }, null)).toEqual({
      kind: 'handshake',
      body: 'Validation: token 123',
    });
    expect(
      parse(
        {},
        {
          value: [
            { subscriptionId: 's1', clientState: 'a', changeType: 'updated' },
            { subscriptionId: 's2', clientState: 'b', changeType: 'created' },
          ],
        },
      ),
    ).toEqual({
      kind: 'change',
      changes: [
        { subscriptionId: 's1', secret: 'a' },
        { subscriptionId: 's2', secret: 'b' },
      ],
    });
    expect(parse({}, null)).toEqual({ kind: 'invalid' });
    expect(parse({}, { value: [] })).toEqual({ kind: 'invalid' });
  });
});
