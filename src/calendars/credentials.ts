import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { calendarEnv } from './env';
import type { Credentials } from './provider';

// Calendar logins (refresh tokens) are encrypted with AES-256-GCM before they reach the database,
// with a key only this module loads (CALENDAR_CREDENTIALS_KEY). Format: `v1.<iv>.<tag>.<data>`,
// base64url parts, so a future key or algorithm can be told apart by its prefix.

function masterKey(): Buffer {
  const encoded = calendarEnv().CALENDAR_CREDENTIALS_KEY;
  if (!encoded) throw new Error('CALENDAR_CREDENTIALS_KEY is not set');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('CALENDAR_CREDENTIALS_KEY must be 32 bytes, base64');
  return key;
}

/** A key for one purpose, derived from the master key (so one secret serves several uses). */
export function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), Buffer.alloc(0), purpose, 32));
}

export function encryptCredentials(credentials: Credentials): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey('calendar-credentials'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptCredentials(sealed: string): Credentials {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable credentials');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derivedKey('calendar-credentials'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const json = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(json) as Credentials;
}
