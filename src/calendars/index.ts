import { Hono } from 'hono';

import type { AuthVariables } from '../auth';
import { integrationRoutes } from './routes/integrations';
import { webhookRoutes } from './routes/webhooks';

// The calendar module's only import surface. Code outside src/calendars/ may import this file and
// nothing else in the folder (enforced by ESLint), and talks to the engine only by queueing jobs.
// See "Keeping it detachable" in planner-app/notes/calendar-integrations.md.

/** User- and provider-facing routes: /integrations/* and /webhooks/*. */
export const calendarPublicRoutes = new Hono<{ Variables: AuthVariables }>()
  .route('/integrations', integrationRoutes)
  .route('/webhooks', webhookRoutes);

/** Cloud Tasks / Scheduler targets, mount at /jobs/calendar (OIDC-only). */
export { calendarJobRoutes } from './routes/jobs';

export { enqueueCalendarJob, type CalendarJob } from './engine/jobs';
