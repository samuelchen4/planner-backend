import { calendarEnv } from '../env';

// Cloud Tasks over its REST API (no client library): the service's own identity comes from the
// Cloud Run metadata server. Each task is a signed HTTPS call to CALENDAR_JOBS_URL/jobs/calendar/
// <type>, so Cloud Tasks retries failures and the engine can move to another service by changing
// only that URL.

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let cached: { token: string; expiresAt: number } | undefined;

async function serviceToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`Metadata server token failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

/** Tests: forget the cached token. */
export function resetCloudTasksToken() {
  cached = undefined;
}

export interface TaskOptions {
  /**
   * Coalesce: every call with the same key inside one window of this many seconds becomes a
   * single task, run when the window ends. Cloud Tasks refuses a second task with the same name.
   */
  coalesce?: { key: string; seconds: number };
}

/** Queue one job. Returns false when an identical coalesced task already exists. */
export async function createTask(
  type: string,
  payload: Record<string, unknown>,
  options: TaskOptions = {},
): Promise<boolean> {
  const env = calendarEnv();
  const queue = env.CALENDAR_TASKS_QUEUE;
  const base = env.CALENDAR_JOBS_URL;
  const invoker = env.CALENDAR_JOBS_INVOKER;
  if (!queue || !base || !invoker) {
    throw new Error(
      'Cloud Tasks needs CALENDAR_TASKS_QUEUE, CALENDAR_JOBS_URL and CALENDAR_JOBS_INVOKER',
    );
  }

  let name: string | undefined;
  let scheduleTime: string | undefined;
  if (options.coalesce) {
    const windowMs = options.coalesce.seconds * 1000;
    const slot = Math.floor(Date.now() / windowMs);
    // Task ids: letters, digits, hyphens, underscores. The key leads so names spread out.
    name = `${queue}/tasks/${options.coalesce.key.replace(/[^A-Za-z0-9_-]/g, '_')}-${slot}`;
    scheduleTime = new Date((slot + 1) * windowMs).toISOString();
  }

  const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await serviceToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      task: {
        ...(name && { name }),
        ...(scheduleTime && { scheduleTime }),
        httpRequest: {
          httpMethod: 'POST',
          url: `${base.replace(/\/$/, '')}/jobs/calendar/${type}`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(payload)).toString('base64'),
          // The jobs route checks this token: issued for the invoker, audience = the jobs URL.
          oidcToken: { serviceAccountEmail: invoker, audience: base },
        },
      },
    }),
  });
  if (res.ok) return true;
  if (res.status === 409) return false; // same coalesced task already queued
  const detail = await res.text().catch(() => '');
  throw new Error(`Cloud Tasks createTask failed (${res.status}): ${detail.slice(0, 300)}`);
}
