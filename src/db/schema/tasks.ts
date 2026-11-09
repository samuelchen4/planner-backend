import { doublePrecision, index, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { day, oneOf, ownerId, ownRows, timestamptz } from './columns';

export const TASK_TYPES = ['task', 'time_block', 'list', 'habit'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
/** Colours a list or habit can take (green is reserved for done). */
export const TASK_COLORS = ['yellow', 'pink', 'blue', 'orange', 'lavender'] as const;

/**
 * Everything the user makes is a task. `type` says which kind:
 * - task / time_block: on the planner, either timed (`start_at`/`end_at`) or all-day
 *   (`all_day_date`); neither = the inbox.
 * - list: a task with entries (other tasks whose `list_id` points at it).
 * - habit: done every day; its history is in `habit_days`.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The owner (auth.users.id). */
    user_id: ownerId(),
    type: text({ enum: TASK_TYPES }).notNull().default('task'),
    title: text().notNull().default(''),
    notes: text(),

    /** Timed: when it starts and ends, and the time zone it was planned in. */
    start_at: timestamptz(),
    end_at: timestamptz(),
    time_zone: text(),
    /** All-day: the day it's on. */
    all_day_date: day(),
    /** Repeats (RFC 5545), e.g. 'FREQ=WEEKLY;BYDAY=MO,WE'. Not used by the app yet. */
    rrule: text(),

    status: text({ enum: TASK_STATUSES }).notNull().default('open'),
    /** When it was checked off (set with status 'done'). */
    completed_at: timestamptz(),

    /** An entry of a list: the list's id. Entries have no times or dates of their own. */
    list_id: uuid().references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
    /** Lists and habits: their colour. Habits: their icon (an SF Symbol name for now). */
    color: text({ enum: TASK_COLORS }),
    icon: text(),
    /**
     * Order among siblings (a day's all-day tasks, a list's entries). Fractional: placing a task
     * between two others takes the midpoint, so a move changes one row.
     */
    position: doublePrecision().notNull().default(0),

    created_at: timestamptz().notNull().defaultNow(),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('tasks_user_idx').on(t.user_id),
    index('tasks_list_idx').on(t.list_id),
    ownRows('tasks', t.user_id),
    oneOf('tasks_type_check', t.type, TASK_TYPES),
    oneOf('tasks_status_check', t.status, TASK_STATUSES),
    oneOf('tasks_color_check', t.color, TASK_COLORS),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type TaskType = Task['type'];
export type TaskColor = NonNullable<Task['color']>;
