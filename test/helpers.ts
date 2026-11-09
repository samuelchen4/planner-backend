import { randomUUID } from 'node:crypto';

import { app } from '../src/app';
import type { Change } from '../src/routes/sync';

const api = () => process.env.SUPABASE_URL as string;
const anonKey = () => process.env.TEST_ANON_KEY as string;
const serviceKey = () => process.env.TEST_SERVICE_ROLE_KEY as string;

export interface TestUser {
  id: string;
  token: string;
}

/** A new confirmed user in the local Supabase Auth, signed in (a real access token). */
export async function createUser(): Promise<TestUser> {
  const email = `test-${randomUUID()}@example.com`;
  const password = 'password-123456';
  const created = await fetch(`${api()}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey(),
      Authorization: `Bearer ${serviceKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`Creating user failed: ${await created.text()}`);
  const signedIn = await fetch(`${api()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = (await signedIn.json()) as { access_token: string; user: { id: string } };
  return { id: session.user.id, token: session.access_token };
}

/** POST /sync/upload as `user` (or with no token). */
export async function upload(user: TestUser | null, batch: Change[]) {
  const res = await app.request('/sync/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(user && { Authorization: `Bearer ${user.token}` }),
    },
    body: JSON.stringify({ batch }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A full task row as the app would send it in a PUT (no id / user_id: those are separate). */
export function taskData(fields: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    type: 'task',
    title: 'A task',
    notes: null,
    start_at: null,
    end_at: null,
    time_zone: null,
    all_day_date: '2026-11-09',
    rrule: null,
    status: 'open',
    completed_at: null,
    list_id: null,
    color: null,
    icon: null,
    position: 1,
    created_at: now,
    updated_at: now,
    ...fields,
  };
}

/** Query the local Supabase's REST API (PostgREST) as `user`: RLS decides what they see. */
export function rest(user: TestUser, path: string, init: RequestInit = {}) {
  return fetch(`${api()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anonKey(),
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

export const newId = () => randomUUID();
