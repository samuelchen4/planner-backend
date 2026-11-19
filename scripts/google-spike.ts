/**
 * Step 1 of the calendar plan: probe the Google Calendar API with a real account before building
 * the adapter. Run: pnpm exec tsx --env-file=.env scripts/google-spike.ts
 *
 * Opens a one-off read-only consent (redirect http://localhost:8787/integrations/google/callback),
 * then checks how sync behaves, then watches for changes for 3 minutes so you can edit events in
 * Google Calendar. Logs counts and shapes only (no titles), and never stores the token.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT = 'http://localhost:8787/integrations/google/callback';
const API = 'https://www.googleapis.com/calendar/v3';
const WATCH_MINUTES = Number(process.env.WATCH_MINUTES ?? 3);

if (!CLIENT_ID || !CLIENT_SECRET)
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing');

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ─── 1. Consent ──────────────────────────────────────────────────────────────────────────────

const state = randomBytes(16).toString('hex');
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost:8787');
    if (url.pathname !== '/integrations/google/callback') return res.writeHead(404).end();
    const got = url.searchParams.get('code');
    const ok = got && url.searchParams.get('state') === state;
    res
      .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' })
      .end(ok ? 'Connected. You can close this tab.' : `Failed: ${url.searchParams.get('error')}`);
    server.close();
    if (ok) resolve(got);
    else reject(new Error(`Consent failed: ${url.searchParams.get('error')}`));
  });
  server.listen(8787, () => {
    log('Open this URL and allow read-only calendar access:\n\n' + authUrl + '\n');
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const tokens = (await tokenRes.json()) as {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
};
if (!tokens.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
const idClaims = tokens.id_token
  ? (JSON.parse(Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >)
  : {};
log('Token exchange:', {
  gotRefreshToken: Boolean(tokens.refresh_token),
  expiresInSeconds: tokens.expires_in,
  grantedScopes: tokens.scope.split(' '),
  idTokenHasSub: typeof idClaims.sub === 'string',
  idTokenHasEmail: typeof idClaims.email === 'string',
});

// ─── 2. API helpers ──────────────────────────────────────────────────────────────────────────

async function get(path: string, params: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

interface GEvent {
  id: string;
  status?: string;
  etag?: string;
  recurringEventId?: string;
  originalStartTime?: Record<string, string>;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  updated?: string;
  htmlLink?: string;
  attendees?: unknown[];
  eventType?: string;
}

/** All pages of an events.list; returns items, page count and the final sync token. */
async function listAll(calendarId: string, params: Record<string, string>) {
  const items: GEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await get(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      ...params,
      maxResults: '2500',
      ...(pageToken && { pageToken }),
    });
    if (r.status !== 200) return { status: r.status, error: r.body, items, pages };
    pages++;
    items.push(...((r.body?.items as GEvent[]) ?? []));
    pageToken = r.body?.nextPageToken as string | undefined;
    if (!pageToken) {
      return {
        status: 200,
        items,
        pages,
        nextSyncToken: r.body?.nextSyncToken as string | undefined,
      };
    }
  }
}

const shape = (e: GEvent) => ({
  id: e.id.slice(0, 8),
  status: e.status,
  kind: e.start?.dateTime ? 'timed' : e.start?.date ? 'all-day' : 'none',
  recurringInstance: Boolean(e.recurringEventId),
  hasOriginalStart: Boolean(e.originalStartTime),
  startTz: e.start?.timeZone ?? null,
  eventType: e.eventType,
  hasEtag: Boolean(e.etag),
  attendees: e.attendees?.length ?? 0,
});

// ─── 3. Probes ───────────────────────────────────────────────────────────────────────────────

const list = await get('/users/me/calendarList');
const calendars = (list.body?.items as Record<string, unknown>[]) ?? [];
log('calendarList:', {
  status: list.status,
  count: calendars.length,
  roles: calendars.map((c) => c.accessRole),
  primaryCount: calendars.filter((c) => c.primary).length,
  hasHexColors: calendars.every((c) => typeof c.backgroundColor === 'string'),
  selectedInGoogle: calendars.filter((c) => c.selected).length,
});

const cal = 'primary';
const timeMin = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

const windowed = await listAll(cal, { singleEvents: 'true', timeMin });
const instances = windowed.items.filter((e) => e.recurringEventId);
const latest = (es: GEvent[]) =>
  es
    .map((e) => e.start?.dateTime ?? e.start?.date ?? '')
    .sort()
    .at(-1);
log('Full sync with timeMin (30 days back) + singleEvents:', {
  status: windowed.status,
  error: windowed.error,
  pages: windowed.pages,
  events: windowed.items.length,
  recurringInstances: instances.length,
  latestStart: latest(windowed.items),
  latestRecurringInstanceStart: latest(instances),
  gotNextSyncToken: Boolean(windowed.nextSyncToken),
  kinds: Object.entries(
    windowed.items.reduce<Record<string, number>>((acc, e) => {
      const k = `${shape(e).kind}${e.status === 'cancelled' ? ' (cancelled)' : ''}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ),
  eventTypes: [...new Set(windowed.items.map((e) => e.eventType))],
});

const unbounded = await listAll(cal, { singleEvents: 'true' });
log('Full sync without timeMin (for comparison):', {
  status: unbounded.status,
  events: unbounded.items.length,
  earliestStart: unbounded.items
    .map((e) => e.start?.dateTime ?? e.start?.date ?? '')
    .filter(Boolean)
    .sort()[0],
  latestRecurringInstanceStart: latest(unbounded.items.filter((e) => e.recurringEventId)),
});

let syncToken = windowed.nextSyncToken;
if (syncToken) {
  const again = await listAll(cal, { singleEvents: 'true', syncToken });
  log('Incremental right away (expect nothing):', {
    status: again.status,
    items: again.items.length,
    gotNextSyncToken: Boolean(again.nextSyncToken),
  });
  const withTimeMin = await get(`/calendars/${cal}/events`, {
    singleEvents: 'true',
    syncToken,
    timeMin,
  });
  log('syncToken + timeMin together:', { status: withTimeMin.status });
  const withoutSingle = await get(`/calendars/${cal}/events`, { syncToken });
  log('syncToken without singleEvents (params must match the first request?):', {
    status: withoutSingle.status,
  });
}
const bad = await get(`/calendars/${cal}/events`, { singleEvents: 'true', syncToken: 'garbage' });
log('Bad syncToken:', {
  status: bad.status,
  reason: (bad.body?.error as { errors?: { reason: string }[] })?.errors?.[0]?.reason,
});

// ─── 4. Watch for real changes ──────────────────────────────────────────────────────────────

if (syncToken) {
  log(
    `Watching for ${WATCH_MINUTES} min. In Google Calendar (primary calendar), try: create an event, move one, delete one, edit one occurrence of a repeating event.`,
  );
  const end = Date.now() + WATCH_MINUTES * 60_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10_000));
    const changes = await listAll(cal, { singleEvents: 'true', syncToken });
    if (changes.status !== 200) {
      log('Incremental failed:', changes.status, changes.error);
      break;
    }
    if (changes.items.length) log('Changes:', changes.items.map(shape));
    syncToken = changes.nextSyncToken ?? syncToken;
  }
}
log('Done.');
