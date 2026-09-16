import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/load.js';
import { AppError } from '../infra/errors.js';

/**
 * Custodial key encryption.
 *
 * AES-256-GCM, NOT CBC. GCM is authenticated: a ciphertext that has been
 * tampered with fails to decrypt rather than producing a different key, which
 * matters because the thing being decrypted here signs transactions. A CBC
 * ciphertext with a flipped bit decrypts to garbage that is still 64 bytes
 * long, and a keypair built from garbage is a wallet nobody controls that the
 * engine will happily try to spend from.
 *
 * THE MASTER KEY LIVES ONLY IN THE PROCESS ENVIRONMENT. It is never written to
 * the database, never logged, and no endpoint returns it. Losing it loses every
 * custodial wallet and there is no recovery path — a recoverable master key is
 * simply a second copy of it.
 *
 * THE FORMAT IS `iv.tag.ciphertext`, all base64url. The IV is random per
 * encryption and is stored alongside: reusing one IV across two keys under the
 * same master key is the single catastrophic failure mode of GCM, so there is
 * no code path here that lets a caller supply one.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export function encryptionConfigured(): boolean {
  const key = env.walletMasterKey;
  return typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key);
}

function masterKey(): Buffer {
  const key = env.walletMasterKey;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    /*
     * 503 rather than 500, and it names the variable. A deployment without a
     * master key is not broken — it simply cannot hold custody, and the API
     * reports the terminal as unconfigured while continuing to serve the entire
     * screener.
     */
    throw AppError.unavailable(
      'WALLET_NOT_CONFIGURED',
      'This deployment has no WALLET_MASTER_KEY, so it cannot hold trading wallets. Generate one with `openssl rand -hex 32`.'
    );
  }
  return Buffer.from(key, 'hex');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new AppError(500, 'WALLET_CORRUPT', 'That wallet record cannot be read.');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    /*
     * The failure is NOT described. Distinguishing "wrong master key" from
     * "tampered ciphertext" here would tell whoever is probing which of the two
     * they achieved, and neither answer helps a legitimate operator, who knows
     * whether they rotated the key.
     */
    throw new AppError(500, 'WALLET_CORRUPT', 'That wallet record cannot be read.');
  }
}
