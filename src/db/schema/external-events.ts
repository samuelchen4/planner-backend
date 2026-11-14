import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { day, oneOf, ownerId, readOwnRows, timestamptz } from './columns';

export const CALENDAR_PROVIDERS = ['google'] as const;
export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;

export const externalEvents = pgTable(
  'external_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: ownerId(),
    provider: text({ enum: CALENDAR_PROVIDERS }).notNull(),
    calendar_id: text().notNull(),
    external_id: text().notNull(),
    title: text().notNull().default(''),
    location: text(),
    start_at: timestamptz(),
    end_at: timestamptz(),
    time_zone: text(),
    all_day_start: day(),
    all_day_end: day(),
    status: text({ enum: EVENT_STATUSES }).notNull().default('confirmed'),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_events_source_idx').on(t.provider, t.calendar_id, t.external_id),
    index('external_events_user_idx').on(t.user_id),
    readOwnRows('external_events', t.user_id),
    oneOf('external_events_provider_check', t.provider, CALENDAR_PROVIDERS),
    oneOf('external_events_status_check', t.status, EVENT_STATUSES),
  ],
);

export type ExternalEvent = typeof externalEvents.$inferSelect;
