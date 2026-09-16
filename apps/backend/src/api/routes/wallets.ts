import { Router } from 'express';
import { prisma } from '../../clients/prisma.js';
import { AppError } from '../../infra/errors.js';
import { encryptionConfigured } from '../../trading/crypto.js';
import { createWallet, listWallets } from '../../trading/wallets.js';
import { requireUser } from '../auth.js';
import { wrap } from '../middleware/error-handler.js';

/**
 * Wallets.
 *
 * THERE IS NO EXPORT ROUTE, AND THAT IS A DECISION RATHER THAN AN OMISSION. An
 * export endpoint turns the master key's entire blast radius into a plaintext
 * key in a browser's memory, a proxy log, and whatever the user pastes it into.
 * The page says so plainly instead: fund this wallet with what you intend the
 * engine to risk and no more.
 */
export function walletsRouter(): Router {
  const router = Router();

  router.get(
    '/wallets',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      res.json({ data: await listWallets(userId) });
    })
  );

  router.post(
    '/wallets',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      if (!encryptionConfigured()) {
        throw AppError.unavailable(
          'WALLET_NOT_CONFIGURED',
          'This deployment has no WALLET_MASTER_KEY, so it cannot hold trading wallets.'
        );
      }
      // Bounded: each wallet is a key this deployment is responsible for, and
      // there is no workflow here that needs more than a handful.
      const existing = await prisma.tradingWallet.count({ where: { userId } });
      if (existing >= 5) throw AppError.badRequest('That is as many trading wallets as one account may hold.');

      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 40) : undefined;
      res.json({ data: await createWallet(userId, label) });
    })
  );

  router.get(
    '/wallets/linked',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const rows = await prisma.linkedWallet.findMany({
        where: { userId },
        orderBy: { verifiedAt: 'desc' },
      });
      res.json({
        data: rows.map((r) => ({ address: r.address, verifiedAt: r.verifiedAt.toISOString() })),
      });
    })
  );

  router.delete(
    '/wallets/linked/:address',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      await prisma.linkedWallet.deleteMany({
        where: { userId, address: String(req.params.address ?? '') },
      });
      res.json({ data: null });
    })
  );

  return router;
}
