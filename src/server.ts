import { serve } from '@hono/node-server';

import { app } from './app';
import { client } from './db/client';
import { env } from './env';

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`planner-backend listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await client.end({ timeout: 5 });
      process.exit(0);
    });
  });
}
