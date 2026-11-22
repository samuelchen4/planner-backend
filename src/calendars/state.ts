import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { CALENDAR_PROVIDERS } from '../db/schema';
import { derivedKey } from './credentials';

// The OAuth `state` parameter: who started the connect flow, for which provider, and where to
// send them back. Signed (HMAC-SHA256) so the callback can trust it without storing anything,
// and short-lived, so a leaked consent link expires.

/** App URL schemes the callback may redirect to (one per app variant). */
export const RETURN_SCHEMES = ['planner', 'planner-local'] as const;

const payloadSchema = z.object({
  userId: z.uuid(),
  provider: z.enum(CALENDAR_PROVIDERS),
  returnScheme: z.enum(RETURN_SCHEMES),
  features: z.array(z.enum(['read', 'pushTasks', 'editEvents'])),
  expiresAt: z.number(),
});

export type ConnectState = z.infer<typeof payloadSchema>;

const TTL_MS = 10 * 60 * 1000;

const sign = (body: string) =>
  createHmac('sha256', derivedKey('oauth-state')).update(body).digest('base64url');

export function signState(input: Omit<ConnectState, 'expiresAt'>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...input, expiresAt: now + TTL_MS })).toString(
    'base64url',
  );
  return `${body}.${sign(body)}`;
}

/** The state's contents, or null when it's forged, malformed or expired. */
export function verifyState(state: string, now = Date.now()): ConnectState | null {
  const [body, signature] = state.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    if (!parsed.success || parsed.data.expiresAt < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
