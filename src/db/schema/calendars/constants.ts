/** Calendar providers with an adapter in src/calendars/adapters/. Adding one: a value here + a folder there. */
export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export type CalendarProviderId = (typeof CALENDAR_PROVIDERS)[number];

export const ACCOUNT_STATUSES = ['active', 'needs_reconnect', 'revoked'] as const;

/** What the user may do in a calendar (phase 3 edits need owner or writer). */
export const ACCESS_ROLES = ['owner', 'writer', 'reader', 'freeBusyReader'] as const;

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;

/** Two-way state of a mirrored event or a pushed task (always 'synced' until phase 2/3). */
export const PUSH_STATES = ['synced', 'pending', 'conflict'] as const;
