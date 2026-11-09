import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import { db } from './db/client';
import { syncRoutes } from './routes/sync';

/** The HTTP API (also used by the tests, without starting a server). */
export const app = new Hono()
  .use(logger())
  .get('/health', async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  })
  .route('/sync', syncRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

export type AppType = typeof app;
