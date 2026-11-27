/**
 * Step 8.1 of the calendar plan: probe Microsoft Graph with a real Outlook account before building
 * the adapter. Run: pnpm exec tsx --env-file=.env scripts/microsoft-spike.ts
 *
 * Opens a one-off read-only consent (redirect http://localhost:8787/integrations/microsoft/callback),
 * checks sign-in, refresh-token rotation, the calendar list and calendarView delta sync, then
 * watches for changes for a few minutes so you can edit events in Outlook. Logs counts and shapes
 * only (no titles), and never stores tokens. Subscriptions need a public HTTPS endpoint, so they're
 * tried later against the deployed API.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const REDIRECT = 'http://localhost:8787/integrations/microsoft/callback';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'openid email offline_access User.Read Calendars.Read';
const WATCH_MINUTES = Number(process.env.WATCH_MINUTES ?? 3);

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET missing from .env');
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const claims = (jwt?: string) =>
  jwt
    ? (JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<
        string,
        unknown
      >)
    : {};

// ─── 1. Consent ──────────────────────────────────────────────────────────────────────────────

const state = randomBytes(16).toString('hex');
const authUrl =
  `${AUTHORITY}/authorize?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES,
    prompt: 'select_account',
    state,
  });

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost:8787');
    if (url.pathname !== '/integrations/microsoft/callback') return res.writeHead(404).end();
    const got = url.searchParams.get('code');
    const ok = got && url.searchParams.get('state') === state;
    const why = `${url.searchParams.get('error')}: ${url.searchParams.get('error_description')}`;
    res
      .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' })
      .end(ok ? 'Connected. You can close this tab.' : `Failed: ${why}`);
    server.close();
    if (ok) resolve(got);
    else reject(new Error(`Consent failed: ${why}`));
  });
  server.listen(8787, () => {
    log('Open this URL and sign in with the Outlook account:\n\n' + authUrl + '\n');
  });
});

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function token(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: SCOPES,
      ...params,
    }),
  });
  return (await res.json()) as TokenResponse;
}

const first = await token({ code, redirect_uri: REDIRECT, grant_type: 'authorization_code' });
if (!first.access_token) throw new Error(`Token exchange failed: ${first.error}`);
const id = claims(first.id_token);
log('Token exchange:', {
  gotRefreshToken: Boolean(first.refresh_token),
  expiresInSeconds: first.expires_in,
  grantedScopes: first.scope?.split(' '),
  idToken: {
    hasOid: typeof id.oid === 'string',
    hasSub: typeof id.sub === 'string',
    tidIsPersonalAccounts: id.tid === '9188040d-6c67-4c5b-b112-36a304b66dad',
    hasEmail: typeof id.email === 'string',
    hasPreferredUsername: typeof id.preferred_username === 'string',
  },
});

const refreshed = await token({ refresh_token: first.refresh_token!, grant_type: 'refresh_token' });
log('Refresh:', {
  ok: Boolean(refreshed.access_token),
  error: refreshed.error,
  newRefreshTokenReturned: Boolean(refreshed.refresh_token),
  refreshTokenRotated:
    Boolean(refreshed.refresh_token) && refreshed.refresh_token !== first.refresh_token,
});
const oldStillWorks = await token({
  refresh_token: first.refresh_token!,
  grant_type: 'refresh_token',
});
log('Old refresh token after rotation:', {
  stillWorks: Boolean(oldStillWorks.access_token),
  error: oldStillWorks.error,
});
const access = refreshed.access_token ?? first.access_token;

// ─── 2. Graph helpers ────────────────────────────────────────────────────────────────────────

async function graph(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    headers: { Authorization: `Bearer ${access}`, ...headers },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

interface GEvent {
  id: string;
  '@removed'?: { reason: string };
  '@odata.etag'?: string;
  changeKey?: string;
  type?: string;
  seriesMasterId?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  originalStartTimeZone?: string;
  webLink?: string;
  lastModifiedDateTime?: string;
  responseStatus?: { response: string };
}

const PREFER = { Prefer: 'odata.maxpagesize=200, outlook.timezone="UTC"' };

/** Every page of a delta round; returns the items and the deltaLink to resume from. */
async function deltaAll(url: string) {
  const items: GEvent[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next) {
    const r = await graph(next, PREFER);
    if (r.status !== 200) return { status: r.status, error: r.body?.error, items, pages };
    pages++;
    items.push(...((r.body?.value as GEvent[]) ?? []));
    const deltaLink = r.body?.['@odata.deltaLink'] as string | undefined;
    next = r.body?.['@odata.nextLink'] as string | undefined;
    if (!next) return { status: 200, items, pages, deltaLink };
  }
  return { status: 200, items, pages };
}

