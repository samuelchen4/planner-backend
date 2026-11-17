import { sql } from 'drizzle-orm';
import { boolean, index, pgPolicy, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid } from 'drizzle-orm/supabase';

import { oneOf, ownerId, readOwnRows, timestamptz } from '../columns';
import { ACCESS_ROLES } from './constants';
import { calendarAccounts } from './accounts';

/**
 * A calendar in a connected account. Written by the calendar module; the app can only switch
 * `is_selected` (the upload allow-list, plus a column grant in the migration). Selected calendars
 * are mirrored into external_events.
 */
export const calendars = pgTable(
  'calendars',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: ownerId(),
    account_id: uuid()
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: 'cascade' }),
    /** The calendar's id at the provider (e.g. 'samuel@gmail.com'). */
    provider_calendar_id: text().notNull(),
    name: text().notNull().default(''),
    /** Hex colour from the provider. */
    color: text(),
    is_primary: boolean().notNull().default(false),
    access_role: text({ enum: ACCESS_ROLES }).notNull().default('reader'),
    is_selected: boolean().notNull().default(false),
    /** Phase 2: the calendar Planner creates to push tasks into. Never mirrored. */
    is_planner_calendar: boolean().notNull().default(false),
    created_at: timestamptz().notNull().defaultNow(),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendars_source_idx').on(t.account_id, t.provider_calendar_id),
    index('calendars_user_idx').on(t.user_id),
    readOwnRows('calendars', t.user_id),
    pgPolicy('calendars_update_own_rows', {
      for: 'update',
      to: authenticatedRole,
      using: sql`${t.user_id} = ${authUid}`,
      withCheck: sql`${t.user_id} = ${authUid}`,
    }),
    oneOf('calendars_access_role_check', t.access_role, ACCESS_ROLES),
  ],
);

export type Calendar = typeof calendars.$inferSelect;
