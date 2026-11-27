import { z } from 'zod';

import { calendarEnv } from '../env';
import { disconnectAccount, disconnectAll } from './accounts';
import { syncCalendarList } from './calendar-list';
import { createTask } from './cloud-tasks';
import { renewSubscriptions } from './subscriptions';
import { calendarSelectionChanged, pollAll, rebaselineAll, syncCalendar } from './sync';

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
  /** Scheduled weekly: move date windows forward for providers that need them (Graph). */
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

// Arrows (not direct references): the engine modules import this one, so handlers resolve their
// targets at call time.
const handlers: Handlers = {
  'sync-calendar': (job) => syncCalendar(job.calendarId),
  'sync-calendar-list': (job) => syncCalendarList(job.accountId),
  'calendar-selection-changed': (job) => calendarSelectionChanged(job.calendarId),
  'renew-subscriptions': () => renewSubscriptions(),
  poll: () => pollAll(),
  rebaseline: () => rebaselineAll(),
  'disconnect-account': (job) => disconnectAccount(job.accountId),
  'disconnect-all': (job) => disconnectAll(job.userId),
  'push-task': notYet('phase 2'),
  'push-event': notYet('phase 3'),
};

/** Runs a job here and now (the /jobs route, the inline queue, tests). */
export function runCalendarJob(job: CalendarJob): Promise<void> {
  return (handlers[job.type] as Handler<CalendarJobType>)(job);
}

// ─── The queue ───────────────────────────────────────────────────────────────────────────────

/**
 * Syncs of one calendar asked for within this many seconds run once, at the end of the window.
 * One edit in Google can send several webhooks; this turns the burst into a single sync.
 */
export const SYNC_COALESCE_SECONDS = 10;

const coalesceKey = (job: CalendarJob) =>
  job.type === 'sync-calendar' ? `sync-${job.calendarId}` : undefined;

const inFlight = new Set<Promise<void>>();
const pendingInline = new Set<string>();

/**
 * Queue a job. `cloud-tasks` (deployed): a task that calls CALENDAR_JOBS_URL/jobs/calendar/<type>
 * with a signed token; Cloud Tasks retries failures. `inline` (local dev, tests): runs in this
 * process right after the caller's request, errors logged. Either way, syncs of one calendar
 * queued close together are merged.
 */
export async function enqueueCalendarJob(job: CalendarJob): Promise<void> {
  const parsed = calendarJobSchema.parse(job);
  const key = coalesceKey(parsed);
  if (calendarEnv().CALENDAR_QUEUE === 'cloud-tasks') {
    const { type, ...payload } = parsed;
    await createTask(type, payload, {
      ...(key && { coalesce: { key, seconds: SYNC_COALESCE_SECONDS } }),
    });
    return;
  }
  if (key) {
    if (pendingInline.has(key)) return; // the queued one hasn't started; it will see this change
    pendingInline.add(key);
  }
  const run = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => {
      if (key) pendingInline.delete(key);
      return runCalendarJob(parsed);
    })
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
