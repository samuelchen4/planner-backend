CREATE TABLE "external_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"calendar_id" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"location" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"time_zone" text,
	"all_day_start" date,
	"all_day_end" date,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_events_provider_check" CHECK ("external_events"."provider" in ('google')),
	CONSTRAINT "external_events_status_check" CHECK ("external_events"."status" in ('confirmed', 'tentative', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "external_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "habit_days" (
	"id" text PRIMARY KEY NOT NULL,
	"habit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"done_at" timestamp with time zone,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "habit_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'task' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"notes" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"time_zone" text,
	"all_day_date" date,
	"rrule" text,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"list_id" uuid,
	"color" text,
	"icon" text,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_type_check" CHECK ("tasks"."type" in ('task', 'time_block', 'list', 'habit')),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('open', 'done', 'cancelled')),
	CONSTRAINT "tasks_color_check" CHECK ("tasks"."color" in ('yellow', 'pink', 'blue', 'orange', 'lavender'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_days" ADD CONSTRAINT "habit_days_habit_id_tasks_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_days" ADD CONSTRAINT "habit_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_id_tasks_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_events_source_idx" ON "external_events" USING btree ("provider","calendar_id","external_id");--> statement-breakpoint
CREATE INDEX "external_events_user_idx" ON "external_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_days_habit_date_idx" ON "habit_days" USING btree ("habit_id","date");--> statement-breakpoint
CREATE INDEX "habit_days_user_idx" ON "habit_days" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_list_idx" ON "tasks" USING btree ("list_id");--> statement-breakpoint
CREATE POLICY "external_events_read_own_rows" ON "external_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("external_events"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "habit_days_own_rows" ON "habit_days" AS PERMISSIVE FOR ALL TO "authenticated" USING ("habit_days"."user_id" = (select auth.uid())) WITH CHECK ("habit_days"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tasks_own_rows" ON "tasks" AS PERMISSIVE FOR ALL TO "authenticated" USING ("tasks"."user_id" = (select auth.uid())) WITH CHECK ("tasks"."user_id" = (select auth.uid()));