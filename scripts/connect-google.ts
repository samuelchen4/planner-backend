/**
 * Connect a real Google account to a real Planner account on the dev project, before the app has a
 * Calendars screen. One command, nothing else running:
 *
 *   pnpm exec tsx --env-file=.env scripts/connect-google.ts <planner account email>
 *
 * Needs in .env: SUPABASE_PROJECT_REF, SUPABASE_SECRET_KEY, DEV_DATABASE_URL, GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, CALENDAR_CREDENTIALS_KEY (the same key Cloud Run will need later, or the
 * stored login can't be read there).
 *
 * Serves the API on :8787 (Google's redirect URI for this client) against the dev database, signs
 * in as that Planner user via the admin API, prints Google's consent URL, then prints the calendars
 * and event counts once the first sync lands. Event titles aren't printed.
 */
const email = process.argv[2];
if (!email) throw new Error('Usage: connect-google.ts <planner account email> [deployed API URL]');
// With a URL, the deployed API handles the connect (its callback must be in the OAuth client);
// without one, the API is served here on :8787.
const remoteApi = process.argv[3]?.replace(/\/$/, '');
const API = remoteApi ?? 'http://localhost:8787';
const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing from .env`);
  return v;
};

const supabase = `https://${need('SUPABASE_PROJECT_REF')}.supabase.co`;
const secretKey = need('SUPABASE_SECRET_KEY');
process.env.DATABASE_URL = need('DEV_DATABASE_URL');
process.env.SUPABASE_URL = supabase;
process.env.CALENDAR_PUBLIC_URL = 'http://localhost:8787';
need('GOOGLE_CLIENT_ID');
need('CALENDAR_CREDENTIALS_KEY');

// Env is read at import time, so the app comes in after the overrides above.
const { client } = await import('../src/db/client');
let server: { close(): void } | undefined;
if (!remoteApi) {
  const { serve } = await import('@hono/node-server');
  const { app } = await import('../src/app');
  server = serve({ fetch: app.fetch, port: 8787 });
}

async function admin<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${supabase}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { msg?: string; message?: string };
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${json.msg ?? json.message}`);
  return json;
}

// A session for the existing user, without their password or Apple: mint a one-time sign-in link
// and redeem it straight away.
const link = await admin<{ hashed_token?: string; properties?: { hashed_token: string } }>(
  'admin/generate_link',
  { type: 'magiclink', email },
);
const token_hash = link.properties?.hashed_token ?? link.hashed_token;
const session = await admin<{ access_token: string; user: { id: string } }>('verify', {
  type: 'magiclink',
  token_hash,
});

const started = await fetch(`${API}/integrations/google/start`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ returnScheme: 'planner-local' }),
});
const { url, error } = (await started.json()) as { url?: string; error?: string };
if (!url) throw new Error(`Start failed (${started.status}): ${error}`);

console.log(`\nOpen this in a browser on this Mac and connect a Google account:\n\n${url}\n`);
console.log(
  'Afterwards the browser tries to open planner-local://… (the app). If nothing opens, that is fine.\n',
);

const deadline = Date.now() + 5 * 60_000;
const since = new Date().toISOString();
let accountId: string | undefined;
while (!accountId && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  [{ id: accountId } = { id: undefined }] = await client<{ id: string }[]>`
    select id from calendar_accounts
    where user_id = ${session.user.id} and updated_at >= ${since}
    order by updated_at desc limit 1`;
}
if (accountId) {
  await new Promise((r) => setTimeout(r, 8000)); // let the first sync finish
  const [account] =
    await client`select provider, email, status, scopes from calendar_accounts where id = ${accountId}`;
  const rows = await client`
    select c.name, c.is_primary, c.is_selected, c.access_role,
           (select count(*)::int from external_events e where e.calendar_id = c.id) as events,
           (select count(*)::int from external_events e
              where e.calendar_id = c.id and e.all_day_start is not null) as all_day,
           s.last_synced_at, s.last_error, (s.cursor is not null) as has_cursor
    from calendars c left join calendar_sync_state s on s.calendar_id = c.id
    where c.account_id = ${accountId} order by c.is_primary desc, c.name`;
  console.log('Account:', account);
  console.table(rows);
} else {
  console.log('No account connected within 5 minutes.');
}
server?.close();
await client.end({ timeout: 5 });
process.exit(accountId ? 0 : 1);
