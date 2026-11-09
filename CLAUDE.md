# planner-backend

Backend for Planner, an iOS-first day planner (client repo: `~/Documents/projects/planner-app`, Expo).
The plan this repo follows is `~/Documents/projects/planner-app/notes/backend-plan.md`; read it first.
The client repo's `CLAUDE.md` has the product and architecture context.

## Working agreement (from Samuel, 2026-11-09)
- **Work autonomously.** Run any commands and make any changes needed. Never prompt or ask questions until Samuel says stop. Pick sensible defaults and record them in README.md / this file.
- Only things that truly need him are exceptions: account sign-ups, secrets, Apple/Google console setup.
- Git: commit in logical steps with clear messages and no attribution or co-author lines. Commit email is already set (personal noreply). Push with `git push` (remote `origin` = `git@github-personal:samuelchen4/planner-backend.git`, personal SSH key).
- **Never use the `gh` CLI here:** it's logged into Samuel's work account.

## Stack
TypeScript (strict), pnpm, Hono (+ @hono/node-server), Drizzle (postgres-js) + drizzle-kit, Zod, Vitest, ESLint + Prettier (2 spaces, single quotes, 100 cols). Local Supabase in Docker (`pnpm db:start`).

## Data models
- `src/db/schema/`: Drizzle tables, one file per table (`tasks`, `habit_days`, `external_events`, plus `columns.ts`), with RLS policies (`drizzle-orm/supabase`) and `user_id` → `auth.users`.
- **This repo owns the models.** The app keeps a hand-synced copy in `planner-app/apps/mobile/src/db/schema/`: change here first, then copy. Later they move to a shared `planner-utils` repo.
- Migrations: `pnpm db:generate` (drizzle-kit → `supabase/migrations`, supabase prefix), then `pnpm db:reset` to apply locally.
- Keep the app-facing shape (column names and types) identical to the app's copy. Schema changes are two-step: add first, remove only after old app versions are gone.

## Status (2026-11-09)
Done: scaffold, models with RLS, migrations, the API (`/health`, `/sync/upload`) with tests (RLS isolation, upload rules, 503 on retryable failures), `powersync/sync-rules.yaml`, Dockerfile, `.env.example`, CI (`.github/workflows/ci.yml`), Pulumi skeleton in `infra/` (typechecks; never `pulumi up` without Samuel), README.md.

Next buildable locally: account deletion endpoint (Apple requires it), MCP server at `/mcp`, Siri routes, Google Calendar worker skeleton (see the plan, step 7).

Blocked on Samuel (note in README; don't wait on these): Supabase cloud dev/prod projects, a PowerSync Cloud instance, Sign in with Apple + Google OAuth setup, a GCP project for deploys, and connecting the app (PowerSync connector in planner-app).

## Commands
```bash
pnpm install
pnpm db:start        # local Supabase (Docker must be running)
pnpm db:generate     # migration from model changes
pnpm db:reset        # apply migrations locally (wipes local data)
pnpm dev             # API on localhost
pnpm typecheck && pnpm lint && pnpm test
pnpm exec prettier --check .   # CI checks formatting too (*.md is ignored)
cd infra && pnpm typecheck     # Pulumi program (own package, own lockfile)
docker build -t planner-backend .
```

## Gotchas
- Tests need `pnpm db:start` running; `test/setup-env.ts` reads URLs and keys from `supabase status`.
- Local Supabase (CLI v3) signs access tokens with ES256, checked via its JWKS like cloud projects. `SUPABASE_JWT_SECRET` only matters for legacy HS256 tokens.
- `asUser` switches to role `authenticated` inside the transaction: queries there see only the user's rows. The plain `db` client bypasses RLS (as `postgres`), so use it only for server-side work.
- `sync-retry.test.ts` mocks `asUser`: keep it in its own file.
