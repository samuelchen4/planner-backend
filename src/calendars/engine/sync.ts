import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';

import { db, type Tx } from '../../db/client';
import { calendarAccounts, calendars, calendarSyncState, externalEvents } from '../../db/schema';
import { CalendarNotFound, CursorExpired, type ProviderEvent, type SyncResult } from '../provider';
import { withAccess } from './accounts';
import { enqueueCalendarJob } from './jobs';
import { subscribeCalendar, unsubscribeCalendar } from './subscriptions';

// Mirrors one calendar into external_events. Provider calls happen outside any transaction; the
// write is one transaction that also saves the new cursor, so a crash replays the same changes
// (upserts make that harmless) and never skips any.

const CHUNK = 500;

function eventRow(
  e: ProviderEvent,
  cal: { id: string; user_id: string; account_id: string; provider: 'google' | 'microsoft' },
) {
  return {
    user_id: cal.user_id,
    account_id: cal.account_id,
    calendar_id: cal.id,
    provider: cal.provider,
    external_id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    start_at: e.startAt,
    end_at: e.endAt,
    time_zone: e.timeZone,
    all_day_start: e.allDayStart,
    all_day_end: e.allDayEnd,
    status: e.status,
    series_id: e.seriesId,
    original_start_at: e.originalStartAt,
    web_link: e.webLink,
    version: e.version,
    provider_updated_at: e.updatedAt,
  };
}

/** Columns a sync refreshes on an existing row (taken from the incoming `excluded` row). */
const REFRESHED = [
  'title',
  'description',
  'location',
  'start_at',
  'end_at',
  'time_zone',
  'all_day_start',
  'all_day_end',
  'status',
  'series_id',
  'original_start_at',
  'web_link',
  'version',
  'provider_updated_at',
] as const;

const refreshSet = Object.fromEntries([
  ...REFRESHED.map((c) => [c, sql.raw(`excluded.${c}`)]),
  ['updated_at', sql`now()`],
]);

async function applyResult(
  tx: Tx,
  cal: Parameters<typeof eventRow>[1],
  result: SyncResult,
  full: boolean,
) {
  for (let i = 0; i < result.upserts.length; i += CHUNK) {
    await tx
      .insert(externalEvents)
      .values(result.upserts.slice(i, i + CHUNK).map((e) => eventRow(e, cal)))
      .onConflictDoUpdate({
        target: [externalEvents.calendar_id, externalEvents.external_id],
        set: refreshSet,
        // Unchanged at the provider: no write, so PowerSync has nothing to send.
        setWhere: sql`${externalEvents.version} is distinct from excluded.version`,
      });
  }
  for (let i = 0; i < result.deletes.length; i += CHUNK) {
    await tx
      .delete(externalEvents)
      .where(
        and(
          eq(externalEvents.calendar_id, cal.id),
          inArray(externalEvents.external_id, result.deletes.slice(i, i + CHUNK)),
        ),
      );
  }
  if (full) {
    // A full sync is the whole truth: drop whatever it didn't return.
    const seen = result.upserts.map((e) => e.id);
    await tx
      .delete(externalEvents)
      .where(
        seen.length
          ? and(
              eq(externalEvents.calendar_id, cal.id),
              notInArray(externalEvents.external_id, seen),
            )
          : eq(externalEvents.calendar_id, cal.id),
      );
  }
}

/**
 * Bring one calendar up to date: changes since its cursor, or everything (`full`, no cursor yet,
 * or the cursor expired). Skips calendars that aren't selected. If another sync of the same
 * calendar committed while this one was fetching, this one's result is dropped and another sync
 * is queued: the other's result may be older than this one's, so this makes sure nothing waits
 * for the scheduled poll.
 */
