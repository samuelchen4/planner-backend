# planner-backend

Backend for Planner, an iOS-first day planner (client repo: `~/Documents/projects/planner-app`, Expo).
The plan this repo follows is `~/Documents/projects/planner-app/notes/backend-plan.md`; read it first.
Calendar sync (Google first, then Outlook; provider adapters, read-only first with two-way scaffolded) follows `~/Documents/projects/planner-app/notes/calendar-integrations.md`.
The client repo's `CLAUDE.md` has the product and architecture context.

## Working agreement (from Samuel, 2026-11-09)
- **Work autonomously.** Run any commands and make any changes needed. Never prompt or ask questions until Samuel says stop. Pick sensible defaults and record them in README.md / this file.
- Only things that truly need him are exceptions: account sign-ups, secrets, Apple/Google console setup.
- Git (updated 2026-11-13): **don't commit or push.** Samuel reviews, commits and pushes himself; leave changes in the working tree. (If he asks for a commit: clear message, no attribution or co-author lines; remote `origin` = `git@github-personal:samuelchen4/planner-backend.git`.)
- **No comments** in any file (code, config, SQL, Dockerfile) unless Samuel asks for one. Explanations go in README.md / this file. Functional directives stay: `--> statement-breakpoint`, `# syntax=docker/dockerfile:1`.
- **Never use the `gh` CLI here:** it's logged into Samuel's work account.

## Stack
TypeScript (strict), pnpm, Hono (+ @hono/node-server), Drizzle (postgres-js) + drizzle-kit, Zod, Vitest, ESLint + Prettier (2 spaces, single quotes, 100 cols). Local Supabase in Docker (`pnpm db:start`).

## Data models
- `src/db/schema/`: Drizzle tables, one file per table (`tasks`, `habit_days`, `external_events`, plus `columns.ts`), with RLS policies (`drizzle-orm/supabase`) and `user_id` → `auth.users`.
- **This repo owns the models.** The app keeps a hand-synced copy in `planner-app/apps/mobile/src/db/schema/`: change here first, then copy. Later they move to a shared `planner-utils` repo.
- Migrations: `pnpm db:generate` (drizzle-kit → `supabase/migrations`, supabase prefix), then `pnpm db:reset` to apply locally.
- Keep the app-facing shape (column names and types) identical to the app's copy. Schema changes are two-step: add first, remove only after old app versions are gone.

## Status (2026-11-17)
Done: scaffold, models with RLS, migrations, the API (`/health`, `/sync/upload`) with tests (RLS isolation, upload rules, 503 on retryable failures), `powersync/sync-rules.yaml`, Dockerfile, `.env.example`, CI (`.github/workflows/ci.yml`), Pulumi skeleton in `infra/` (typechecks; never `pulumi up` without Samuel), README.md. Calendar integrations step 2: tables, access rules, upload allow-list for `calendars.is_selected`, and the `src/calendars/` module scaffold (adapter contract, fake provider, jobs, webhooks, OIDC-locked jobs route, `SERVICE_ROLE`, ESLint boundary). See README "Calendar integrations".

Next (calendar plan, frontend changes last): step 1 spike and step 3 connect flow need Samuel's Google setup (step 0); until then, provider-neutral engine work against the fake provider (full/incremental sync, cleanup on deselect, subscriptions) and the Google adapter's mapping on recorded payloads. Also still open: account deletion endpoint (Apple requires it; must queue `disconnect-all`), MCP server at `/mcp`, Siri routes.

Blocked on Samuel (note in README; don't wait on these): pushing the calendar migrations and sync rules to dev, Google Calendar setup (calendar plan step 0), GCP deploy pipeline.

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
- Pulumi: Samuel's machine-wide Pulumi backend is his **work** S3 bucket. Never run `pulumi login` here. `infra/Pulumi.yaml` pins `backend.url: https://api.pulumi.com` (his personal Pulumi Cloud account), authenticated per command with `PULUMI_ACCESS_TOKEN` from `.env` (`set -a; source ../.env; set +a` inside `infra/`).
- GCP: project `planner-514904`, region `us-east4` (Supabase dev project is AWS us-east-1, same metro), owned by Samuel's **personal** Google account (samuel.chen156@gmail.com). His gcloud `default` profile is his **work** account and work project (`ezee-dev-488713`): never use it here. Always run gcloud with `CLOUDSDK_ACTIVE_CONFIG_NAME=planner`, and give Pulumi credentials with `GOOGLE_OAUTH_ACCESS_TOKEN=$(CLOUDSDK_ACTIVE_CONFIG_NAME=planner gcloud auth print-access-token)` rather than `gcloud auth application-default login` (that would replace his machine-wide work credentials).
- Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only on the free plan. From a Mac without IPv6, or from Cloud Run, use the **Session pooler** connection string (Supabase → Connect; `postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`); `set local role` works on it. Local run against the dev project: `set -a; source .env; set +a; DATABASE_URL=$DEV_DATABASE_URL SUPABASE_URL=https://dfdwcpcwdxpuikjtmxci.supabase.co pnpm dev`.
- PowerSync uses the Sync Streams format (`config: edition: 3`, `streams:`, `auth.user_id()`), not the older `bucket_definitions`. `powersync/sync-rules.yaml` is the source of truth; paste it into the dashboard for each instance.
- Supabase CLI v3 targets the local stack by default: cloud commands need `--remote` (e.g. `pnpm exec supabase db push --remote`). Linked dev project: `planner-dev` (ref `dfdwcpcwdxpuikjtmxci`, URL `https://dfdwcpcwdxpuikjtmxci.supabase.co`). PowerSync dev instance: `https://6af7ca52e5558a7422b9db59.powersync.journeyapps.com`. Load `.env` first (`set -a; source .env; set +a`) so `SUPABASE_DB_PASSWORD` is set.
- Tests need `pnpm db:start` running; `test/setup-env.ts` reads URLs and keys from `supabase status`.
- Local Supabase (CLI v3) signs access tokens with ES256, checked via its JWKS like cloud projects. `SUPABASE_JWT_SECRET` only matters for legacy HS256 tokens.
- `asUser` switches to role `authenticated` inside the transaction: queries there see only the user's rows. The plain `db` client bypasses RLS (as `postgres`), so use it only for server-side work.
- `sync-retry.test.ts` mocks `asUser`: keep it in its own file.
