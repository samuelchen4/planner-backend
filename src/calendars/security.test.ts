import { describe, expect, it } from 'vitest';

import { decryptCredentials, encryptCredentials } from './credentials';
import { signState, verifyState } from './state';

describe('credentials encryption', () => {
  it('round-trips, with a fresh IV each time', () => {
    const creds = { refreshToken: '1//abc', extra: 1 };
    const a = encryptCredentials(creds);
    const b = encryptCredentials(creds);
    expect(a).not.toBe(b);
    expect(a).not.toContain('1//abc');
    expect(decryptCredentials(a)).toEqual(creds);
  });

  it('refuses tampered ciphertext', () => {
    const sealed = encryptCredentials({ refreshToken: 'x' });
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptCredentials(parts.join('.'))).toThrow();
    expect(() => decryptCredentials('v2.a.b.c')).toThrow();
  });
});

describe('connect state', () => {
  const input = {
    userId: '00000000-0000-4000-8000-000000000001',
    provider: 'google' as const,
    returnScheme: 'planner-local' as const,
    features: ['read' as const],
  };

  it('verifies what it signed', () => {
    expect(verifyState(signState(input))).toMatchObject(input);
  });

  it('rejects forged, edited and expired states', () => {
    const state = signState(input);
    const [body, sig] = state.split('.');
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, 'base64url').toString()),
        userId: '00000000-0000-4000-8000-000000000002',
      }),
    ).toString('base64url');
    expect(verifyState(`${edited}.${sig}`)).toBeNull();
    expect(verifyState(`${body}.forged`)).toBeNull();
    expect(verifyState('garbage')).toBeNull();
    expect(verifyState(signState(input, Date.now() - 11 * 60 * 1000))).toBeNull();
  });
});