export async function syncCalendar(calendarId: string, options: { full?: boolean } = {}) {
  const [cal] = await db
    .select({
      id: calendars.id,
      user_id: calendars.user_id,
      account_id: calendars.account_id,
      provider: calendarAccounts.provider,
      provider_calendar_id: calendars.provider_calendar_id,
      is_selected: calendars.is_selected,
      is_planner_calendar: calendars.is_planner_calendar,
    })
    .from(calendars)
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.account_id))
    .where(eq(calendars.id, calendarId));
  if (!cal || !cal.is_selected || cal.is_planner_calendar) return;

  await db.insert(calendarSyncState).values({ calendar_id: cal.id }).onConflictDoNothing();
  const [state] = await db
    .select()
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendar_id, cal.id));
  const readCursor = state?.cursor ?? null;

  await withAccess(cal.account_id, async (token, provider) => {
    const ref = {
      providerCalendarId: cal.provider_calendar_id,
      windowStart: state?.window_start ?? null,
      windowEnd: state?.window_end ?? null,
    };
    let cursor = options.full ? null : readCursor;
    let result: SyncResult;
    try {
      try {
        result = await provider.syncEvents(token, ref, cursor);
      } catch (e) {
        if (!(e instanceof CursorExpired) || cursor === null) throw e;
        cursor = null; // too old: start over with a full sync
        result = await provider.syncEvents(token, ref, null);
      }
    } catch (e) {
      if (e instanceof CalendarNotFound) {
        // Deleted at the provider or access removed: refresh the list, which removes it.
        await enqueueCalendarJob({ type: 'sync-calendar-list', accountId: cal.account_id });
        return;
      }
      await db
        .update(calendarSyncState)
        .set({ last_error: String(e instanceof Error ? e.message : e), updated_at: sql`now()` })
        .where(eq(calendarSyncState.calendar_id, cal.id));
      throw e;
    }

    const lostRace = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ cursor: calendarSyncState.cursor })
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendar_id, cal.id))
        .for('update');
      if (!locked) return false;
      if ((locked.cursor ?? null) !== readCursor) return true;
      const [still] = await tx
        .select({ selected: calendars.is_selected })
        .from(calendars)
        .where(eq(calendars.id, cal.id));
      if (!still?.selected) return false; // switched off meanwhile; the deselect cleared it

      await applyResult(tx, cal, result, cursor === null);
      await tx
        .update(calendarSyncState)
        .set({
          cursor: result.cursor,
          ...(result.window && {
            window_start: result.window.start,
            window_end: result.window.end,
          }),
          last_synced_at: sql`now()`,
          last_error: null,
          updated_at: sql`now()`,
        })
        .where(eq(calendarSyncState.calendar_id, cal.id));
      return false;
    });
    if (lostRace) await enqueueCalendarJob({ type: 'sync-calendar', calendarId: cal.id });
  });
}

/**
 * A calendar was switched on or off. On: subscribe to live updates, then start over with a full
 * sync (subscribing first means no change between the two is missed). Off: unsubscribe, remove
 * its events and forget the cursor.
 */
export async function calendarSelectionChanged(calendarId: string) {
  const [cal] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
  if (!cal) return;
  if (cal.is_selected) {
    await db
      .insert(calendarSyncState)
      .values({ calendar_id: cal.id })
      .onConflictDoUpdate({
        target: calendarSyncState.calendar_id,
        set: { cursor: null, window_start: null, window_end: null, updated_at: sql`now()` },
      });
    // A calendar that can't be watched still syncs (and gets the scheduled poll).
    await subscribeCalendar(cal.id).catch((e) =>
      console.warn(`[calendars] subscribing calendar ${cal.id} failed`, e),
    );
    await syncCalendar(cal.id, { full: true });
    return;
  }
  await unsubscribeCalendar(cal.id);
  await db.transaction(async (tx) => {
    await tx.delete(externalEvents).where(eq(externalEvents.calendar_id, cal.id));
    await tx
      .update(calendarSyncState)
      .set({ cursor: null, window_start: null, window_end: null, updated_at: sql`now()` })
      .where(eq(calendarSyncState.calendar_id, cal.id));
  });
}

/**
 * Scheduled backup: queue an incremental sync of every selected calendar of every active account
 * (one job each, so one slow calendar doesn't hold up the rest).
 */
export async function pollAll() {
  const rows = await db
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.account_id))
    .where(
      and(
        eq(calendars.is_selected, true),
        eq(calendars.is_planner_calendar, false),
        eq(calendarAccounts.status, 'active'),
      ),
    );
  for (const { id } of rows) {
    await enqueueCalendarJob({ type: 'sync-calendar', calendarId: id });
  }
}

/** A windowed cursor is moved forward once its window has less than this left ahead. */
const REBASELINE_DAYS_LEFT = 335;

/**
 * Scheduled weekly: providers whose sync covers a fixed date window (Graph) need it moved forward,
 * or new events past its end never arrive. A full sync starts a new window from today (and drops
 * events that fell out of it). Open-ended cursors (Google) have no window end and are skipped.
 */
export async function rebaselineAll() {
  const rows = await db
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.account_id))
    .innerJoin(calendarSyncState, eq(calendarSyncState.calendar_id, calendars.id))
    .where(
      and(
        eq(calendars.is_selected, true),
        eq(calendars.is_planner_calendar, false),
        eq(calendarAccounts.status, 'active'),
        isNotNull(calendarSyncState.window_end),
        lt(
          calendarSyncState.window_end,
          sql`now() + make_interval(days => ${REBASELINE_DAYS_LEFT})`,
        ),
      ),
    );
  for (const { id } of rows) {
    await syncCalendar(id, { full: true }).catch((e) =>
      console.error(`[calendars] rebaseline of ${id} failed`, e),
    );
  }
}
