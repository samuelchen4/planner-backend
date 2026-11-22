import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarEnv, resetCalendarEnv } from '../env';
import { resetCloudTasksToken } from './cloud-tasks';
import { enqueueCalendarJob, SYNC_COALESCE_SECONDS } from './jobs';

// The Cloud Tasks queue against a faked fetch (metadata server + Cloud Tasks API).

const QUEUE = 'projects/p/locations/us-east4/queues/planner-calendar-dev';
const CALENDAR = '7a4c23ff-efe6-4b20-9c18-678344c2d457';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(process.env, {
    CALENDAR_QUEUE: 'cloud-tasks',
    CALENDAR_TASKS_QUEUE: QUEUE,
    CALENDAR_JOBS_URL: 'https://api.example',
    CALENDAR_JOBS_INVOKER: 'jobs@p.iam.gserviceaccount.com',
  });
  resetCalendarEnv();
  resetCloudTasksToken();
  fetchMock = vi.fn(async (url: string) =>
    url.startsWith('http://metadata')
      ? new Response(JSON.stringify({ access_token: 'svc', expires_in: 3600 }))
      : new Response('{}'),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of [
    'CALENDAR_QUEUE',
    'CALENDAR_TASKS_QUEUE',
    'CALENDAR_JOBS_URL',
    'CALENDAR_JOBS_INVOKER',
  ]) {
    delete process.env[k];
  }
  resetCalendarEnv();
});

interface SentTask {
  name?: string;
  scheduleTime: string;
  httpRequest: { httpMethod: string; url: string; body: string; oidcToken: unknown };
}

const taskCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith('https://cloudtasks'))
    .map(([url, init]) => ({
      url: String(url),
      auth: (init as RequestInit).headers as Record<string, string>,
      task: (JSON.parse(String((init as RequestInit).body)) as { task: SentTask }).task,
    }));

describe('cloud tasks queue', () => {
  it('sends a signed call to the jobs route', async () => {
    expect(calendarEnv().CALENDAR_QUEUE).toBe('cloud-tasks');
    await enqueueCalendarJob({ type: 'poll' });
    const [call] = taskCalls();
    expect(call!.url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(call!.auth.Authorization).toBe('Bearer svc');
    expect(call!.task.name).toBeUndefined();
    expect(call!.task.httpRequest).toMatchObject({
      httpMethod: 'POST',
      url: 'https://api.example/jobs/calendar/poll',
      oidcToken: {
        serviceAccountEmail: 'jobs@p.iam.gserviceaccount.com',
        audience: 'https://api.example',
      },
    });
    expect(JSON.parse(Buffer.from(call!.task.httpRequest.body, 'base64').toString())).toEqual({});
  });

  it('merges syncs of one calendar into a named task at the end of the window', async () => {
    await enqueueCalendarJob({ type: 'sync-calendar', calendarId: CALENDAR });
    const [call] = taskCalls();
    expect(call!.task.name).toMatch(new RegExp(`^${QUEUE}/tasks/sync-${CALENDAR}-\\d+$`));
    const runsAt = Date.parse(call!.task.scheduleTime);
    expect(runsAt).toBeGreaterThan(Date.now());
    expect(runsAt - Date.now()).toBeLessThanOrEqual(SYNC_COALESCE_SECONDS * 1000);
    expect(JSON.parse(Buffer.from(call!.task.httpRequest.body, 'base64').toString())).toEqual({
      calendarId: CALENDAR,
    });
  });

  it('treats an already-queued merged task as done', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('http://metadata')
        ? new Response(JSON.stringify({ access_token: 'svc', expires_in: 3600 }))
        : new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 }),
    );
    await expect(
      enqueueCalendarJob({ type: 'sync-calendar', calendarId: CALENDAR }),
    ).resolves.toBeUndefined();
  });

  it('fails loudly on other errors (the caller retries)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('http://metadata')
        ? new Response(JSON.stringify({ access_token: 'svc', expires_in: 3600 }))
        : new Response('denied', { status: 403 }),
    );
    await expect(enqueueCalendarJob({ type: 'poll' })).rejects.toThrow(/403/);
  });
});
