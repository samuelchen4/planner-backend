import { z } from 'zod';

// Calendar-only configuration, parsed apart from src/env.ts so an `api`-role service runs without
// any calendar secrets, and only this module ever sees the credentials key. Parsed on first use.

const flag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** 32 random bytes, base64: encrypts calendar_credentials (AES-256-GCM). */
  CALENDAR_CREDENTIALS_KEY: z.string().optional(),
  /** Public base URL providers call for webhooks and OAuth callbacks (a tunnel when local). */
  CALENDAR_PUBLIC_URL: z.string().url().optional(),
  /** Where queued jobs are sent (Cloud Tasks target). Defaults to this service. */
  CALENDAR_JOBS_URL: z.string().url().optional(),
  /** `inline`: jobs run in this process (local dev, tests). `cloud-tasks`: queued in GCP. */
  CALENDAR_QUEUE: z.enum(['inline', 'cloud-tasks']).default('inline'),
  /** `cloud-tasks`: the queue, `projects/<p>/locations/<region>/queues/<name>`. */
  CALENDAR_TASKS_QUEUE: z.string().optional(),
  /** Service account allowed to call /jobs/calendar/* (Cloud Tasks and Scheduler OIDC tokens). */
  CALENDAR_JOBS_INVOKER: z.string().optional(),
  /** Phase 2/3 switch: pushing tasks and event edits to providers. */
  CALENDAR_PUSH_ENABLED: flag,
});

export type CalendarEnv = z.infer<typeof schema>;

let parsed: CalendarEnv | undefined;

export function calendarEnv(): CalendarEnv {
  parsed ??= schema.parse(process.env);
  return parsed;
}

/** Tests: re-read process.env on next use. */
export function resetCalendarEnv() {
  parsed = undefined;
}
