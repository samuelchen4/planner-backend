-- Clients may only switch a calendar on or off: of the calendars columns, `authenticated` can
-- update is_selected alone (RLS limits it to their own rows). Everything else in the calendar
-- tables is written by the backend's calendar module, which connects as the owner role.
REVOKE UPDATE ON "calendars" FROM "authenticated";--> statement-breakpoint
GRANT UPDATE ("is_selected") ON "calendars" TO "authenticated";--> statement-breakpoint

-- Stream the display tables to devices. Server-only tables (calendar_credentials,
-- calendar_sync_state, task_calendar_links) are deliberately left out.
ALTER PUBLICATION powersync ADD TABLE "calendar_accounts", "calendars";
