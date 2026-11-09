import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Points the app at the local Supabase (needs `pnpm db:start`).
    setupFiles: ['./test/setup-env.ts'],
    // Test files share one database: run them one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
