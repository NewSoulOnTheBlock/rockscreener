import { Router, type Request, type Response } from 'express';
import type { Session } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { AppError } from '../../infra/errors.js';
import { logger } from '../../infra/logger.js';
import { createWallet } from '../../trading/wallets.js';
import { encryptionConfigured } from '../../trading/crypto.js';
import {
  SESSION_COOKIE,
  authEnabled,
  issueChallenge,
  issueToken,
  requireUser,
  takeChallenge,
} from '../auth.js';
import { availableMethods, requireAddress, verifySolanaSignature, verifyTelegram } from '../identity.js';
import { wrap } from '../middleware/error-handler.js';

/**
 * Sign in, and what a signed-in account is.
 *
 * TWO ROUTES IN, ONE ACCOUNT ROW. A wallet signature proves control of an
 * address; a Telegram payload proves control of an account. Neither is better
 * and both land on the same row, because what a person wants back when they
 * return is their rules and their positions — not their login method.
 *
 * A CUSTODIAL WALLET IS CREATED ON FIRST SIGN-IN, not on first trade. The
 * engine needs an address to be funded before it can do anything, and asking
 * for one more click at the moment somebody wants to arm it is a click they
 * spend wondering whether the product works.
 */
export function authRouter(): Router {
  const router = Router();
  const log = logger.child({ module: 'auth' });

  const requireAuthEnabled = (): void => {
    if (!authEnabled()) {
      throw AppError.unavailable(
        'AUTH_DISABLED',
        'Sign-in is not configured on this deployment (SESSION_SECRET).'
      );
    }
  };

  /**
   * The cookie's flags are the subtle part, so they live in ONE place.
   *
   * `Lax` is only enough when the page and the API share a site. A frontend on
   * one host and an API on another — the normal production shape — is
   * cross-site, and Lax cookies never travel there, so every call after a
   * successful sign-in would read as signed-out. Cross-site requires `None`,
   * and `None` requires `Secure`; over plain http (local development, same site
   * by construction) `Lax` is what still works.
   */
  const grant = async (req: Request, res: Response, userId: string): Promise<void> => {
    const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    res.cookie(SESSION_COOKIE, issueToken(userId), {
      httpOnly: true,
      sameSite: https ? 'none' : 'lax',
      secure: https,
      maxAge: 7 * 24 * 3_600_000,
      path: '/',
    });
    res.json({ data: await sessionFor(userId) });
  };

  router.get('/auth/methods', (_req, res) => {
    res.json({ data: { ...availableMethods(), wallets: encryptionConfigured() } });
  });

  router.get(
    '/auth/session',
    wrap(async (req, res) => {
      // NOT an error when signed out: the shell renders the anonymous state and
      // a 401 here would make every first page load look like a failure.
      if (!req.userId) {
        res.json({ data: null });
        return;
      }
      res.json({ data: await sessionFor(req.userId) });
    })
  );

  /** The exact text the wallet will sign. Issued here, stored, and consumed once. */
  router.get(
    '/auth/nonce',
    wrap(async (req, res) => {
      requireAuthEnabled();
      const address = requireAddress(req.query.address);
      const domain = (req.headers.host ?? 'rockscreener.app').split(':')[0]!;
      res.json({ data: await issueChallenge(address, domain) });
    })
  );

  router.post(
    '/auth/verify',
    wrap(async (req, res) => {
      requireAuthEnabled();
      const address = requireAddress(req.body?.address);
      const signature = String(req.body?.signature ?? '');

      /*
       * THE CHALLENGE IS TAKEN, NOT READ — consumed regardless of what the
       * signature turns out to be, so a failed attempt cannot leave one
       * standing for another try.
       */
      const message = await takeChallenge(address);
      if (!message) {
        throw AppError.badRequest('No sign-in challenge for that address — request one first.');
      }
      // Verified against what THIS SERVER issued, never against text the client
      // handed back: a client that picks the wording can get a signature over
      // anything.
      if (!verifySolanaSignature(address, message, signature)) {
        throw AppError.unauthorized('That signature does not match the address.');
      }

      const user = await prisma.user.upsert({
        where: { walletAddress: address },
        create: { walletAddress: address },
        update: {},
      });
      await ensureWallet(user.id);
      await grant(req, res, user.id);
      log.info({ userId: user.id }, 'signed in with a wallet');
    })
  );

  router.post(
    '/auth/telegram',
    wrap(async (req, res) => {
      requireAuthEnabled();
      const identity = verifyTelegram((req.body ?? {}) as Record<string, unknown>);

      const user = await prisma.user.upsert({
        where: { telegramId: identity.id },
        create: {
          telegramId: identity.id,
          telegramUsername: identity.username,
          displayName: identity.displayName,
          avatarUrl: identity.photoUrl,
        },
        // Refreshed on every sign-in: people change their Telegram handle and a
        // stale one in the sidebar reads as the wrong account.
        update: {
          telegramUsername: identity.username,
          displayName: identity.displayName,
          avatarUrl: identity.photoUrl,
        },
      });
      await ensureWallet(user.id);
      await grant(req, res, user.id);
      log.info({ userId: user.id }, 'signed in with Telegram');
    })
  );

  router.post('/auth/signout', (req, res) => {
    const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    // Cleared with the SAME flags it was set with, or the browser keeps it.
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: https ? 'none' : 'lax',
      secure: https,
      path: '/',
    });
    res.json({ data: null });
  });

  /**
   * Linking a wallet you already hold ROCK in.
   *
   * IT GRANTS NO SPENDING POWER OF ANY KIND. There is no key column for a
   * linked wallet and no code path that could sign for one; it is read solely
   * to count ROCK toward the gate, so somebody does not have to move a position
   * to unlock a feature.
   */
  router.post(
    '/wallets/link',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const address = requireAddress(req.body?.address);
      const signature = String(req.body?.signature ?? '');

      const message = await takeChallenge(address);
      if (!message) throw AppError.badRequest('Request a challenge for that address first.');
      if (!verifySolanaSignature(address, message, signature)) {
        throw AppError.unauthorized('That signature does not match the address.');
      }

      await prisma.linkedWallet.upsert({
        where: { userId_address: { userId, address } },
        create: { userId, address },
        update: {},
      });
      res.json({ data: { address } });
    })
  );

  return router;
}

/**
 * A wallet on first sign-in. Best effort, and NEVER fatal.
 *
 * A deployment with no `WALLET_MASTER_KEY` can still serve the entire screener
 * and every account feature except custody, and failing sign-in over it would
 * take the whole product down for a missing optional capability.
 */
async function ensureWallet(userId: string): Promise<void> {
  if (!encryptionConfigured()) return;
  const existing = await prisma.tradingWallet.count({ where: { userId } });
  if (existing > 0) return;
  await createWallet(userId).catch(() => undefined);
}

async function sessionFor(userId: string): Promise<Session | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallets: { where: { isDefault: true }, take: 1 } },
  });
  if (!user) return null;

  return {
    userId: user.id,
    // The signed-in address if there is one, otherwise the custodial wallet —
    // a Telegram account has no address of its own to show.
    address: user.walletAddress ?? user.wallets[0]?.address ?? null,
    via: user.walletAddress ? 'wallet' : 'telegram',
    telegramUsername: user.telegramUsername,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    isAdmin: user.isAdmin,
  };
}
