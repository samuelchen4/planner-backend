import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './supabase/migrations',
  migrations: { prefix: 'supabase' },
  schemaFilter: ['public'],
  entities: { roles: { provider: 'supabase' } },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  },
});
