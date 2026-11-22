import type { ProviderCalendar, ProviderEvent } from '../../provider';
import type { GoogleCalendarListEntry, GoogleEvent, GoogleEventTime } from './api';

/**
 * Event types that aren't shown in Planner: a working location isn't an event, and birthdays
 * come from contacts. (default, fromGmail, focusTime and outOfOffice are kept.)
 */
const SKIPPED_TYPES = new Set(['workingLocation', 'birthday']);

const instant = (iso: string) => new Date(iso).toISOString();

/** An occurrence's original start: an instant, or the day's UTC midnight for all-day ones. */
const originalStart = (t: GoogleEventTime | undefined) =>
  t?.dateTime ? instant(t.dateTime) : t?.date ? `${t.date}T00:00:00.000Z` : null;

/**
 * A Google event in the neutral shape, or null when Planner doesn't show it (cancelled, a skipped
 * type, or no start). `calendarZone` is the calendar's zone, which events in that zone omit.
 */
export function toProviderEvent(e: GoogleEvent, calendarZone: string | null): ProviderEvent | null {
  if (e.status === 'cancelled' || SKIPPED_TYPES.has(e.eventType ?? 'default')) return null;
  const timed = Boolean(e.start?.dateTime && e.end?.dateTime);
  const allDay = Boolean(e.start?.date && e.end?.date);
  if (!timed && !allDay) return null;
  return {
    id: e.id,
    title: e.summary ?? '',
    description: e.description ?? null,
    location: e.location ?? null,
    startAt: timed ? instant(e.start!.dateTime!) : null,
    endAt: timed ? instant(e.end!.dateTime!) : null,
    timeZone: timed ? (e.start?.timeZone ?? calendarZone) : null,
    allDayStart: allDay ? e.start!.date! : null,
    allDayEnd: allDay ? e.end!.date! : null,
    status: e.status === 'tentative' ? 'tentative' : 'confirmed',
    seriesId: e.recurringEventId ?? null,
    originalStartAt: originalStart(e.originalStartTime),
    webLink: e.htmlLink ?? null,
    version: e.etag ?? null,
    updatedAt: e.updated ? instant(e.updated) : null,
  };
}

export function toProviderCalendar(c: GoogleCalendarListEntry): ProviderCalendar {
  return {
    id: c.id,
    name: c.summaryOverride ?? c.summary ?? c.id,
    color: c.backgroundColor ?? null,
    isPrimary: c.primary === true,
    accessRole: c.accessRole,
  };
}
