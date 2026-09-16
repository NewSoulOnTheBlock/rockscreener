import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Session } from '@rockscreener/shared';
import { getRedis } from '../clients/redis.js';
import { env } from '../config/load.js';
import { AppError } from '../infra/errors.js';

/**
 * Sessions, and the challenge a wallet signs to get one.
 *
 * DELIBERATELY NOT A JWT LIBRARY. The token here carries a user id and an
 * expiry and nothing else, and an HMAC over that is the whole requirement. A
 * dependency would add an algorithm-negotiation surface — the `alg: none`
 * family of bugs — to buy features this product does not use.
 *
 * THE SIGNED MESSAGE IS ALWAYS TEXT THIS SERVER ISSUED, never text the client
 * hands back. A client that chooses the wording can get a signature over
 * anything, including a transaction, and present it here as a login.
 */

export const SESSION_COOKIE = 'rockscreener_session';
const SESSION_TTL_MS = 7 * 24 * 3_600_000;
const CHALLENGE_TTL_MS = 5 * 60_000;

export function authEnabled(): boolean {
  return env.sessionSecret.length >= 16;
}

function sign(payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

export function issueToken(userId: string): string {
  const payload = `${userId}:${Date.now() + SESSION_TTL_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function readToken(token: string | undefined): { userId: string } | null {
  if (!token || !authEnabled()) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = sign(payload);
  const given = token.slice(dot + 1);
  // Constant-time, so a forged token cannot be refined byte by byte against
  // response timing.
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

  const sep = payload.lastIndexOf(':');
  const userId = payload.slice(0, sep);
  const expiry = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  return { userId };
}

/**
 * The text a wallet signs.
 *
 * SIWS-shaped so a wallet can render it as something a person can read and
 * check, rather than as an opaque blob. It states plainly that it authorises no
 * transaction, because the one thing a user needs to know when a wallet pops up
 * is whether pressing the button can move their money.
 */
export async function issueChallenge(
  address: string,
  domain: string
): Promise<{ message: string; expiresAt: string }> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    'Sign in to RockScreener. This authorises no transaction and costs no fee.',
    '',
    `URI: https://${domain}`,
    'Version: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');

  const redis = getRedis();
  if (!redis) {
    /*
     * REFUSED RATHER THAN DEGRADED. Without a shared store the challenge would
     * live in one process's memory, and with two gateway replicas behind a load
     * balancer `/auth/nonce` and `/auth/verify` land on different ones — every
     * sign-in fails with "no challenge for that address", intermittently, which
     * is far worse to diagnose than a clear refusal.
     */
    throw AppError.unavailable(
      'REDIS_REQUIRED',
      'Wallet sign-in needs Redis to hold the challenge, and this deployment has none.'
    );
  }
  // Keyed by ADDRESS: one outstanding challenge per wallet, so a second request
  // replaces the first and there is nothing to sweep.
  await redis.set(challengeKey(address), message, 'PX', CHALLENGE_TTL_MS);

  return { message, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Consumes the challenge, whatever the signature turns out to be.
 *
 * `GETDEL` makes that atomic across replicas: two requests racing the same
 * challenge cannot both find it, and a failed attempt cannot leave one standing
 * for another try.
 */
export async function takeChallenge(address: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.getdel(challengeKey(address));
}

function challengeKey(address: string): string {
  return `rock:auth:challenge:${address}`;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      session?: Session;
    }
  }
}

/**
 * The session token, from either place a client can honestly put it.
 *
 * The cookie is what the site uses. The bearer header exists for clients whose
 * origin a cookie will not travel to — and it is the SAFER of the two shapes: a
 * browser attaches a cookie by itself, which is what CSRF is, and it will never
 * attach an Authorization header on anybody's behalf.
 */
function readSessionToken(req: Request): string | undefined {
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (cookie) return cookie;

  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token === '' ? undefined : token;
}

/** Attaches `req.userId` when a valid token is present. NEVER rejects. */
export function sessionLoader() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const raw = readSessionToken(req);
    // No token, no work. The overwhelming majority of traffic here is anonymous
    // screener polling and must not wait on anything about a signed-in wallet.
    if (raw) {
      const session = readToken(raw);
      if (session) req.userId = session.userId;
    }
    next();
  };
}

export function requireUser(req: Request): string {
  if (!req.userId) throw AppError.unauthorized('Connect a wallet or Telegram to continue.');
  return req.userId;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
