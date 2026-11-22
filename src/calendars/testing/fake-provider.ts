import { randomUUID } from 'node:crypto';

import type { CalendarProviderId } from '../../db/schema';
import {
  CursorExpired,
  NeedsReconnect,
  RateLimited,
  VersionConflict,
  type CalendarProvider,
  type EventInput,
  type ProviderCalendar,
  type ProviderEvent,
  type Subscription,
} from '../provider';

/**
 * An in-memory calendar provider for engine tests: calendars, events and a change log per
 * calendar (the cursor is a position in it). Tests change events through `change`/`remove`, and
 * can make the next call fail (`failNext`) to exercise cursor expiry, revoked logins, rate limits
 * and conflicts. Lives in src/ (not test/) so it moves with the module.
 */
export class FakeProvider implements CalendarProvider {
  readonly capabilities = { webhooks: true, pushTasks: true, editEvents: true };

  calendars: ProviderCalendar[] = [];
  private events = new Map<string, Map<string, ProviderEvent>>();
  private log = new Map<string, { id: string; deleted: boolean }[]>();
  /** Calls made, for assertions: e.g. ['listCalendars', 'syncEvents:cal-1:null']. */
  calls: string[] = [];
  revoked = false;
  private nextFailure: Error | null = null;
  private versionCounter = 0;

  constructor(readonly id: CalendarProviderId = 'google') {}

  // ─── Test controls ────────────────────────────────────────────────────────────────────────

  addCalendar(calendar: Partial<ProviderCalendar> & { id: string }) {
    this.calendars.push({
      name: calendar.id,
      color: '#4285F4',
      isPrimary: false,
      accessRole: 'owner',
      ...calendar,
    });
    this.events.set(calendar.id, new Map());
    this.log.set(calendar.id, []);
  }

  /** Add or edit an event (gets a new version), as if changed at the provider. */
  change(calendarId: string, event: Partial<ProviderEvent> & { id: string }) {
    const current = this.events.get(calendarId)?.get(event.id);
    const next: ProviderEvent = {
      title: '',
      description: null,
      location: null,
      startAt: null,
      endAt: null,
      timeZone: null,
      allDayStart: null,
      allDayEnd: null,
      status: 'confirmed',
      seriesId: null,
      originalStartAt: null,
      webLink: null,
      updatedAt: new Date().toISOString(),
      ...current,
      ...event,
      version: `v${++this.versionCounter}`,
    };
    this.events.get(calendarId)!.set(event.id, next);
    this.log.get(calendarId)!.push({ id: event.id, deleted: false });
    return next;
  }

  remove(calendarId: string, eventId: string) {
    this.events.get(calendarId)!.delete(eventId);
    this.log.get(calendarId)!.push({ id: eventId, deleted: true });
  }

  /** Make the next provider call throw (CursorExpired, NeedsReconnect, RateLimited, …). */
  failNext(error: Error) {
    this.nextFailure = error;
  }

  private call(name: string) {
    this.calls.push(name);
    const failure = this.nextFailure;
    this.nextFailure = null;
    if (failure) throw failure;
  }

