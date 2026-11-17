import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { day, oneOf, ownerId, readOwnRows, timestamptz } from '../columns';
import { calendarAccounts } from './accounts';
import { calendars } from './calendars';
import { CALENDAR_PROVIDERS, EVENT_STATUSES, PUSH_STATES } from './constants';

/**
 * Events mirrored from the user's selected calendars, read-only in the app (phase 3 lets it edit
 * some fields). Written by the calendar sync engine. See
 * ~/Documents/projects/planner-app/notes/calendar-integrations.md.
 */
export const externalEvents = pgTable(
  'external_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: ownerId(),
    account_id: uuid()
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: 'cascade' }),
    calendar_id: uuid()
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    /** Copied from the account, so it reads without a join. */
    provider: text({ enum: CALENDAR_PROVIDERS }).notNull(),
    /** The event's id at the provider. */
    external_id: text().notNull(),
    title: text().notNull().default(''),
    /** Shown as the event's notes. */
    description: text(),
    location: text(),
    /** Timed events (UTC), with the event's own IANA zone. */
    start_at: timestamptz(),
    end_at: timestamptz(),
    time_zone: text(),
    /** All-day events: first day, and the day after the last (exclusive, like the providers). */
    all_day_start: day(),
    all_day_end: day(),
    status: text({ enum: EVENT_STATUSES }).notNull().default('confirmed'),
    /** A repeating event's occurrence: the series it belongs to, and which occurrence it was. */
    series_id: text(),
    original_start_at: timestamptz(),
    /** Opens the event at the provider. */
    web_link: text(),
    /** The provider's version (etag): unchanged rows aren't rewritten; phase 3 conflict checks. */
    version: text(),
    provider_updated_at: timestamptz(),
    push_state: text({ enum: PUSH_STATES }).notNull().default('synced'),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_events_source_idx').on(t.calendar_id, t.external_id),
    index('external_events_user_idx').on(t.user_id),
    readOwnRows('external_events', t.user_id),
    oneOf('external_events_provider_check', t.provider, CALENDAR_PROVIDERS),
    oneOf('external_events_status_check', t.status, EVENT_STATUSES),
    oneOf('external_events_push_state_check', t.push_state, PUSH_STATES),
  ],
);

export type ExternalEvent = typeof externalEvents.$inferSelect;
