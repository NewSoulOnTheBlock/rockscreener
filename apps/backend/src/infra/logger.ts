import pino from 'pino';
import { env } from '../config/load.js';

/**
 * One logger, and a rule about what may go into it.
 *
 * NO KEYS, NO SIGNATURES-IN-PROGRESS, NO SESSION TOKENS, EVER. A custodial
 * private key exists in this process only between decryption and signing; a log
 * line is the one way it escapes that window and lands somewhere durable that
 * nobody thinks of as a secret store. `redact` below is a backstop for the
 * accidental `log.info({ wallet })`, not a licence to pass one.
 */
export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      'key',
      'privateKey',
      'secretKey',
      'encryptedKey',
      'masterKey',
      'token',
      'authorization',
      '*.key',
      '*.privateKey',
      '*.secretKey',
      '*.encryptedKey',
    ],
    censor: '[redacted]',
  },
  // Pretty in development only: the JSON is what a log shipper wants, and the
  // colours are what a person staring at four processes wants.
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

export type Logger = pino.Logger;

/**
 * An error, flattened for a log line.
 *
 * `JSON.stringify(err)` on an Error returns `{}` — the message and the stack
 * are non-enumerable — so a log full of `{"err":{}}` is the default outcome of
 * logging an error the obvious way.
 */
export function errField(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}