const shape = (e: GEvent) => ({
  id: e.id.slice(-8),
  removed: e['@removed']?.reason,
  type: e.type,
  allDay: e.isAllDay,
  cancelled: e.isCancelled,
  showAs: e.showAs,
  start: e.start?.dateTime?.slice(0, 19),
  startZone: e.start?.timeZone,
  originalZone: e.originalStartTimeZone,
  hasEtag: Boolean(e['@odata.etag']),
  hasWebLink: Boolean(e.webLink),
  hasSeriesMaster: Boolean(e.seriesMasterId),
});

// ─── 3. Probes ───────────────────────────────────────────────────────────────────────────────

const me = await graph('/me?$select=id,mail,userPrincipalName');
log('/me:', {
  status: me.status,
  idMatchesOid: me.body?.id === id.oid,
  hasMail: Boolean(me.body?.mail),
  hasUpn: Boolean(me.body?.userPrincipalName),
});

const cals = await graph('/me/calendars?$top=100');
const calendars = (cals.body?.value as Record<string, unknown>[]) ?? [];
log('Calendars:', {
  status: cals.status,
  count: calendars.length,
  defaultCount: calendars.filter((c) => c.isDefaultCalendar).length,
  colors: calendars.map((c) => ({ color: c.color, hexColor: c.hexColor })),
  canEdit: calendars.map((c) => c.canEdit),
  ownerMatches: calendars.map(
    (c) => (c.owner as { address?: string } | undefined)?.address === me.body?.mail,
  ),
});
const primary = calendars.find((c) => c.isDefaultCalendar) ?? calendars[0];
if (!primary) throw new Error('No calendars');
const calId = encodeURIComponent(String(primary.id));

const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const end = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
const full = await deltaAll(
  `/me/calendars/${calId}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`,
);
log('Full delta (30 days back → 1 year ahead), primary calendar:', {
  status: full.status,
  error: full.error,
  pages: full.pages,
  events: full.items.length,
  types: Object.entries(
    full.items.reduce<Record<string, number>>((acc, e) => {
      const k = `${e.type}${e.isAllDay ? ' all-day' : ''}${e.isCancelled ? ' cancelled' : ''}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ),
  gotDeltaLink: Boolean(full.deltaLink),
  sample: full.items.slice(0, 3).map(shape),
});

// Does the delta response carry the fields we need, or only ids (Graph's delta can be sparse)?
const sampleFull = full.items[0];
if (sampleFull) log('Fields on a delta item:', Object.keys(sampleFull).sort());

let deltaLink = full.deltaLink;
if (deltaLink) {
  const again = await deltaAll(deltaLink);
  log('Incremental right away (expect nothing):', {
    status: again.status,
    items: again.items.length,
    gotDeltaLink: Boolean(again.deltaLink),
  });
  const broken = deltaLink.replace(/(\$deltatoken=)[^&]+/, '$1garbage');
  const bad = await graph(broken, PREFER);
  log('Bad deltatoken:', { status: bad.status, error: bad.body?.error });
}
const noWindow = await graph(`/me/calendars/${calId}/calendarView/delta`, PREFER);
log('Delta without a window:', { status: noWindow.status, error: noWindow.body?.error });

// ─── 4. Watch for real changes ──────────────────────────────────────────────────────────────

if (deltaLink) {
  log(
    `Watching for ${WATCH_MINUTES} min. In Outlook (default calendar), try: create an event, an all-day event, move one, delete one, edit one occurrence of a repeating event.`,
  );
  const until = Date.now() + WATCH_MINUTES * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10_000));
    const changes = await deltaAll(deltaLink);
    if (changes.status !== 200) {
      log('Incremental failed:', changes.status, changes.error);
      break;
    }
    if (changes.items.length) log('Changes:', changes.items.map(shape));
    deltaLink = changes.deltaLink ?? deltaLink;
  }
}
log('Done.');
