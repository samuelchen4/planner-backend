-- PowerSync reads Postgres through a replication role. Supabase environments can have more than
-- one (PowerSync's Supabase connection creates `powersync_<id>`; the manual guide uses
-- `powersync_role`), and their names differ per environment, so this finds them by name prefix.
--
-- Each one may read exactly the tables in the `powersync` publication, and nothing server-only.
-- No default privileges: a future table is readable only once a migration grants it here (add it
-- to `synced` when adding it to the publication). No-op where no such role exists (local).
DO $$
DECLARE
  synced text := 'public.tasks, public.habit_days, public.external_events, public.calendar_accounts, public.calendars';
  server_only text := 'public.calendar_credentials, public.calendar_sync_state, public.task_calendar_links';
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolreplication AND rolname LIKE 'powersync%' LOOP
    EXECUTE format('GRANT SELECT ON %s TO %I', synced, r.rolname);
    EXECUTE format('REVOKE ALL ON %s FROM %I', server_only, r.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r.rolname);
  END LOOP;
END $$;
