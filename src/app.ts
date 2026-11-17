import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import { calendarJobRoutes, calendarPublicRoutes } from './calendars';
import { db } from './db/client';
import { env, type Env } from './env';
import { syncRoutes } from './routes/sync';

/**
 * The HTTP app for a SERVICE_ROLE. One image serves everything today (`all`); the calendar module
 * can move to its own Cloud Run service by deploying the same image as `sync` (and the API as
 * `api`). See "Keeping it detachable" in planner-app/notes/calendar-integrations.md.
 */
export function createApp(role: Env['SERVICE_ROLE']) {
  const app = new Hono()
    .use(logger())
    .use(
      cors({
        origin: env.CORS_ORIGINS,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    )
    .get('/health', async (c) => {
      await db.execute(sql`select 1`);
      return c.json({ ok: true, role });
    });

  if (role !== 'sync') app.route('/sync', syncRoutes);
  if (role !== 'api') {
    app.route('/', calendarPublicRoutes);
    app.route('/jobs/calendar', calendarJobRoutes);
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });
  return app;
}

export const app = createApp(env.SERVICE_ROLE);

export type AppType = typeof app;
