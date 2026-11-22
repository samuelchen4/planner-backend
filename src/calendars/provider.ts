import type { CalendarProviderId } from '../db/schema';

// The contract every calendar provider implements (adapters/<provider>/). The engine, routes,
// tables and app never branch on the provider: they call these methods and check `capabilities`.

/** Features that need their own scopes; adapters map them to provider scopes. */
export type Feature = 'read' | 'pushTasks' | 'editEvents';

/** Opaque per-provider login (refresh token etc.); stored encrypted in calendar_credentials. */
export type Credentials = Record<string, unknown>;

export interface ConnectedAccount {
  providerAccountId: string;
  email: string;
  scopes: string[];
  credentials: Credentials;
}

export interface ProviderCalendar {
  id: string;
  name: string;
  /** Hex colour, e.g. '#4285F4'. */
  color: string | null;
  isPrimary: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
}

/** One event in the neutral shape (the external_events columns). */
export interface ProviderEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** Timed events: ISO instants, plus the event's IANA zone. */
  startAt: string | null;
  endAt: string | null;
  timeZone: string | null;
  /** All-day events: 'YYYY-MM-DD', end exclusive. */
  allDayStart: string | null;
  allDayEnd: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  seriesId: string | null;
  originalStartAt: string | null;
  webLink: string | null;
  /** The provider's version (etag). */
  version: string | null;
  updatedAt: string | null;
}

/** Calendar the engine syncs: the provider's id plus where its cursor window is. */
export interface CalendarRef {
  providerCalendarId: string;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface SyncResult {
  upserts: ProviderEvent[];
  /** Provider event ids that were deleted or cancelled. */
  deletes: string[];
  cursor: string;
  /** Set on a full sync: the date window the new cursor covers (end null = open-ended). */
  window?: { start: string; end: string | null };
}

export interface Subscription {
  id: string;
  resourceId: string | null;
  secret: string;
  expiresAt: string;
}

export type WebhookResult =
  /** Reply to a provider handshake (Graph validationToken) as-is. */
  | { kind: 'handshake'; body: string }
  /** A change ping: the engine finds the calendar by subscription and checks the secret. */
  | { kind: 'change'; subscriptionId: string; secret: string | null }
  /** Nothing to do (e.g. Google's initial 'sync' ping). */
  | { kind: 'ignore' }
  | { kind: 'invalid' };

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
}

/** Fields phase 2/3 send to a provider. */
export type EventInput = Pick<
  ProviderEvent,
  | 'title'
  | 'description'
  | 'location'
  | 'startAt'
  | 'endAt'
  | 'timeZone'
  | 'allDayStart'
  | 'allDayEnd'
> & {
  /** Phase 2: tags the event with the task it came from. */
  plannerTaskId?: string;
};

export interface CalendarProvider {
  id: CalendarProviderId;
  capabilities: { webhooks: boolean; pushTasks: boolean; editEvents: boolean };

  // Connecting
  authUrl(input: { state: string; redirectUri: string; features: Feature[] }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<ConnectedAccount>;
  /** A fresh access token. Throws NeedsReconnect when the login was revoked or expired. */
  accessToken(credentials: Credentials): Promise<{ token: string; credentials?: Credentials }>;
  revoke(credentials: Credentials): Promise<void>;

  // Reading
  listCalendars(token: string): Promise<ProviderCalendar[]>;
  /** Changes since `cursor` (null = full sync). Throws CursorExpired when it's too old. */
  syncEvents(token: string, calendar: CalendarRef, cursor: string | null): Promise<SyncResult>;

  // Live updates
  subscribe(
    token: string,
    calendar: CalendarRef,
    input: { callbackUrl: string; secret: string },
  ): Promise<Subscription>;
  renew(token: string, calendar: CalendarRef, subscription: Subscription): Promise<Subscription>;
  unsubscribe(token: string, subscription: Subscription): Promise<void>;
  parseWebhook(req: WebhookRequest): WebhookResult;

  // Two-way (phase 2/3; adapters throw NotImplemented until then)
  createOwnCalendar(token: string, name: string): Promise<ProviderCalendar>;
  createEvent(
    token: string,
    calendarId: string,
    event: EventInput,
  ): Promise<{ id: string; version: string | null }>;
  /** Throws VersionConflict when the event changed at the provider since `ifVersion`. */
  updateEvent(
    token: string,
    calendarId: string,
    eventId: string,
    patch: Partial<EventInput>,
    ifVersion: string | null,
  ): Promise<{ version: string | null }>;
  deleteEvent(token: string, calendarId: string, eventId: string): Promise<void>;
}

// ─── Errors adapters throw; the engine handles them the same for every provider ────────────────

export class NeedsReconnect extends Error {
  constructor(message = 'The account needs to be reconnected') {
    super(message);
    this.name = 'NeedsReconnect';
  }
}

export class CursorExpired extends Error {
  constructor(message = 'Sync cursor expired; a full sync is needed') {
    super(message);
    this.name = 'CursorExpired';
  }
}

export class VersionConflict extends Error {
  constructor(message = 'The event changed at the provider') {
    super(message);
    this.name = 'VersionConflict';
  }
}

export class RateLimited extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Rate limited by the provider',
  ) {
    super(message);
    this.name = 'RateLimited';
  }
}

/** The calendar no longer exists at the provider (deleted, or access removed). */
export class CalendarNotFound extends Error {
  constructor(message = 'The calendar is gone at the provider') {
    super(message);
    this.name = 'CalendarNotFound';
  }
}

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} isn't implemented yet`);
    this.name = 'NotImplemented';
  }
}
