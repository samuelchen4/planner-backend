import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createUser, newId, taskData, upload, type TestUser } from './helpers';

vi.mock('../src/db/as-user', () => ({
  asUser: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:54322'), {
      code: 'ECONNREFUSED',
    });
  },
}));

let alice: TestUser;

beforeAll(async () => {
  alice = await createUser();
});

describe('retryable failures', () => {
  it('return 503 so the app retries the batch', async () => {
    const res = await upload(alice, [{ op: 'PUT', type: 'tasks', id: newId(), data: taskData() }]);
    expect(res.status).toBe(503);
  });
});
