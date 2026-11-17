import { z } from 'zod';

import { calendarEnv } from '../env';

// Every unit of calendar work is a job. The rest of the API only ever queues jobs (never calls
// the engine), so the engine can move to its own service by pointing the queue elsewhere.

export const calendarJobSchema = z.discriminatedUnion('type', [
  /** Changes since the cursor (or a full sync) for one calendar. */
  z.object({ type: z.literal('sync-calendar'), calendarId: z.uuid() }),
  /** Refresh an account's list of calendars (names, colours, new or removed calendars). */
  z.object({ type: z.literal('sync-calendar-list'), accountId: z.uuid() }),
  /** The user switched a calendar on or off: subscribe + full sync, or unsubscribe + clear. */
  z.object({ type: z.literal('calendar-selection-changed'), calendarId: z.uuid() }),
  /** Scheduled: renew subscriptions close to expiring. */
  z.object({ type: z.literal('renew-subscriptions') }),
  /** Scheduled: incremental sync of every selected calendar (catches missed webhooks). */
  z.object({ type: z.literal('poll') }),
  /** Scheduled: move date windows forward for providers that need them (Graph). */
  z.object({ type: z.literal('rebaseline') }),
  /** Unsubscribe, revoke and delete one account. */
  z.object({ type: z.literal('disconnect-account'), accountId: z.uuid() }),
  /** Planner account deletion: disconnect all of a user's accounts. */
  z.object({ type: z.literal('disconnect-all'), userId: z.uuid() }),
  /** Phase 2: create/update/delete a task's event in the Planner calendar. */
  z.object({ type: z.literal('push-task'), taskId: z.uuid() }),
  /** Phase 3: send an edited event to its provider. */
  z.object({ type: z.literal('push-event'), eventId: z.uuid() }),
]);

export type CalendarJob = z.infer<typeof calendarJobSchema>;
export type CalendarJobType = CalendarJob['type'];

type Handler<T extends CalendarJobType> = (job: Extract<CalendarJob, { type: T }>) => Promise<void>;
type Handlers = { [T in CalendarJobType]: Handler<T> };

const notYet = (step: string) => async (job: CalendarJob) => {
  console.info(`[calendars] job ${job.type} received; handler arrives in ${step}`);
};

// Filled in by later steps of the plan (engine/sync.ts, subscriptions.ts, push.ts).
const handlers: Handlers = {
  'sync-calendar': notYet('step 4 (event sync)'),
  'sync-calendar-list': notYet('step 3 (connect)'),
  'calendar-selection-changed': notYet('step 4 (event sync)'),
  'renew-subscriptions': notYet('step 6 (live updates)'),
  poll: notYet('step 6 (live updates)'),
  rebaseline: notYet('step 8 (Outlook)'),
  'disconnect-account': notYet('step 3 (connect)'),
  'disconnect-all': notYet('step 3 (connect)'),
  'push-task': notYet('phase 2'),
  'push-event': notYet('phase 3'),
};

/** Runs a job here and now (the /jobs route, the inline queue, tests). */
export function runCalendarJob(job: CalendarJob): Promise<void> {
  return (handlers[job.type] as Handler<CalendarJobType>)(job);
}

// ─── The queue ───────────────────────────────────────────────────────────────────────────────

const inFlight = new Set<Promise<void>>();

/**
 * Queue a job. `inline` (local dev, tests, and until Cloud Tasks is set up in step 6): runs in
 * this process right after the caller's request, errors logged. `cloud-tasks`: a task targeting
 * CALENDAR_JOBS_URL/jobs/calendar/<type>, so after a split only that URL changes.
 */
export async function enqueueCalendarJob(job: CalendarJob): Promise<void> {
  const parsed = calendarJobSchema.parse(job);
  if (calendarEnv().CALENDAR_QUEUE === 'cloud-tasks') {
    throw new Error('Cloud Tasks queueing arrives in step 6 of the calendar plan');
  }
  const run = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runCalendarJob(parsed))
    .catch((e) => console.error(`[calendars] job ${parsed.type} failed`, e))
    .finally(() => inFlight.delete(run));
  inFlight.add(run);
}

/** Tests: wait for every inline job (including ones those jobs queue). */
export async function drainCalendarJobs() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** Tests: replace a handler, returning a function that restores it. */
export function setCalendarJobHandler<T extends CalendarJobType>(type: T, handler: Handler<T>) {
  const previous = handlers[type];
  handlers[type] = handler as Handlers[T];
  return () => {
    handlers[type] = previous;
  };
}
