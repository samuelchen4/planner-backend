import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

// One image, a role per process (planner-app/notes/calendar-integrations.md, "Keeping it
// detachable"): `api` leaves the calendar module out, `sync` serves only it.
const post = (role: 'all' | 'api' | 'sync', path: string) =>
  createApp(role).request(path, { method: 'POST' });

describe('service roles', () => {
  it('`all` serves everything', async () => {
    expect((await post('all', '/sync/upload')).status).toBe(401); // there, needs a token
    expect((await post('all', '/webhooks/google')).status).toBe(400);
    expect((await post('all', '/jobs/calendar/poll')).status).toBe(403);
  });

  it('`api` serves uploads but not the calendar module', async () => {
    expect((await post('api', '/sync/upload')).status).toBe(401);
    expect((await post('api', '/webhooks/google')).status).toBe(404);
    expect((await post('api', '/jobs/calendar/poll')).status).toBe(404);
  });

  it('`sync` serves only the calendar module', async () => {
    expect((await post('sync', '/sync/upload')).status).toBe(404);
    expect((await post('sync', '/webhooks/google')).status).toBe(400);
    expect((await createApp('sync').request('/health')).status).toBe(200);
  });
});
