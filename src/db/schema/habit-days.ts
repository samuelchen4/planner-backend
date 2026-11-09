import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { day, ownerId, ownRows, timestamptz } from './columns';
import { tasks } from './tasks';

/**
 * One day of a habit (a task of type 'habit'): whether it was done, and that day's note. At most
 * one row per habit per day; a day with neither is deleted.
 */
export const habitDays = pgTable(
  'habit_days',
  {
    /** `${habit_id}:${date}`, so the same day always has the same id on every device. */
    id: text().primaryKey(),
    habit_id: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** The owner (auth.users.id). */
    user_id: ownerId(),
    date: day().notNull(),
    /** When it was checked off for that day; null = not done. */
    done_at: timestamptz(),
    note: text(),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('habit_days_habit_date_idx').on(t.habit_id, t.date),
    index('habit_days_user_idx').on(t.user_id),
    ownRows('habit_days', t.user_id),
  ],
);

export type HabitDay = typeof habitDays.$inferSelect;
