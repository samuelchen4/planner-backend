CREATE TABLE "calendar_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_accounts_provider_check" CHECK ("calendar_accounts"."provider" in ('google', 'microsoft')),
	CONSTRAINT "calendar_accounts_status_check" CHECK ("calendar_accounts"."status" in ('active', 'needs_reconnect', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "calendar_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_calendar_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"color" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"access_role" text DEFAULT 'reader' NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"is_planner_calendar" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_access_role_check" CHECK ("calendars"."access_role" in ('owner', 'writer', 'reader', 'freeBusyReader'))
);
--> statement-breakpoint
ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_sync_state" (
	"calendar_id" uuid PRIMARY KEY NOT NULL,
	"cursor" text,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"subscription_id" text,
	"subscription_resource_id" text,
	"subscription_secret" text,
	"subscription_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_calendar_links" (
	"task_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"version" text,
	"push_state" text DEFAULT 'synced' NOT NULL,
	"last_pushed_at" timestamp with time zone,
	CONSTRAINT "task_calendar_links_task_id_calendar_id_pk" PRIMARY KEY("task_id","calendar_id"),
	CONSTRAINT "task_calendar_links_push_state_check" CHECK ("task_calendar_links"."push_state" in ('synced', 'pending', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "task_calendar_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- external_events is a mirror nothing has written yet (and the sync engine can always rebuild it).
-- Emptying it lets calendar_id become a uuid reference and account_id be required.
DELETE FROM "external_events";--> statement-breakpoint
ALTER TABLE "external_events" DROP CONSTRAINT "external_events_provider_check";--> statement-breakpoint
DROP INDEX "external_events_source_idx";--> statement-breakpoint
ALTER TABLE "external_events" ALTER COLUMN "calendar_id" SET DATA TYPE uuid USING "calendar_id"::uuid;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "original_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "web_link" text;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "push_state" text DEFAULT 'synced' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "show_in_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD CONSTRAINT "calendar_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_credentials" ADD CONSTRAINT "calendar_credentials_account_id_calendar_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_account_id_calendar_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_state" ADD CONSTRAINT "calendar_sync_state_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_calendar_links" ADD CONSTRAINT "task_calendar_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_calendar_links" ADD CONSTRAINT "task_calendar_links_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_accounts_identity_idx" ON "calendar_accounts" USING btree ("user_id","provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "calendar_accounts_user_idx" ON "calendar_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_source_idx" ON "calendars" USING btree ("account_id","provider_calendar_id");--> statement-breakpoint
CREATE INDEX "calendars_user_idx" ON "calendars" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_account_id_calendar_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_events_source_idx" ON "external_events" USING btree ("calendar_id","external_id");--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_push_state_check" CHECK ("external_events"."push_state" in ('synced', 'pending', 'conflict'));--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_provider_check" CHECK ("external_events"."provider" in ('google', 'microsoft'));--> statement-breakpoint
CREATE POLICY "calendar_accounts_read_own_rows" ON "calendar_accounts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("calendar_accounts"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "calendars_read_own_rows" ON "calendars" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("calendars"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "calendars_update_own_rows" ON "calendars" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("calendars"."user_id" = (select auth.uid())) WITH CHECK ("calendars"."user_id" = (select auth.uid()));