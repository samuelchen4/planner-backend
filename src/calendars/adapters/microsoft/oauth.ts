import { calendarEnv } from '../../env';
import {
  NeedsReconnect,
  type ConnectedAccount,
  type Credentials,
  type Feature,
} from '../../provider';

// Microsoft identity platform sign-in (OAuth 2.0 web flow) on the "common" endpoint, so both
// personal (Outlook.com) and work/school (Microsoft 365) accounts can connect.

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';

/** Scopes per feature; offline_access gives a refresh token. */
export const SCOPES: Record<Feature, string[]> = {
  read: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.Read'],
  pushTasks: ['Calendars.ReadWrite'],
  editEvents: ['Calendars.ReadWrite'],
};

/** Every token request names scopes; refreshes ask for what the account was granted. */
const scopeString = (features: Feature[]) =>
  [...new Set(features.flatMap((f) => SCOPES[f]))].join(' ');

function client() {
  const { MICROSOFT_CLIENT_ID: id, MICROSOFT_CLIENT_SECRET: secret } = calendarEnv();
  if (!id || !secret) throw new Error('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET are not set');
  return { id, secret };
}

/**
 * What's stored (encrypted). Microsoft rotates the refresh token on every refresh; the old one
 * keeps working for a while (seen in the spike), but the newest is always saved.
 */
interface MicrosoftCredentials {
  refreshToken: string;
  scope: string;
}

export function authUrl(input: { state: string; redirectUri: string; features: Feature[] }) {
  return `${AUTHORITY}/authorize?${new URLSearchParams({
    client_id: client().id,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: scopeString(input.features),
    // Let people pick which Microsoft account to connect (they may have several).
    prompt: 'select_account',
    state: input.state,
  })}`;
}

async function tokenRequest(params: Record<string, string>) {
  const { id, secret } = client();
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

interface IdClaims {
  sub?: string;
  /** Work/school accounts: the user's stable object id. Personal accounts have none. */
  oid?: string;
  tid?: string;
  email?: string;
  preferred_username?: string;
}

export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
}): Promise<ConnectedAccount> {
  const scope = scopeString(['read']);
  const { ok, status, body } = await tokenRequest({
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    scope,
  });
  if (!ok) throw new Error(`Microsoft code exchange failed (${status}): ${String(body.error)}`);
  if (typeof body.refresh_token !== 'string')
    throw new Error('Microsoft returned no refresh token');
  if (typeof body.id_token !== 'string') throw new Error('Microsoft returned no id token');
  // Straight from Microsoft's token endpoint over TLS, so the claims can be read as-is.
  const claims = JSON.parse(
    Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as IdClaims;
  const subject = claims.oid ?? claims.sub;
  const email = claims.email ?? claims.preferred_username;
  if (!subject || !email) throw new Error('Microsoft id token has no subject/email');
  const credentials: MicrosoftCredentials = { refreshToken: body.refresh_token, scope };
  return {
    // Unique per directory: the same person can be in several work tenants.
    providerAccountId: `${claims.tid ?? 'common'}:${subject}`,
    email,
    scopes: String(body.scope ?? '')
      .split(' ')
      .filter(Boolean),
    credentials: { ...credentials },
  };
}

/** Errors only reconnecting fixes: revoked, expired, password changed, consent withdrawn. */
const RECONNECT_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required']);

export async function accessToken(
  credentials: Credentials,
): Promise<{ token: string; credentials?: Credentials }> {
  const stored = credentials as unknown as MicrosoftCredentials;
  const { ok, status, body } = await tokenRequest({
    refresh_token: stored.refreshToken,
    grant_type: 'refresh_token',
    scope: stored.scope ?? scopeString(['read']),
  });
  if (RECONNECT_ERRORS.has(String(body.error))) {
    throw new NeedsReconnect(String(body.error_description ?? body.error));
  }
  if (!ok || typeof body.access_token !== 'string') {
    throw new Error(`Microsoft token refresh failed (${status}): ${String(body.error)}`);
  }
  const rotated =
    typeof body.refresh_token === 'string' && body.refresh_token !== stored.refreshToken;
  return {
    token: body.access_token,
    ...(rotated && {
      credentials: { ...stored, refreshToken: body.refresh_token as string } as Credentials,
    }),
  };
}

/**
 * Microsoft has no endpoint to revoke one app's refresh token (users remove app access at
 * account.microsoft.com / myapps). Deleting our copy is what disconnecting does.
 */
export async function revoke(): Promise<void> {}
