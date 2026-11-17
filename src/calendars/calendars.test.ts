import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createUser, rest, upload, type TestUser } from '../../test/helpers';
import { db } from '../db/client';
import {
  calendarAccounts,
  calendarCredentials,
  calendars,
  calendarSyncState,
  externalEvents,
} from '../db/schema';
import { calendarJobRoutes, calendarPublicRoutes } from '.';
import { drainCalendarJobs, setCalendarJobHandler, type CalendarJob } from './engine/jobs';
import { resetCalendarEnv } from './env';
import { overrideProvider, resetProviders } from './registry';
import { CursorExpired, FakeProvider } from './testing/fake-provider';

// Step 2 of the calendar plan: tables, access rules, the upload allow-list, and the module's
// boundary (routes per SERVICE_ROLE, webhooks queue jobs, jobs route locked down).

let alice: TestUser;
let bob: TestUser;

/** The module's routes, mounted as the API (or a future sync service) mounts them. */
const moduleApp = () =>
  new Hono().route('/', calendarPublicRoutes).route('/jobs/calendar', calendarJobRoutes);

function one<T>(rows: T[]): T {
  if (!rows[0]) throw new Error('Expected a row');
  return rows[0];
}

/** An account with one calendar, one event and sync state, written as the backend would. */
async function seedCalendar(user: TestUser) {
  const account = one(
    await db
      .insert(calendarAccounts)
      .values({
        user_id: user.id,
        provider: 'google',
        provider_account_id: randomUUID(),
        email: 'someone@example.com',
        scopes: ['calendar.readonly'],
      })
      .returning(),
  );
  await db.insert(calendarCredentials).values({ account_id: account.id, ciphertext: 'secret' });
  const calendar = one(
    await db
      .insert(calendars)
      .values({
        user_id: user.id,
        account_id: account.id,
        provider_calendar_id: 'primary',
        name: 'Personal',
        is_primary: true,
      })
      .returning(),
  );
  const subscriptionId = randomUUID();
  await db.insert(calendarSyncState).values({
    calendar_id: calendar.id,
    cursor: 'cursor-1',
    subscription_id: subscriptionId,
    subscription_secret: 'webhook-secret',
  });
  await db.insert(externalEvents).values({
    user_id: user.id,
    account_id: account.id,
    calendar_id: calendar.id,
    provider: 'google',
    external_id: 'evt-1',
    title: 'Design review',
    start_at: '2026-11-17T20:00:00Z',
    end_at: '2026-11-17T21:00:00Z',
  });
  return { account, calendar, subscriptionId };
}

/** Records queued jobs of `type` instead of running them. */
function captureJobs(type: CalendarJob['type']) {
  const seen: CalendarJob[] = [];
  const restore = setCalendarJobHandler(type, async (job) => {
    seen.push(job);
  });
  return { seen, restore };
}

let aliceCal: Awaited<ReturnType<typeof seedCalendar>>;

beforeAll(async () => {
  [alice, bob] = await Promise.all([createUser(), createUser()]);
  aliceCal = await seedCalendar(alice);
});

afterEach(() => {
  resetProviders();
});

const readAs = async (user: TestUser, path: string) => {
  const res = await rest(user, path);
  return { status: res.status, rows: (await res.json()) as Record<string, unknown>[] };
};

