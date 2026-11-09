import { execSync } from 'node:child_process';

// Read the local Supabase's URLs and keys (`supabase status`), before the app reads its env.
const status = JSON.parse(execSync('npx supabase status -o json', { encoding: 'utf8' })) as Record<
  string,
  string
>;
process.env.DATABASE_URL = status.DB_URL;
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_JWT_SECRET = status.JWT_SECRET;
process.env.TEST_ANON_KEY = status.ANON_KEY;
process.env.TEST_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
