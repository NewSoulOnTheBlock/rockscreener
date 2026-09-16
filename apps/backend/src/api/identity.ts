import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifyRaw } from 'node:crypto';
import bs58 from 'bs58';
import { env } from '../config/load.js';
import { AppError } from '../infra/errors.js';

/**
 * Proving who you are, by two routes.
 *
 * Each function answers exactly one question — "does this evidence prove control
 * of that identifier?" — and neither touches the database, issues a session, or
 * knows what an account is. That separation is the point: the rules for
 * believing a Telegram payload and the rules for believing an ed25519 signature
 * have nothing in common.
 *
 * WHAT IS NOT HERE: passwords. There is no stored secret to leak and no hash to
 * choose badly.
 */

export interface MethodAvailability {
  wallet: boolean;
  telegram: boolean;
}

/**
 * Which buttons the sign-in modal should draw.
 *
 * Read before the modal opens, so a method with no credentials is greyed out
 * with a reason rather than offered and then failing at the last step. A
 * deployment without a Telegram bot token is not broken — it simply cannot do
 * that one thing, and saying so up front is the difference between a missing
 * feature and a bug.
 */
export function availableMethods(): MethodAvailability {
  const sessions = env.sessionSecret.length >= 16;
  return {
    wallet: sessions,
    telegram: sessions && env.telegramBotToken !== null,
  };
}

/* ---------------------------------------------------------------- Solana -- */

/**
 * Verifies an ed25519 signature by a Solana address over OUR OWN challenge.
 *
 * NO NEW DEPENDENCY. Node verifies ed25519 directly; it only needs the raw
 * 32-byte key wrapped in the twelve-byte SPKI prefix below, which is a constant
 * for this curve. Pulling in a signature library to avoid writing twelve bytes
 * would add a supply-chain edge to the one code path whose whole job is
 * deciding who you are.
 */
export function verifySolanaSignature(
  address: string,
  message: string,
  signatureBase58: string
): boolean {
  let publicKey: Buffer;
  let signature: Buffer;
  try {
    publicKey = Buffer.from(bs58.decode(address));
    signature = Buffer.from(bs58.decode(signatureBase58));
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) return false;

  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verifyRaw(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/** A Solana address, as far as its shape can say. Not an on-curve check. */
export function isSolanaAddress(raw: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return false;
  try {
    return bs58.decode(raw).length === 32;
  } catch {
    return false;
  }
}

export function requireAddress(raw: unknown): string {
  if (typeof raw !== 'string' || !isSolanaAddress(raw)) {
    throw AppError.badRequest('That is not a Solana address.');
  }
  return raw;
}

/* -------------------------------------------------------------- Telegram -- */

export interface TelegramIdentity {
  id: string;
  username: string | null;
  displayName: string | null;
  photoUrl: string | null;
}

/**
 * Verifies a Telegram Login Widget payload.
 *
 * Telegram signs the fields with HMAC-SHA256 under a key that is the SHA-256 of
 * the bot token — so possession of the bot token is what makes this checkable,
 * and this check is the only thing standing between a browser and claiming to
 * be any Telegram user at all. The `hash` field is removed, the rest are sorted
 * and joined as `k=v` with newlines, exactly as documented; a field Telegram
 * adds later changes the string and fails CLOSED.
 *
 * `auth_date` is checked as well. Without it a payload captured once is valid
 * forever, and the widget is rendered on pages we do not control.
 */
export function verifyTelegram(
  payload: Record<string, unknown>,
  maxAgeSeconds = 300
): TelegramIdentity {
  const token = env.telegramBotToken;
  if (!token) {
    throw AppError.unavailable(
      'METHOD_NOT_CONFIGURED',
      'Telegram sign-in is not configured on this deployment (TELEGRAM_LOGIN_BOT_TOKEN).'
    );
  }

  const given = typeof payload.hash === 'string' ? payload.hash : '';
  if (!given) throw AppError.unauthorized('That Telegram sign-in is missing its signature.');

  const checkString = Object.keys(payload)
    .filter((k) => k !== 'hash' && payload[k] !== undefined && payload[k] !== null)
    .sort()
    .map((k) => `${k}=${String(payload[k])}`)
    .join('\n');

  const secret = createHash('sha256').update(token).digest();
  const mac = createHmac('sha256', secret).update(checkString).digest('hex');

  if (mac.length !== given.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(given))) {
    throw AppError.unauthorized('That Telegram sign-in could not be verified.');
  }

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > maxAgeSeconds) {
    throw AppError.unauthorized('That Telegram sign-in has expired. Try again.');
  }

  const id = String(payload.id ?? '');
  if (!/^\d{1,20}$/.test(id)) throw AppError.unauthorized('That Telegram sign-in has no user.');

  const first = typeof payload.first_name === 'string' ? payload.first_name : '';
  const last = typeof payload.last_name === 'string' ? payload.last_name : '';

  return {
    id,
    username: typeof payload.username === 'string' ? payload.username.slice(0, 64) : null,
    displayName: `${first} ${last}`.trim() || null,
    photoUrl: typeof payload.photo_url === 'string' ? payload.photo_url : null,
  };
}
