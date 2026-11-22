import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUser, type TestUser } from '../../../test/helpers';
import { db } from '../../db/client';
import {
  calendarAccounts,
  calendarCredentials,
  calendars,
  calendarSyncState,
  externalEvents,
} from '../../db/schema';
import { resetCalendarEnv } from '../env';
import { calendarPublicRoutes } from '../index';
import { overrideProvider, resetProviders } from '../registry';
import { FakeProvider } from '../testing/fake-provider';
import { connectAccount, disconnectAccount } from './accounts';
import { syncCalendarList } from './calendar-list';
import { drainCalendarJobs, setCalendarJobHandler, type CalendarJob } from './jobs';
import { renewSubscriptions } from './subscriptions';
import { calendarSelectionChanged, syncCalendar } from './sync';

// The provider-neutral engine against the fake provider and the local database: connecting,
// calendar lists, full and incremental sync, switching calendars off, revoked logins, and the
// connect routes end to end.

let user: TestUser;
let fake: FakeProvider;

beforeEach(async () => {
  user = await createUser();
  fake = new FakeProvider('google');
  fake.addCalendar({ id: 'me@gmail.com', name: 'Personal', isPrimary: true });
  fake.addCalendar({ id: 'team', name: 'Team', accessRole: 'reader' });
  fake.change('me@gmail.com', {
    id: 'standup',
    title: 'Standup',
    startAt: '2026-11-19T15:00:00.000Z',
    endAt: '2026-11-19T15:15:00.000Z',
  });
  fake.change('me@gmail.com', { id: 'trip', allDayStart: '2026-11-20', allDayEnd: '2026-11-23' });
  fake.change('team', { id: 'offsite', allDayStart: '2026-12-01', allDayEnd: '2026-12-02' });
  overrideProvider('google', fake);
});

afterEach(() => resetProviders());

async function connect() {
  const accountId = await connectAccount(user.id, 'google', {
    providerAccountId: `sub-${user.id}`,
    email: 'me@gmail.com',
    scopes: ['openid', 'email', 'calendar.readonly'],
    credentials: { refreshToken: 'r' },
  });
  await syncCalendarList(accountId);
  await drainCalendarJobs();
  return accountId;
}

const calendarRows = (accountId: string) =>
  db.select().from(calendars).where(eq(calendars.account_id, accountId));
const calendarId = async (accountId: string, providerId: string) =>
  (await calendarRows(accountId)).find((c) => c.provider_calendar_id === providerId)!.id;
const events = (calId: string) =>
  db.select().from(externalEvents).where(eq(externalEvents.calendar_id, calId));
const titles = async (calId: string) => (await events(calId)).map((e) => e.title).sort();

describe('connecting', () => {
  it('imports the calendars, switches the primary on and syncs it', async () => {
    const accountId = await connect();
    const cals = await calendarRows(accountId);
    expect(cals.map((c) => [c.name, c.is_selected, c.access_role]).sort()).toEqual([
      ['Personal', true, 'owner'],
      ['Team', false, 'reader'],
    ]);
    const personal = await calendarId(accountId, 'me@gmail.com');
    expect(await titles(personal)).toEqual(['', 'Standup']);
    const team = await calendarId(accountId, 'team');
    expect(await events(team)).toEqual([]);

    const [standup] = (await events(personal)).filter((e) => e.title === 'Standup');
    expect(standup).toMatchObject({
      user_id: user.id,
      account_id: accountId,
      provider: 'google',
      start_at: '2026-11-19 15:00:00+00',
      version: expect.any(String),
    });
  });

  it('stores the login encrypted', async () => {
    const accountId = await connect();
    const [row] = await db
      .select()
      .from(calendarCredentials)
      .where(eq(calendarCredentials.account_id, accountId));
    expect(row!.ciphertext.startsWith('v1.')).toBe(true);
    expect(row!.ciphertext).not.toContain('"r"');
  });

  it('reconnecting the same account reuses it and makes it active again', async () => {
    const first = await connect();
    await db
      .update(calendarAccounts)
      .set({ status: 'needs_reconnect' })
      .where(eq(calendarAccounts.id, first));
    const again = await connect();
    expect(again).toBe(first);
    const [row] = await db.select().from(calendarAccounts).where(eq(calendarAccounts.id, first));
    expect(row!.status).toBe('active');
    expect(await calendarRows(first)).toHaveLength(2); // not duplicated
  });
});

