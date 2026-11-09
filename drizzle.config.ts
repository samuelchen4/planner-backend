import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the models into supabase/migrations (Supabase CLI naming), and
// applied with `supabase db reset` locally / `supabase db push` to a cloud project.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './supabase/migrations',
  migrations: { prefix: 'supabase' },
  // Supabase owns the auth schema and its roles: only generate our public tables.
  schemaFilter: ['public'],
  entities: { roles: { provider: 'supabase' } },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  },
});
