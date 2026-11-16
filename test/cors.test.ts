import { describe, expect, it } from 'vitest';

import { app } from '../src/app';

const preflight = (origin: string) =>
  app.request('/sync/upload', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

describe('CORS', () => {
  it('allows the web app origin', async () => {
    const res = await preflight('http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });

  it('does not allow other origins', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
