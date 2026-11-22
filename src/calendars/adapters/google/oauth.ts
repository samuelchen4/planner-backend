import { calendarEnv } from '../../env';
import {
  NeedsReconnect,
  type ConnectedAccount,
  type Credentials,
  type Feature,
} from '../../provider';

// Google sign-in for calendar access (OAuth 2.0 web flow, offline access).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const CALENDAR = 'https://www.googleapis.com/auth/calendar';

/** Scopes per feature; consent asks only for the features being turned on. */
export const SCOPES: Record<Feature, string[]> = {
  read: ['openid', 'email', `${CALENDAR}.readonly`],
  pushTasks: [`${CALENDAR}.app.created`, `${CALENDAR}.calendarlist.readonly`],
  editEvents: [`${CALENDAR}.events`],
};

function client() {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = calendarEnv();
  if (!id || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set');
  return { id, secret };
}

interface GoogleCredentials {
  refreshToken: string;
}

export function authUrl(input: { state: string; redirectUri: string; features: Feature[] }) {
  const scopes = [...new Set(input.features.flatMap((f) => SCOPES[f]))];
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: client().id,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    // Always show consent, so Google always returns a refresh token (it omits it on re-consent).
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  })}`;
}

async function tokenRequest(params: Record<string, string>) {
  const { id, secret } = client();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
}): Promise<ConnectedAccount> {
  const { ok, status, body } = await tokenRequest({
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!ok) throw new Error(`Google code exchange failed (${status}): ${String(body.error)}`);
  if (typeof body.refresh_token !== 'string') throw new Error('Google returned no refresh token');
  if (typeof body.id_token !== 'string') throw new Error('Google returned no id token');
  // Straight from Google's token endpoint over TLS, so the id token's claims can be read as-is.
  const claims = JSON.parse(
    Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { sub?: string; email?: string };
  if (!claims.sub || !claims.email) throw new Error('Google id token has no sub/email');
  const credentials: GoogleCredentials = { refreshToken: body.refresh_token };
  return {
    providerAccountId: claims.sub,
    email: claims.email,
    scopes: String(body.scope ?? '')
      .split(' ')
      .filter(Boolean),
    credentials: { ...credentials },
  };
}

export async function accessToken(credentials: Credentials): Promise<{ token: string }> {
  const { refreshToken } = credentials as unknown as GoogleCredentials;
  const { ok, status, body } = await tokenRequest({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  // invalid_grant: revoked by the user, expired (7 days while the app is in Testing), or the
  // password changed. Only reconnecting fixes it.
  if (body.error === 'invalid_grant')
    throw new NeedsReconnect(String(body.error_description ?? ''));
  if (!ok || typeof body.access_token !== 'string') {
    throw new Error(`Google token refresh failed (${status}): ${String(body.error)}`);
  }
  return { token: body.access_token };
}

/** Best effort: the account is deleted on our side either way. */
export async function revoke(credentials: Credentials): Promise<void> {
  const { refreshToken } = credentials as unknown as GoogleCredentials;
  await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken })}`, {
    method: 'POST',
  }).catch(() => undefined);
}
