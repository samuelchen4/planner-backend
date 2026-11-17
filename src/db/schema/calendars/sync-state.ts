import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { timestamptz } from '../columns';
import { calendars } from './calendars';

/**
 * The sync engine's bookkeeping for one calendar: where it's up to and its webhook subscription.
 * Server-only (RLS on, no policies, not published to PowerSync).
 */
export const calendarSyncState = pgTable('calendar_sync_state', {
  calendar_id: uuid()
    .primaryKey()
    .references(() => calendars.id, { onDelete: 'cascade' }),
  /** Where incremental sync resumes: Google syncToken, Graph deltaLink. Null = full sync next. */
  cursor: text(),
  /** The date range the cursor covers, for providers that need one (Graph). */
  window_start: timestamptz(),
  window_end: timestamptz(),
  subscription_id: text(),
  /** Google's resource id (needed to stop a channel). */
  subscription_resource_id: text(),
  /** Checked on every webhook (Google channel token, Graph clientState). */
  subscription_secret: text(),
  subscription_expires_at: timestamptz(),
  last_synced_at: timestamptz(),
  last_error: text(),
  updated_at: timestamptz().notNull().defaultNow(),
}).enableRLS();

export type CalendarSyncState = typeof calendarSyncState.$inferSelect;
