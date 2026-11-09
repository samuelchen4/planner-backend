import { z } from 'zod';

/**
 * Settings, from environment variables (see .env.example). Defaults point at the local Supabase
 * started by `pnpm db:start`.
 */
const schema = z.object({
  PORT: z.coerce.number().default(8787),
  /** Postgres, as a role that can switch to `authenticated` (the default `postgres` user). */
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  /** The Supabase project URL: its JWKS (public signing keys) checks sign-in tokens. */
  SUPABASE_URL: z.string().default('http://127.0.0.1:54321'),
  /** Legacy shared secret, for projects that still sign tokens with HS256. Optional. */
  SUPABASE_JWT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
