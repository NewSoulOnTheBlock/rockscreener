import { Router } from 'express';
import { DEFAULT_AUTO_TRADE, type AutoTradeSettings } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { AppError } from '../../infra/errors.js';
import { cachedGate, readGate } from '../../autotrade/gate.js';
import { AutoTradeRulesSchema, DEFAULT_RULES, readRules } from '../../autotrade/rules.js';
import { requireUser } from '../auth.js';
import { wrap } from '../middleware/error-handler.js';
import { eventView, positionView } from '../serialize.js';

/**
 * The auto-trade surface.
 *
 * SETTINGS ARE STORED WHETHER OR NOT THE GATE IS OPEN, and only ARMING is
 * gated. Somebody deciding whether the product is worth holding ROCK for needs
 * to be able to write their rules first and see what the engine would have
 * refused — a page that will not let them type until they have paid is a page
 * that never gets them to.
 *
 * NOTHING HERE IS CACHED. Every route is session-dependent, and a cached
 * response that varied by user would be the worst bug this file could cause.
 */
export function autoRouter(): Router {
  const router = Router();

  router.get(
    '/auto/gate',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      // `refresh=true` bypasses the cache, for the "Re-check" button — somebody
      // who just bought ROCK should not wait out a TTL to be let in.
      const gate = req.query.refresh === 'true' ? await readGate(userId) : await cachedGate(userId);
      res.json({ data: gate });
    })
  );

  router.get(
    '/auto/settings',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const row = await prisma.autoSettings.findUnique({ where: { userId } });

      if (!row) {
        /*
         * A user with no row gets the DEFAULTS rather than a 404. They are
         * armed off and tuned to refuse most launches, and handing them back as
         * a real object means the settings page renders identically before and
         * after the first save.
         */
        const wallet = await prisma.tradingWallet.findFirst({
          where: { userId, isDefault: true },
          select: { id: true },
        });
        res.json({ data: { ...DEFAULT_AUTO_TRADE, walletId: wallet?.id ?? null } });
        return;
      }

      const settings: AutoTradeSettings = {
        ...readRules(row.rules),
        enabled: row.enabled,
        walletId: row.walletId,
        disarmedAt: row.disarmedAt?.toISOString() ?? null,
        disarmedReason: row.disarmedReason,
      };
      res.json({ data: settings });
    })
  );

  router.patch(
    '/auto/settings',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      /*
       * STRICT VALIDATION HERE, unlike `readRules` on the engine's hot path.
       * There the input is a stored row and a parse failure must not take
       * somebody's engine offline mid-position; here the input is a REQUEST,
       * and a rejection naming the field is information the user can act on.
       */
      const parsed = AutoTradeRulesSchema.safeParse({ ...DEFAULT_RULES, ...body });
      if (!parsed.success) {
        throw AppError.badRequest(
          parsed.error.issues[0]?.message ?? 'Those rules are not valid.',
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
        );
      }

      const wantsEnabled = body.enabled === true;
      if (wantsEnabled) {
        /*
         * THE GATE IS RE-READ, NOT TAKEN FROM THE CACHE, at the moment of
         * arming. This is the one action that lets a process start spending
         * somebody's money by itself, and it is worth one uncached chain read.
         */
        const gate = await readGate(userId);
        if (!gate.unlocked) {
          throw AppError.forbidden(gate.reason ?? 'The ROCK holding does not clear the line.');
        }
        const wallet = await prisma.tradingWallet.count({ where: { userId } });
        if (wallet === 0) {
          throw AppError.badRequest('Create and fund a trading wallet before arming the engine.');
        }
      }

      const walletId = typeof body.walletId === 'string' ? body.walletId : null;
      if (walletId) {
        const owned = await prisma.tradingWallet.count({ where: { id: walletId, userId } });
        // Ownership is checked server-side: a wallet id is guessable, and this
        // is the field that decides which key the engine signs with.
        if (owned === 0) throw AppError.badRequest('That wallet does not belong to this account.');
      }

      const saved = await prisma.autoSettings.upsert({
        where: { userId },
        create: {
          userId,
          enabled: wantsEnabled,
          walletId,
          rules: parsed.data as unknown as object,
        },
        update: {
          enabled: wantsEnabled,
          walletId,
          rules: parsed.data as unknown as object,
          // Arming clears the disarm banner. Leaving it would show somebody a
          // permanent explanation of a state they have just left.
          ...(wantsEnabled ? { disarmedAt: null, disarmedReason: null } : {}),
        },
      });

      res.json({
        data: {
          ...parsed.data,
          enabled: saved.enabled,
          walletId: saved.walletId,
          disarmedAt: saved.disarmedAt?.toISOString() ?? null,
          disarmedReason: saved.disarmedReason,
        },
      });
    })
  );

  router.get(
    '/auto/positions',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const rows = await prisma.autoPosition.findMany({
        where: { userId },
        include: { token: true },
        orderBy: [{ closedAt: { sort: 'asc', nulls: 'first' } }, { openedAt: 'desc' }],
        take: 100,
      });
      res.json({ data: rows.map(positionView) });
    })
  );

  /**
   * The event log, and REFUSALS ARE NOT FILTERED OUT BY DEFAULT.
   *
   * "Why didn't it buy that one" is the first question anybody asks of an
   * automated buyer, and an endpoint that returned only the fills could not
   * answer it. The client offers a filter; the default is everything.
   */
  router.get(
    '/auto/events',
    wrap(async (req, res) => {
      const userId = requireUser(req);
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const rows = await prisma.autoEvent.findMany({
        where: { userId, ...(kind ? { kind } : {}) },
        orderBy: { at: 'desc' },
        take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
      });
      res.json({ data: rows.map(eventView) });
    })
  );

  return router;
}
