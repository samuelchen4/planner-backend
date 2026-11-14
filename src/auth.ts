import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

import { env } from './env';

export interface AuthVariables {
  userId: string;
}

const jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL));
const secret = env.SUPABASE_JWT_SECRET && new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { alg } = decodeProtectedHeader(token);
  const options = { audience: 'authenticated' };
  if (alg === 'HS256') {
    if (!secret) throw new Error('HS256 token, but SUPABASE_JWT_SECRET is not set');
    return (await jwtVerify(token, secret, options)).payload;
  }
  return (await jwtVerify(token, jwks, options)).payload;
}

export const requireUser = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HTTPException(401, { message: 'Sign-in required' });
  let claims: JWTPayload;
  try {
    claims = await verifyToken(token);
  } catch {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
  if (!claims.sub) throw new HTTPException(401, { message: 'Token has no user' });
  c.set('userId', claims.sub);
  await next();
});
