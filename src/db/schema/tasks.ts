import { doublePrecision, index, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { day, oneOf, ownerId, ownRows, timestamptz } from './columns';

export const TASK_TYPES = ['task', 'time_block', 'list', 'habit'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const TASK_COLORS = ['yellow', 'pink', 'blue', 'orange', 'lavender'] as const;

export const tasks = pgTable(
  'tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: ownerId(),
    type: text({ enum: TASK_TYPES }).notNull().default('task'),
    title: text().notNull().default(''),
    notes: text(),

    start_at: timestamptz(),
    end_at: timestamptz(),
    time_zone: text(),
    all_day_date: day(),
    rrule: text(),

    status: text({ enum: TASK_STATUSES }).notNull().default('open'),
    completed_at: timestamptz(),

    list_id: uuid().references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
    color: text({ enum: TASK_COLORS }),
    icon: text(),
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