describe('syncing', () => {
  it('applies changes and deletions since the cursor', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    fake.change('me@gmail.com', { id: 'standup', title: 'Standup (moved)' });
    fake.change('me@gmail.com', {
      id: 'new',
      title: 'Lunch',
      allDayStart: '2026-11-19',
      allDayEnd: '2026-11-20',
    });
    fake.remove('me@gmail.com', 'trip');
    fake.calls = [];

    await syncCalendar(personal);
    expect(await titles(personal)).toEqual(['Lunch', 'Standup (moved)']);
    expect(
      fake.calls.some((c) => c.startsWith('syncEvents:me@gmail.com:') && !c.endsWith(':null')),
    ).toBe(true);
  });

  it("doesn't rewrite events that didn't change", async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    const before = await events(personal);
    await syncCalendar(personal, { full: true });
    const after = await events(personal);
    expect(after.map((e) => e.updated_at).sort()).toEqual(before.map((e) => e.updated_at).sort());
  });

  it('starts over with a full sync when the cursor expired, dropping what is gone', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    await db.insert(externalEvents).values({
      user_id: user.id,
      account_id: accountId,
      calendar_id: personal,
      provider: 'google',
      external_id: 'ghost',
      title: 'Deleted while we were away',
    });
    await db
      .update(calendarSyncState)
      .set({ cursor: '999' })
      .where(eq(calendarSyncState.calendar_id, personal));

    await syncCalendar(personal);
    expect(await titles(personal)).toEqual(['', 'Standup']);
    const [state] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.calendar_id, personal));
    expect(state!.cursor).not.toBe('999');
    expect(state!.last_error).toBeNull();
  });

  it('switching a calendar on syncs it; switching it off clears it', async () => {
    const accountId = await connect();
    const team = await calendarId(accountId, 'team');

    await db.update(calendars).set({ is_selected: true }).where(eq(calendars.id, team));
    await calendarSelectionChanged(team);
    expect((await events(team)).map((e) => e.external_id)).toEqual(['offsite']);

    await db.update(calendars).set({ is_selected: false }).where(eq(calendars.id, team));
    await calendarSelectionChanged(team);
    expect(await events(team)).toEqual([]);
    const [state] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.calendar_id, team));
    expect(state!.cursor).toBeNull();

    // A sync of a switched-off calendar does nothing.
    fake.calls = [];
    await syncCalendar(team);
    expect(fake.calls).toEqual([]);
  });

  it('marks the account for reconnecting when the login is revoked', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    fake.revoked = true;
    await syncCalendar(personal);
    const [row] = await db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.id, accountId));
    expect(row!.status).toBe('needs_reconnect');
    // And stops calling the provider until reconnected.
    fake.calls = [];
    await syncCalendar(personal);
    expect(fake.calls).toEqual([]);
  });

  it('removes calendars that disappeared at the provider, with their events', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    fake.calendars = fake.calendars.filter((c) => c.id !== 'me@gmail.com');
    await syncCalendarList(accountId);
    expect((await calendarRows(accountId)).map((c) => c.name)).toEqual(['Team']);
    expect(await events(personal)).toEqual([]);
  });

  it('refreshes names and colours without touching selection', async () => {
    const accountId = await connect();
    fake.calendars[0] = { ...fake.calendars[0]!, name: 'Me', color: '#000000' };
    await syncCalendarList(accountId);
    const [row] = await db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.account_id, accountId),
          eq(calendars.provider_calendar_id, 'me@gmail.com'),
        ),
      );
    expect(row).toMatchObject({ name: 'Me', color: '#000000', is_selected: true });
  });
});

