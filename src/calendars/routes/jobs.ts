import { Hono, type MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { calendarJobSchema, runCalendarJob } from '../engine/jobs';
import { calendarEnv } from '../env';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Only Cloud Tasks and Cloud Scheduler may run jobs: they send a Google-signed OIDC token for the
 * CALENDAR_JOBS_INVOKER service account, with this service's URL as the audience. Until both are
 * configured, the route refuses everything.
 */
const requireJobInvoker: MiddlewareHandler = async (c, next) => {
  const { CALENDAR_JOBS_INVOKER: invoker, CALENDAR_JOBS_URL: audience } = calendarEnv();
  if (!invoker || !audience) return c.json({ error: 'Calendar jobs are not enabled' }, 403);
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!token) return c.json({ error: 'Missing token' }, 401);
  try {
    const { payload } = await jwtVerify(token, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience,
    });
    if (payload.email !== invoker || payload.email_verified !== true) {
      return c.json({ error: 'Not the job invoker' }, 403);
    }
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
};

/** POST /jobs/calendar/:type with the job as JSON. Mounted at /jobs/calendar. */
export const calendarJobRoutes = new Hono().post('/:type', requireJobInvoker, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const job = calendarJobSchema.safeParse({ ...body, type: c.req.param('type') });
  if (!job.success)
    return c.json({ error: 'Unknown or malformed job', issues: job.error.issues }, 400);
  await runCalendarJob(job.data);
  return c.json({ ok: true });
});
