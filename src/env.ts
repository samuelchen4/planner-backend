import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  SUPABASE_URL: z.string().default('http://127.0.0.1:54321'),
  SUPABASE_JWT_SECRET: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
