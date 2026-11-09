import { sql } from 'drizzle-orm';

import { db, type Tx } from './client';

/**
 * Run `work` in one transaction as the signed-in user: the Postgres role becomes `authenticated`
 * and auth.uid() returns `userId`, so the tables' Row Level Security policies apply to every query
 * in it, on top of the checks the API makes itself.
 */
export function asUser<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return work(tx);
  });
}
