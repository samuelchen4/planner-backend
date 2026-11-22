import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../db/client';
import { calendars } from '../../db/schema';
import { withAccess } from './accounts';
import { enqueueCalendarJob } from './jobs';

/**
 * Match an account's calendars to the provider's list: new ones are added (the primary calendar
 * switched on the first time), names/colours/roles refreshed, and calendars that disappeared
 * removed with their events. Newly switched-on calendars get a selection job (first full sync).
 */
export async function syncCalendarList(accountId: string) {
  const listed = await withAccess(accountId, (token, provider) => provider.listCalendars(token));
  if (!listed) return;

  const switchedOn = await db.transaction(async (tx) => {
    const existing = await tx.select().from(calendars).where(eq(calendars.account_id, accountId));
    const [account] = await tx.execute<{ user_id: string }>(
      sql`select user_id from calendar_accounts where id = ${accountId}`,
    );
    if (!account) return [];
    const byProviderId = new Map(existing.map((c) => [c.provider_calendar_id, c]));
    const firstImport = existing.length === 0;
    const added: string[] = [];

    for (const cal of listed) {
      const current = byProviderId.get(cal.id);
      if (!current) {
        const selected = firstImport && cal.isPrimary;
        const [row] = await tx
          .insert(calendars)
          .values({
            user_id: account.user_id,
            account_id: accountId,
            provider_calendar_id: cal.id,
            name: cal.name,
            color: cal.color,
            is_primary: cal.isPrimary,
            access_role: cal.accessRole,
            is_selected: selected,
          })
          .returning({ id: calendars.id });
        if (selected) added.push(row!.id);
      } else if (
        current.name !== cal.name ||
        current.color !== cal.color ||
        current.is_primary !== cal.isPrimary ||
        current.access_role !== cal.accessRole
      ) {
        await tx
          .update(calendars)
          .set({
            name: cal.name,
            color: cal.color,
            is_primary: cal.isPrimary,
            access_role: cal.accessRole,
            updated_at: sql`now()`,
          })
          .where(eq(calendars.id, current.id));
      }
    }

    const listedIds = new Set(listed.map((c) => c.id));
    const gone = existing
      .filter((c) => !listedIds.has(c.provider_calendar_id) && !c.is_planner_calendar)
      .map((c) => c.id);
    if (gone.length) {
      await tx
        .delete(calendars)
        .where(and(eq(calendars.account_id, accountId), inArray(calendars.id, gone)));
    }
    return added;
  });

  for (const calendarId of switchedOn) {
    await enqueueCalendarJob({ type: 'calendar-selection-changed', calendarId });
  }
}
