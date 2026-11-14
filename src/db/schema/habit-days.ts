import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { day, ownerId, ownRows, timestamptz } from './columns';
import { tasks } from './tasks';

export const habitDays = pgTable(
  'habit_days',
  {
    id: text().primaryKey(),
    habit_id: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: ownerId(),
    date: day().notNull(),
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
