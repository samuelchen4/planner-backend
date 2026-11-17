import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { oneOf, timestamptz } from '../columns';
import { tasks } from '../tasks';
import { calendars } from './calendars';
import { PUSH_STATES } from './constants';

/**
 * Phase 2 (scaffolded, unused): a task pushed to a provider calendar, and the event it became.
 * Server-only (RLS on, no policies, not published).
 */
export const taskCalendarLinks = pgTable(
  'task_calendar_links',
  {
    task_id: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    calendar_id: uuid()
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    provider_event_id: text().notNull(),
    version: text(),
    push_state: text({ enum: PUSH_STATES }).notNull().default('synced'),
    last_pushed_at: timestamptz(),
  },
  (t) => [
    primaryKey({ columns: [t.task_id, t.calendar_id] }),
    oneOf('task_calendar_links_push_state_check', t.push_state, PUSH_STATES),
  ],
).enableRLS();
