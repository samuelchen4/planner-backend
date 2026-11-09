import { eq, getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { Hono } from 'hono';
import { z } from 'zod';

import { requireUser, type AuthVariables } from '../auth';
import { asUser } from '../db/as-user';
import type { Tx } from '../db/client';
import { habitDays, tasks } from '../db/schema';

// POST /sync/upload: the app's PowerSync connector sends its queued local changes here.
//
// Each change is checked and applied as the signed-in user (RLS applies too), all in one
// transaction. A change that can never succeed (bad data, someone else's row, a table the app
// can't write) is skipped and reported, not retried: an error would make the app resend the batch
// forever and block its queue. Only failures that might succeed later (database down) return 5xx.

/** Tables the app may write, by PowerSync table name. external_events is server-only. */
const WRITABLE = { tasks, habit_days: habitDays } as const;
type WritableName = keyof typeof WRITABLE;

/** For each writable table: the columns that hold another of the user's rows. */
const OWNED_REFERENCES: Record<WritableName, string[]> = {
  tasks: ['list_id'],
  habit_days: ['habit_id'],
};

/** Row shape checks, from the models (types, enums, required columns). */
const rowSchemas = {
  tasks: createInsertSchema(tasks).omit({ id: true, user_id: true }),
  habit_days: createInsertSchema(habitDays).omit({ id: true, user_id: true }),
};

const changeSchema = z.object({
  op: z.enum(['PUT', 'PATCH', 'DELETE']),
  type: z.string(),
  id: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});
const bodySchema = z.object({ batch: z.array(changeSchema) });

export type Change = z.infer<typeof changeSchema>;

export interface Rejection {
  index: number;
  type: string;
  id: string;
  reason: string;
}

/** A change the database can never accept (as opposed to a temporary failure). */
class Rejected extends Error {}

/** Postgres error classes that mean "this data is wrong", not "try again later". */
function isPermanentDbError(e: unknown): boolean {
  const code =
    (e as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (e as { code?: string })?.code;
  return (
    typeof code === 'string' &&
    (code.startsWith('22') || // data exception (bad value, bad date…)
      code.startsWith('23') || // integrity (foreign key, check, unique, not null)
      code === '42501' || // insufficient privilege: Row Level Security said no
      code === '42703') // undefined column
  );
}

async function applyChange(tx: Tx, userId: string, change: Change) {
  if (!(change.type in WRITABLE)) throw new Rejected(`Table "${change.type}" can't be written`);
  const name = change.type as WritableName;
  const table = WRITABLE[name] as PgTable & typeof tasks;
  const idColumn = getTableColumns(table).id;

  if (change.op === 'DELETE') {
    // RLS limits this to the user's own rows; deleting a row that's already gone is fine.
    await tx.delete(table).where(eq(idColumn, change.id));
    return;
  }

  const data = { ...change.data };
  if ('id' in data) delete data.id;
  if ('user_id' in data) {
    if (data.user_id !== userId) throw new Rejected('user_id must be the signed-in user');
    delete data.user_id;
  }
  const known = new Set(Object.keys(getTableColumns(table)));
  const unknown = Object.keys(data).filter((c) => !known.has(c));
  if (unknown.length) throw new Rejected(`Unknown column(s): ${unknown.join(', ')}`);

  const schema = change.op === 'PUT' ? rowSchemas[name] : rowSchemas[name].partial();
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Rejected(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  // References must point at the user's own rows (a foreign key alone would accept anyone's).
  for (const column of OWNED_REFERENCES[name]) {
    const ref = (parsed.data as Record<string, unknown>)[column];
    if (typeof ref !== 'string') continue;
    const [owned] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, ref));
    if (!owned) throw new Rejected(`${column} doesn't point at one of your tasks`);
  }

  if (change.op === 'PUT') {
    const row = { ...parsed.data, id: change.id, user_id: userId };
    await tx
      .insert(table)
      .values(row as typeof tasks.$inferInsert)
      .onConflictDoUpdate({ target: idColumn, set: row as Partial<typeof tasks.$inferInsert> });
  } else if (Object.keys(parsed.data).length) {
    // PATCH: RLS limits this to the user's own rows (another user's id updates nothing).
    await tx
      .update(table)
      .set(parsed.data as Partial<typeof tasks.$inferInsert>)
      .where(eq(idColumn, change.id));
  }
}

/** Apply a batch for `userId`: returns the skipped changes. Throws on temporary failures. */
export async function applyBatch(userId: string, batch: Change[]): Promise<Rejection[]> {
  const rejected: Rejection[] = [];
  await asUser(userId, async (tx) => {
    for (const [index, change] of batch.entries()) {
      try {
        // A savepoint per change: a rejected one is undone without losing the others.
        await tx.transaction((sp) => applyChange(sp, userId, change));
      } catch (e) {
        if (!(e instanceof Rejected) && !isPermanentDbError(e)) throw e;
        const reason =
          e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        rejected.push({ index, type: change.type, id: change.id, reason });
      }
    }
  });
  return rejected;
}

export const syncRoutes = new Hono<{ Variables: AuthVariables }>().post(
  '/upload',
  requireUser,
  async (c) => {
    const body = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'Expected { batch: [...] }', issues: body.error.issues }, 400);
    const userId = c.get('userId');
    try {
      const rejected = await applyBatch(userId, body.data.batch);
      if (rejected.length)
        console.warn(`[sync] ${userId}: skipped ${rejected.length} change(s)`, rejected);
      return c.json({ applied: body.data.batch.length - rejected.length, rejected });
    } catch (e) {
      console.error('[sync] upload failed, the app will retry', e);
      return c.json({ error: 'Temporary failure, retry' }, 503);
    }
  },
);
