import { beforeAll, describe, expect, it } from 'vitest';

import { createUser, newId, rest, taskData, upload, type TestUser } from './helpers';

// Row Level Security, checked straight against Postgres (through PostgREST with each user's own
// token), independent of the API's checks: user A can't see or change user B's rows.

let alice: TestUser;
let bob: TestUser;
let bobsTask: string;

beforeAll(async () => {
  [alice, bob] = await Promise.all([createUser(), createUser()]);
  bobsTask = newId();
  const res = await upload(bob, [
    { op: 'PUT', type: 'tasks', id: bobsTask, data: taskData({ title: "Bob's" }) },
  ]);
  expect(res.body.rejected).toEqual([]);
});

const bobsTitle = async () => {
  const res = await rest(bob, `tasks?id=eq.${bobsTask}&select=title`);
  return ((await res.json()) as { title: string }[])[0]?.title;
};

describe('RLS', () => {
  it('lets the owner read their row', async () => {
    expect(await bobsTitle()).toBe("Bob's");
  });

  it("hides other users' rows", async () => {
    const res = await rest(alice, `tasks?id=eq.${bobsTask}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("doesn't let another user change or delete them", async () => {
    await rest(alice, `tasks?id=eq.${bobsTask}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Changed' }),
    });
    await rest(alice, `tasks?id=eq.${bobsTask}`, { method: 'DELETE' });
    expect(await bobsTitle()).toBe("Bob's");
  });

  it("doesn't let a user insert a row owned by someone else", async () => {
    const res = await rest(alice, 'tasks', {
      method: 'POST',
      body: JSON.stringify({ id: newId(), user_id: bob.id, title: 'Planted' }),
    });
    expect(res.status).toBe(403);
  });

  it('keeps external_events read-only for users', async () => {
    const res = await rest(alice, 'external_events', {
      method: 'POST',
      body: JSON.stringify({
        user_id: alice.id,
        provider: 'google',
        calendar_id: 'primary',
        external_id: newId(),
      }),
    });
    expect(res.status).toBe(403);
  });
});
