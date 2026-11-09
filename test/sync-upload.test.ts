import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/app';
import { db } from '../src/db/client';
import { habitDays, tasks } from '../src/db/schema';
import { createUser, newId, taskData, upload, type TestUser } from './helpers';

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

const getTask = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];

describe('GET /health', () => {
  it('is ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('auth', () => {
  it('requires a token', async () => {
    expect((await upload(null, [])).status).toBe(401);
  });

  it('rejects a bad token', async () => {
    const res = await upload({ id: alice.id, token: 'not-a-token' }, []);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body', async () => {
    const res = await app.request('/sync/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('tasks', () => {
  it('PUT creates a task owned by the signed-in user', async () => {
    const id = newId();
    const res = await upload(alice, [{ op: 'PUT', type: 'tasks', id, data: taskData() }]);
    expect(res).toEqual({ status: 200, body: { applied: 1, rejected: [] } });
    const row = await getTask(id);
    expect(row?.user_id).toBe(alice.id);
    expect(row?.title).toBe('A task');
  });

  it('PUT with an explicit user_id equal to the caller is fine', async () => {
    const id = newId();
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id, data: taskData({ user_id: alice.id }) },
    ]);
    expect(res.body.rejected).toEqual([]);
  });

  it('PATCH changes only the given columns', async () => {
    const id = newId();
    await upload(alice, [{ op: 'PUT', type: 'tasks', id, data: taskData() }]);
    const res = await upload(alice, [
      { op: 'PATCH', type: 'tasks', id, data: { title: 'Renamed', status: 'done' } },
    ]);
    expect(res.body.rejected).toEqual([]);
    const row = await getTask(id);
    expect(row?.title).toBe('Renamed');
    expect(row?.status).toBe('done');
    expect(row?.all_day_date).toBe('2026-11-09');
  });

  it('DELETE removes it, and a list takes its entries with it', async () => {
    const list = newId();
    const entry = newId();
    await upload(alice, [
      { op: 'PUT', type: 'tasks', id: list, data: taskData({ type: 'list', color: 'yellow' }) },
      { op: 'PUT', type: 'tasks', id: entry, data: taskData({ list_id: list }) },
    ]);
    expect(await getTask(entry)).toBeDefined();
    const res = await upload(alice, [{ op: 'DELETE', type: 'tasks', id: list }]);
    expect(res.body.rejected).toEqual([]);
    expect(await getTask(list)).toBeUndefined();
    expect(await getTask(entry)).toBeUndefined();
  });

  it('DELETE of a row that is already gone is fine', async () => {
    const res = await upload(alice, [{ op: 'DELETE', type: 'tasks', id: newId() }]);
    expect(res.body).toEqual({ applied: 1, rejected: [] });
  });
});

describe('rejections (acknowledged, not retried)', () => {
  it("rejects someone else's user_id", async () => {
    const id = newId();
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id, data: taskData({ user_id: bob.id }) },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toMatchObject([{ index: 0, id, reason: /user_id/ }]);
    expect(await getTask(id)).toBeUndefined();
  });

  it('rejects an unknown table, and tables only the server writes', async () => {
    const res = await upload(alice, [
      { op: 'PUT', type: 'secrets', id: newId(), data: {} },
      { op: 'PUT', type: 'external_events', id: newId(), data: {} },
    ]);
    expect(res.body.rejected).toMatchObject([{ index: 0 }, { index: 1 }]);
  });

  it('rejects an unknown column', async () => {
    const id = newId();
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id, data: taskData({ is_admin: true }) },
    ]);
    expect(res.body.rejected).toMatchObject([{ reason: /is_admin/ }]);
  });

  it('rejects values the model does not allow', async () => {
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id: newId(), data: taskData({ type: 'banana' }) },
      { op: 'PATCH', type: 'tasks', id: newId(), data: { color: 'green' } },
    ]);
    expect(res.body.rejected).toMatchObject([{ index: 0 }, { index: 1 }]);
  });

  it("can't take over someone else's task with PUT", async () => {
    const id = newId();
    await upload(bob, [{ op: 'PUT', type: 'tasks', id, data: taskData({ title: "Bob's" }) }]);
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id, data: taskData({ title: 'Stolen' }) },
    ]);
    expect(res.body.rejected).toMatchObject([{ id }]);
    const row = await getTask(id);
    expect(row?.user_id).toBe(bob.id);
    expect(row?.title).toBe("Bob's");
  });

  it("can't change or delete someone else's task (nothing happens)", async () => {
    const id = newId();
    await upload(bob, [{ op: 'PUT', type: 'tasks', id, data: taskData({ title: "Bob's" }) }]);
    await upload(alice, [
      { op: 'PATCH', type: 'tasks', id, data: { title: 'Changed' } },
      { op: 'DELETE', type: 'tasks', id },
    ]);
    expect((await getTask(id))?.title).toBe("Bob's");
  });

  it("can't point a task into someone else's list", async () => {
    const bobsList = newId();
    await upload(bob, [
      { op: 'PUT', type: 'tasks', id: bobsList, data: taskData({ type: 'list' }) },
    ]);
    const id = newId();
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id, data: taskData({ list_id: bobsList }) },
    ]);
    expect(res.body.rejected).toMatchObject([{ reason: /list_id/ }]);
  });

  it('keeps the good changes of a batch when one is rejected', async () => {
    const good = newId();
    const res = await upload(alice, [
      { op: 'PUT', type: 'tasks', id: newId(), data: taskData({ status: 'maybe' }) },
      { op: 'PUT', type: 'tasks', id: good, data: taskData({ title: 'Kept' }) },
    ]);
    expect(res.body).toMatchObject({ applied: 1, rejected: [{ index: 0 }] });
    expect((await getTask(good))?.title).toBe('Kept');
  });
});

describe('habit_days', () => {
  it('PUT, PATCH and DELETE a day of your own habit', async () => {
    const habit = newId();
    const dayId = `${habit}:2026-11-09`;
    await upload(alice, [
      {
        op: 'PUT',
        type: 'tasks',
        id: habit,
        data: taskData({ type: 'habit', all_day_date: null }),
      },
    ]);
    const put = await upload(alice, [
      {
        op: 'PUT',
        type: 'habit_days',
        id: dayId,
        data: {
          habit_id: habit,
          date: '2026-11-09',
          done_at: new Date().toISOString(),
          note: null,
          updated_at: new Date().toISOString(),
        },
      },
    ]);
    expect(put.body.rejected).toEqual([]);
    await upload(alice, [
      { op: 'PATCH', type: 'habit_days', id: dayId, data: { note: 'Felt good' } },
    ]);
    const [row] = await db.select().from(habitDays).where(eq(habitDays.id, dayId));
    expect(row).toMatchObject({ user_id: alice.id, note: 'Felt good' });

    await upload(alice, [{ op: 'DELETE', type: 'habit_days', id: dayId }]);
    expect(await db.select().from(habitDays).where(eq(habitDays.id, dayId))).toEqual([]);
  });

  it("rejects a day for someone else's habit", async () => {
    const bobsHabit = newId();
    await upload(bob, [
      { op: 'PUT', type: 'tasks', id: bobsHabit, data: taskData({ type: 'habit' }) },
    ]);
    const res = await upload(alice, [
      {
        op: 'PUT',
        type: 'habit_days',
        id: `${bobsHabit}:2026-11-09`,
        data: {
          habit_id: bobsHabit,
          date: '2026-11-09',
          done_at: null,
          note: 'x',
          updated_at: new Date().toISOString(),
        },
      },
    ]);
    expect(res.body.rejected).toMatchObject([{ reason: /habit_id/ }]);
  });
});
