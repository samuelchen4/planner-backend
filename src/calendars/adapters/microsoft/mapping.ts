import type { ProviderCalendar, ProviderEvent } from '../../provider';
import type { GraphCalendar, GraphDateTime, GraphEvent } from './api';
import { toIanaZone } from './time-zones';

/** Outlook's named calendar colours (when hexColor is empty, as on Outlook.com). */
const NAMED_COLORS: Record<string, string> = {
  lightBlue: '#4F9BD9',
  lightGreen: '#5CB85C',
  lightOrange: '#F0A15A',
  lightGray: '#9AA0A6',
  lightYellow: '#E5C94A',
  lightTeal: '#3FB6B0',
  lightPink: '#E37FB1',
  lightBrown: '#A67C52',
  lightRed: '#E06666',
};

export function toProviderCalendar(c: GraphCalendar): ProviderCalendar {
  return {
    id: c.id,
    name: c.name ?? c.id,
    color: c.hexColor || NAMED_COLORS[c.color ?? ''] || null,
    isPrimary: c.isDefaultCalendar === true,
    accessRole: c.canEdit ? (c.isDefaultCalendar ? 'owner' : 'writer') : 'reader',
  };
}

/** Graph's times come in UTC (Prefer: outlook.timezone="UTC") without a suffix. */
function instant(t: GraphDateTime): string {
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`;
  return new Date(zoned).toISOString();
}

function dateIn(iso: string, zone: string): { date: string; midnight: boolean } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    midnight: parts.hour === '00' && parts.minute === '00',
  };
}

/**
 * An all-day event's day. Graph keeps all-day events at midnight; whether a requested UTC view
 * shifts them depends on the account, so: midnight as given → that date; otherwise the date at
 * midnight in the event's own zone; failing both, the date as given.
 */
function allDayDate(t: GraphDateTime, zone: string | null): string {
  const raw = t.dateTime.slice(0, 10);
  if (/T00:00(:00(\.0+)?)?$/.test(t.dateTime)) return raw;
  if (zone) {
    try {
      const local = dateIn(instant(t), zone);
      if (local.midnight) return local.date;
    } catch {
      // unknown zone in this runtime: fall through
    }
  }
  return raw;
}

/**
 * A Graph event in the neutral shape, or null when Planner doesn't show it: removed, cancelled,
 * a series master (the delta view lists occurrences instead), or without times.
 */
export function toProviderEvent(e: GraphEvent): ProviderEvent | null {
  if (e['@removed'] || e.isCancelled || e.type === 'seriesMaster') return null;
  if (!e.start?.dateTime || !e.end?.dateTime) return null;
  const zone = toIanaZone(e.originalStartTimeZone);
  const allDay = e.isAllDay === true;
  const tentative =
    e.showAs === 'tentative' || e.responseStatus?.response === 'tentativelyAccepted';
  const notes = e.body?.contentType === 'text' ? e.body.content : e.bodyPreview;
  return {
    id: e.id,
    title: e.subject ?? '',
    description: notes?.trim() ? notes.trim() : null,
    location: e.location?.displayName || null,
    startAt: allDay ? null : instant(e.start),
    endAt: allDay ? null : instant(e.end),
    timeZone: allDay ? null : zone,
    allDayStart: allDay ? allDayDate(e.start, zone) : null,
    allDayEnd: allDay ? allDayDate(e.end, zone) : null,
    status: tentative ? 'tentative' : 'confirmed',
    seriesId: e.seriesMasterId ?? null,
    originalStartAt: e.originalStart ? new Date(e.originalStart).toISOString() : null,
    webLink: e.webLink ?? null,
    version: e['@odata.etag'] ?? e.changeKey ?? null,
    updatedAt: e.lastModifiedDateTime ? new Date(e.lastModifiedDateTime).toISOString() : null,
  };
}
