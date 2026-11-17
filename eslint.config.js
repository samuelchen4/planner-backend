import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'infra/node_modules', 'infra/bin', 'supabase'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // The calendar module stays detachable (planner-app/notes/calendar-integrations.md,
  // "Keeping it detachable"). Outside it: import only src/calendars/index.ts.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/calendars/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\.?/)+calendars/(?!index$)',
              message:
                "Import the calendar module only through 'calendars' (its index.ts); queue a job instead of calling its internals.",
            },
          ],
        },
      ],
    },
  },
  // Inside it: only shared foundations (db client and schema, auth, lib), never the API's own
  // routes, app, server or env. One block per folder depth, so `../` that stays inside the module
  // (e.g. engine/ → ../env.ts, the module's own config) isn't flagged.
  ...[1, 2, 3].map((depth) => ({
    files: [`src/calendars/${'*/'.repeat(depth - 1)}*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^(\\.\\./){${depth}}(routes|app|server|env)(/|$)`,
              message:
                'The calendar module may import only db/, auth and lib/ from the rest of the API (use calendars/env.ts for config).',
            },
          ],
        },
      ],
    },
  })),
);