describe('disconnecting', () => {
  it('revokes the login and deletes everything for the account', async () => {
    const accountId = await connect();
    await disconnectAccount(accountId);
    expect(fake.calls).toContain('revoke');
    expect(
      await db.select().from(calendarAccounts).where(eq(calendarAccounts.id, accountId)),
    ).toEqual([]);
    expect(await calendarRows(accountId)).toEqual([]);
    expect(
      await db.select().from(externalEvents).where(eq(externalEvents.account_id, accountId)),
    ).toEqual([]);
  });
});

describe('connect routes', () => {
  const app = new Hono().route('/', calendarPublicRoutes);
  const auth = () => ({
    Authorization: `Bearer ${user.token}`,
    'Content-Type': 'application/json',
  });

  async function start(returnScheme = 'planner-local') {
    const res = await app.request('/integrations/google/start', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ returnScheme }),
    });
    return { status: res.status, body: (await res.json()) as { url?: string } };
  }

  it('needs a signed-in user', async () => {
    const res = await app.request('/integrations/google/start', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('runs the whole flow: start → consent → callback → back to the app', async () => {
    const started = await start();
    expect(started.status).toBe(200);
    const consent = new URL(started.body.url!);
    const state = consent.searchParams.get('state')!;
    expect(consent.searchParams.get('redirect_uri')).toMatch(/\/integrations\/google\/callback$/);

    const res = await app.request(
      `/integrations/google/callback?code=${user.id}&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('planner-local://integrations/done?provider=google');
    await drainCalendarJobs();

    const [account] = await db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.user_id, user.id));
    expect(account).toMatchObject({ provider: 'google', status: 'active' });
    expect(await calendarRows(account!.id)).toHaveLength(2);
  });

  it('sends the user back with an error when they decline', async () => {
    const { body } = await start('planner');
    const state = new URL(body.url!).searchParams.get('state')!;
    const res = await app.request(
      `/integrations/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get('location')).toBe(
      'planner://integrations/error?provider=google&reason=access_denied',
    );
  });

  it('returns the web app to its own page, and only to allowed origins', async () => {
    const page = 'http://localhost:5173/settings/calendars';
    const started = await app.request('/integrations/google/start', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ returnUrl: page }),
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;

    const declined = await app.request(
      `/integrations/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(declined.headers.get('location')).toBe(
      `${page}?calendar_connect=error&provider=google&reason=access_denied`,
    );
    const done = await app.request(
      `/integrations/google/callback?code=${user.id}&state=${encodeURIComponent(state)}`,
    );
    expect(done.headers.get('location')).toBe(`${page}?calendar_connect=done&provider=google`);
    await drainCalendarJobs();

    const evil = await app.request('/integrations/google/start', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ returnUrl: 'https://evil.example/steal' }),
    });
    expect(evil.status).toBe(400);
  });

  it('rejects a forged or mismatched state', async () => {
    expect((await app.request('/integrations/google/callback?code=x&state=forged')).status).toBe(
      400,
    );
    const { body } = await start();
    const state = new URL(body.url!).searchParams.get('state')!;
    const other = await app.request(
      `/integrations/microsoft/callback?code=x&state=${encodeURIComponent(state)}`,
    );
    expect(other.status).toBe(400);
  });

  it('only lets the owner disconnect an account', async () => {
    const accountId = await connect();
    const stranger = await createUser();
    const denied = await app.request(`/integrations/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${stranger.token}` },
    });
    expect(denied.status).toBe(404);

    const ok = await app.request(`/integrations/accounts/${accountId}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(ok.status).toBe(202);
    await drainCalendarJobs();
    expect(
      await db.select().from(calendarAccounts).where(eq(calendarAccounts.id, accountId)),
    ).toEqual([]);
  });
});

describe('live updates', () => {
  beforeEach(() => {
    process.env.CALENDAR_PUBLIC_URL = 'https://api.example';
    resetCalendarEnv();
  });
  afterEach(() => {
    delete process.env.CALENDAR_PUBLIC_URL;
    resetCalendarEnv();
  });

  const stateOf = async (calId: string) =>
    (await db.select().from(calendarSyncState).where(eq(calendarSyncState.calendar_id, calId)))[0]!;

  it('subscribes a calendar when it is switched on, pointing at our webhook', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    const state = await stateOf(personal);
    expect(state.subscription_id).toBeTruthy();
    const live = fake.subscriptions.get(state.subscription_id!);
    expect(live).toMatchObject({
      calendarId: 'me@gmail.com',
      callbackUrl: 'https://api.example/webhooks/google',
      secret: state.subscription_secret,
    });
    // Subscribed before the full sync, so nothing in between is missed.
    const order = fake.calls.filter(
      (c) => c.startsWith('subscribe:') || c.startsWith('syncEvents:'),
    );
    expect(order[0]).toBe('subscribe:me@gmail.com');
    // The calendar left off isn't watched.
    const team = await calendarId(accountId, 'team');
    expect([...fake.subscriptions.values()].map((s) => s.calendarId)).toEqual(['me@gmail.com']);
    expect(
      await db.select().from(calendarSyncState).where(eq(calendarSyncState.calendar_id, team)),
    ).toEqual([]);
  });

  it("a ping with the subscription's secret queues a sync of that calendar", async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    const state = await stateOf(personal);
    const seen: CalendarJob[] = [];
    const restore = setCalendarJobHandler('sync-calendar', async (job) => {
      seen.push(job);
    });
    const app = new Hono().route('/', calendarPublicRoutes);
    const res = await app.request('/webhooks/google', {
      method: 'POST',
      headers: {
        'x-fake-subscription': state.subscription_id!,
        'x-fake-secret': state.subscription_secret!,
      },
    });
    await drainCalendarJobs();
    restore();
    expect(res.status).toBe(202);
    expect(seen).toEqual([{ type: 'sync-calendar', calendarId: personal }]);
  });

  it('unsubscribes when switched off', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    const { subscription_id } = await stateOf(personal);
    await db.update(calendars).set({ is_selected: false }).where(eq(calendars.id, personal));
    await calendarSelectionChanged(personal);
    expect(fake.calls).toContain(`unsubscribe:${subscription_id}`);
    expect(fake.subscriptions.size).toBe(0);
    expect((await stateOf(personal)).subscription_id).toBeNull();
  });

  it('renews subscriptions close to expiring (new one first, then stops the old)', async () => {
    const accountId = await connect();
    const personal = await calendarId(accountId, 'me@gmail.com');
    const old = await stateOf(personal);

    await renewSubscriptions(); // a week left: nothing to do
    expect((await stateOf(personal)).subscription_id).toBe(old.subscription_id);

    await db
      .update(calendarSyncState)
      .set({ subscription_expires_at: new Date(Date.now() + 3600_000).toISOString() })
      .where(eq(calendarSyncState.calendar_id, personal));
    await renewSubscriptions();
    const renewed = await stateOf(personal);
    expect(renewed.subscription_id).not.toBe(old.subscription_id);
    expect(renewed.subscription_secret).not.toBe(old.subscription_secret);
    expect(fake.calls.indexOf('renew:me@gmail.com')).toBeLessThan(
      fake.calls.indexOf(`unsubscribe:${old.subscription_id}`),
    );
    expect([...fake.subscriptions.keys()]).toEqual([renewed.subscription_id]);
  });

  it('subscribes selected calendars that have none yet (e.g. connected before live updates)', async () => {
    delete process.env.CALENDAR_PUBLIC_URL;
    resetCalendarEnv();
    const accountId = await connect(); // no public URL: no subscription
    const personal = await calendarId(accountId, 'me@gmail.com');
    expect((await stateOf(personal)).subscription_id).toBeNull();

    process.env.CALENDAR_PUBLIC_URL = 'https://api.example';
    resetCalendarEnv();
    await renewSubscriptions();
    expect((await stateOf(personal)).subscription_id).toBeTruthy();
  });
});