describe('access rules', () => {
  it('lets the owner read their accounts, calendars and events', async () => {
    expect((await readAs(alice, 'calendar_accounts?select=id,email')).rows).toHaveLength(1);
    expect((await readAs(alice, 'calendars?select=name')).rows).toEqual([{ name: 'Personal' }]);
    expect((await readAs(alice, 'external_events?select=title')).rows).toEqual([
      { title: 'Design review' },
    ]);
  });

  it("hides other users' calendar rows", async () => {
    expect((await readAs(bob, 'calendar_accounts')).rows).toEqual([]);
    expect((await readAs(bob, 'calendars')).rows).toEqual([]);
    expect((await readAs(bob, 'external_events')).rows).toEqual([]);
  });

  it('never exposes credentials, sync state or task links, even to the owner', async () => {
    for (const table of ['calendar_credentials', 'calendar_sync_state', 'task_calendar_links']) {
      const res = await readAs(alice, table);
      expect(res.status === 200 ? res.rows : []).toEqual([]);
    }
  });

  it('lets a client switch a calendar on, and nothing else', async () => {
    const id = aliceCal.calendar.id;
    const patch = (body: object) =>
      rest(alice, `calendars?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    expect((await patch({ name: 'Hacked' })).ok).toBe(false);
    expect((await patch({ is_selected: true })).ok).toBe(true);
    const row = one(await db.select().from(calendars).where(eq(calendars.id, id)));
    expect(row.name).toBe('Personal');
    expect(row.is_selected).toBe(true);
    await db.update(calendars).set({ is_selected: false }).where(eq(calendars.id, id));
  });

  it('removes calendars, events and secrets with their account', async () => {
    const seeded = await seedCalendar(bob);
    await db.delete(calendarAccounts).where(eq(calendarAccounts.id, seeded.account.id));
    const left = await Promise.all([
      db.select().from(calendars).where(eq(calendars.account_id, seeded.account.id)),
      db.select().from(externalEvents).where(eq(externalEvents.account_id, seeded.account.id)),
      db
        .select()
        .from(calendarCredentials)
        .where(eq(calendarCredentials.account_id, seeded.account.id)),
      db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendar_id, seeded.calendar.id)),
    ]);
    expect(left.flat()).toEqual([]);
  });
});

describe('upload: calendars', () => {
  it('switches a calendar on and queues a selection job', async () => {
    const jobs = captureJobs('calendar-selection-changed');
    const id = aliceCal.calendar.id;
    const res = await upload(alice, [
      { op: 'PATCH', type: 'calendars', id, data: { is_selected: true } },
    ]);
    await drainCalendarJobs();
    jobs.restore();
    expect(res.body.rejected).toEqual([]);
    expect(jobs.seen).toEqual([{ type: 'calendar-selection-changed', calendarId: id }]);
    const row = one(await db.select().from(calendars).where(eq(calendars.id, id)));
    expect(row.is_selected).toBe(true);
  });

  it('rejects other columns, creating and deleting', async () => {
    const id = aliceCal.calendar.id;
    const res = await upload(alice, [
      { op: 'PATCH', type: 'calendars', id, data: { name: 'Renamed' } },
      { op: 'PUT', type: 'calendars', id: randomUUID(), data: { is_selected: true } },
      { op: 'DELETE', type: 'calendars', id },
    ]);
    expect((res.body.rejected as unknown[]).length).toBe(3);
    const row = one(await db.select().from(calendars).where(eq(calendars.id, id)));
    expect(row.name).toBe('Personal');
  });

  it("doesn't touch (or queue anything for) another user's calendar", async () => {
    const jobs = captureJobs('calendar-selection-changed');
    const id = aliceCal.calendar.id;
    await db.update(calendars).set({ is_selected: false }).where(eq(calendars.id, id));
    await upload(bob, [{ op: 'PATCH', type: 'calendars', id, data: { is_selected: true } }]);
    await drainCalendarJobs();
    jobs.restore();
    expect(jobs.seen).toEqual([]);
    const row = one(await db.select().from(calendars).where(eq(calendars.id, id)));
    expect(row.is_selected).toBe(false);
  });

  it('keeps mirrored events read-only', async () => {
    const res = await upload(alice, [
      { op: 'PATCH', type: 'external_events', id: randomUUID(), data: { title: 'x' } },
    ]);
    expect((res.body.rejected as unknown[]).length).toBe(1);
  });
});

describe('webhooks', () => {
  const app = moduleApp();
  const ping = (headers: Record<string, string>, provider = 'google') =>
    app.request(`/webhooks/${provider}`, { method: 'POST', headers });

  it('queues a sync of the calendar when the secret matches', async () => {
    overrideProvider('google', new FakeProvider('google'));
    const jobs = captureJobs('sync-calendar');
    const res = await ping({
      'x-fake-subscription': aliceCal.subscriptionId,
      'x-fake-secret': 'webhook-secret',
    });
    await drainCalendarJobs();
    jobs.restore();
    expect(res.status).toBe(202);
    expect(jobs.seen).toEqual([{ type: 'sync-calendar', calendarId: aliceCal.calendar.id }]);
  });

  it('ignores a wrong secret or unknown subscription (quietly)', async () => {
    overrideProvider('google', new FakeProvider('google'));
    const jobs = captureJobs('sync-calendar');
    const wrong = await ping({
      'x-fake-subscription': aliceCal.subscriptionId,
      'x-fake-secret': 'nope',
    });
    const unknown = await ping({ 'x-fake-subscription': randomUUID(), 'x-fake-secret': 'x' });
    await drainCalendarJobs();
    jobs.restore();
    expect([wrong.status, unknown.status]).toEqual([200, 200]);
    expect(jobs.seen).toEqual([]);
  });

  it('rejects unknown providers and malformed pings', async () => {
    expect((await ping({}, 'yahoo')).status).toBe(404);
    expect((await ping({})).status).toBe(400); // the real Google adapter isn't built yet
  });
});

describe('jobs route', () => {
  it('refuses everything until an invoker is configured', async () => {
    resetCalendarEnv();
    const res = await moduleApp().request('/jobs/calendar/poll', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('refuses callers without a Google OIDC token', async () => {
    process.env.CALENDAR_JOBS_INVOKER = 'tasks@example.iam.gserviceaccount.com';
    process.env.CALENDAR_JOBS_URL = 'https://planner-api.example.com';
    resetCalendarEnv();
    try {
      const app = moduleApp();
      const none = await app.request('/jobs/calendar/poll', { method: 'POST' });
      const forged = await app.request('/jobs/calendar/poll', {
        method: 'POST',
        headers: { Authorization: 'Bearer not.a.jwt' },
      });
      expect([none.status, forged.status]).toEqual([401, 401]);
    } finally {
      delete process.env.CALENDAR_JOBS_INVOKER;
      delete process.env.CALENDAR_JOBS_URL;
      resetCalendarEnv();
    }
  });
});

describe('fake provider', () => {
  it('returns changes since a cursor, and expires bad cursors', async () => {
    const fake = new FakeProvider();
    fake.addCalendar({ id: 'cal', isPrimary: true });
    fake.change('cal', { id: 'a', title: 'A' });
    const full = await fake.syncEvents('t', { providerCalendarId: 'cal' }, null);
    expect(full.upserts.map((e) => e.id)).toEqual(['a']);

    fake.change('cal', { id: 'a', title: 'A moved' });
    fake.change('cal', { id: 'b', title: 'B' });
    fake.remove('cal', 'b');
    const next = await fake.syncEvents('t', { providerCalendarId: 'cal' }, full.cursor);
    expect(next.upserts.map((e) => e.title)).toEqual(['A moved']);
    expect(next.deletes).toEqual(['b']);

    await expect(fake.syncEvents('t', { providerCalendarId: 'cal' }, '999')).rejects.toThrow(
      CursorExpired,
    );
  });
});
