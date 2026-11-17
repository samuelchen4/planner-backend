import { Hono } from 'hono';

import type { AuthVariables } from '../../auth';

/**
 * Connecting and disconnecting accounts (step 3 of the plan), mounted at /integrations:
 *   POST   /:provider/start     (signed in)  → { url } for the provider's consent page
 *   GET    /:provider/callback  (from the provider) → store the account, import calendars,
 *                                 redirect to <scheme>://integrations/done
 *   DELETE /accounts/:id        (signed in)  → queue disconnect-account
 */
export const integrationRoutes = new Hono<{ Variables: AuthVariables }>();