  // ─── CalendarProvider ─────────────────────────────────────────────────────────────────────

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    return `https://fake.example/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchangeCode({ code }: { code: string }) {
    this.call('exchangeCode');
    return {
      providerAccountId: `acct-${code}`,
      email: `${code}@example.com`,
      scopes: ['read'],
      credentials: { refreshToken: `refresh-${code}` },
    };
  }

  async accessToken() {
    this.call('accessToken');
    if (this.revoked) throw new NeedsReconnect();
    return { token: 'fake-access-token' };
  }

  async revoke() {
    this.call('revoke');
    this.revoked = true;
  }

  async listCalendars() {
    this.call('listCalendars');
    return this.calendars.map((c) => ({ ...c }));
  }

  async syncEvents(
    _token: string,
    calendar: { providerCalendarId: string },
    cursor: string | null,
  ) {
    const id = calendar.providerCalendarId;
    this.call(`syncEvents:${id}:${cursor}`);
    const log = this.log.get(id) ?? [];
    const events = this.events.get(id) ?? new Map<string, ProviderEvent>();
    if (cursor === null) {
      return { upserts: [...events.values()], deletes: [], cursor: String(log.length) };
    }
    const from = Number(cursor);
    if (!Number.isInteger(from) || from > log.length) throw new CursorExpired();
    const touched = new Map(log.slice(from).map((e) => [e.id, e.deleted]));
    const upserts: ProviderEvent[] = [];
    const deletes: string[] = [];
    for (const [eventId, deleted] of touched) {
      const event = events.get(eventId);
      if (deleted || !event || event.status === 'cancelled') deletes.push(eventId);
      else upserts.push(event);
    }
    return { upserts, deletes, cursor: String(log.length) };
  }

  /** Live subscriptions by id (stopped ones are removed), for assertions. */
  subscriptions = new Map<string, Subscription & { calendarId: string; callbackUrl: string }>();

  async subscribe(
    _token: string,
    calendar: { providerCalendarId: string },
    input: { callbackUrl: string; secret: string },
  ) {
    this.call(`subscribe:${calendar.providerCalendarId}`);
    return this.newSubscription(calendar.providerCalendarId, input);
  }

  /** Like Google: a new subscription replaces the old one. */
  async renew(
    _token: string,
    calendar: { providerCalendarId: string },
    _old: Subscription,
    input: { callbackUrl: string; secret: string },
  ) {
    this.call(`renew:${calendar.providerCalendarId}`);
    return this.newSubscription(calendar.providerCalendarId, input);
  }

  async unsubscribe(_token: string, subscription: Subscription) {
    this.call(`unsubscribe:${subscription.id}`);
    this.subscriptions.delete(subscription.id);
  }

  private newSubscription(
    calendarId: string,
    input: { callbackUrl: string; secret: string },
  ): Subscription {
    const subscription = {
      id: randomUUID(),
      resourceId: `resource-${calendarId}`,
      secret: input.secret,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    };
    this.subscriptions.set(subscription.id, { ...subscription, calendarId, ...input });
    return subscription;
  }

  parseWebhook(req: { headers: Record<string, string | undefined> }) {
    const subscriptionId = req.headers['x-fake-subscription'];
    if (!subscriptionId) return { kind: 'invalid' as const };
    return {
      kind: 'change' as const,
      subscriptionId,
      secret: req.headers['x-fake-secret'] ?? null,
    };
  }

  async createOwnCalendar(_token: string, name: string) {
    this.call('createOwnCalendar');
    const id = `planner-${randomUUID()}`;
    this.addCalendar({ id, name, accessRole: 'owner' });
    return this.calendars.at(-1)!;
  }

  async createEvent(_token: string, calendarId: string, event: EventInput) {
    this.call(`createEvent:${calendarId}`);
    const created = this.change(calendarId, { id: randomUUID(), ...event });
    return { id: created.id, version: created.version };
  }

  async updateEvent(
    _token: string,
    calendarId: string,
    eventId: string,
    patch: Partial<EventInput>,
    ifVersion: string | null,
  ) {
    this.call(`updateEvent:${calendarId}:${eventId}`);
    const current = this.events.get(calendarId)?.get(eventId);
    if (!current) throw new Error(`No event ${eventId}`);
    if (ifVersion !== null && current.version !== ifVersion) throw new VersionConflict();
    return { version: this.change(calendarId, { ...patch, id: eventId }).version };
  }

  async deleteEvent(_token: string, calendarId: string, eventId: string) {
    this.call(`deleteEvent:${calendarId}:${eventId}`);
    this.remove(calendarId, eventId);
  }
}

export { CursorExpired, NeedsReconnect, RateLimited, VersionConflict };
