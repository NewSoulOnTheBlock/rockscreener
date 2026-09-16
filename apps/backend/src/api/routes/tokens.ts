import { Router } from 'express';
import { looksLikeMint } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { AppError } from '../../infra/errors.js';
import { creatorHistory } from '../../score/gather.js';
import { publicCache } from '../middleware/cache.js';
import { wrap } from '../middleware/error-handler.js';
import { fullScore, holders, tokenDetail } from '../serialize.js';

/**
 * One token.
 *
 * THE SCORE IS A SEPARATE ROUTE from the token itself, because the two have
 * very different lifetimes on a client: the detail is fetched once when a page
 * opens and the price on it refreshes every few seconds, while the grade
 * changes on the scorer's own clock. Bundling them would mean re-sending five
 * pillars and a dozen findings with every price tick.
 */
export function tokensRouter(): Router {
  const router = Router();

  const mintOf = (raw: unknown): string => {
    const mint = String(raw ?? '');
    // Checked before the query, so a malformed path is a 400 rather than a
    // successful-but-empty lookup that reads as "this token does not exist".
    if (!looksLikeMint(mint)) throw AppError.badRequest('That is not a Solana mint address.');
    return mint;
  };

  router.get(
    '/tokens/:mint',
    publicCache(5),
    wrap(async (req, res) => {
      const mint = mintOf(req.params.mint);
      const token = await prisma.token.findUnique({
        where: { mint },
        include: { calls: { orderBy: { calledAt: 'desc' }, take: 1 } },
      });
      if (!token) {
        throw AppError.notFound(
          'Nothing is indexed under that mint. It may never have traded, or it may be below the activation threshold and carried as an identity record only.'
        );
      }
      res.json({ data: tokenDetail(token, token.calls[0] ?? null) });
    })
  );

  router.get(
    '/tokens/:mint/score',
    publicCache(5),
    wrap(async (req, res) => {
      const mint = mintOf(req.params.mint);
      const token = await prisma.token.findUnique({ where: { mint } });
      if (!token) throw AppError.notFound('Nothing is indexed under that mint.');

      const score = fullScore(token);
      if (!score) {
        // NOT a 404. The token exists and has simply not been graded yet, and
        // the client draws a different, honest state for that.
        res.json({ data: null });
        return;
      }

      // The creator's record is one extra query and belongs only on the detail
      // view — a screener row would pay for it sixty times over.
      score.creator = await creatorHistory(token.creator);
      res.json({ data: score });
    })
  );

  router.get(
    '/tokens/:mint/holders',
    publicCache(30),
    wrap(async (req, res) => {
      const mint = mintOf(req.params.mint);
      const token = await prisma.token.findUnique({ where: { mint } });
      if (!token) throw AppError.notFound('Nothing is indexed under that mint.');
      res.json({ data: holders(token) });
    })
  );

  /**
   * WHO HAS LAUNCHED WHAT, from what this index has actually seen.
   *
   * GROUPED IN SQL, not by pulling a page of tokens and bucketing them in the
   * browser — which is what the creators page did, and which meant the "top
   * creators" were whoever happened to be in the most recent sixty rows.
   *
   * ONE LAUNCH IS NOT A RECORD, so the list only includes creators this index
   * has seen more than once. A page of first-time creators is a page of no
   * information.
   */
  router.get(
    '/creators',
    publicCache(60),
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 40) || 40, 100);

      const rows = await prisma.token.groupBy({
        by: ['creator'],
        where: { creator: { not: null }, tier: { not: 'SEEDED' } },
        _count: { _all: true },
        _max: { marketCapUsd: true, launchTime: true },
        having: { creator: { _count: { gt: 1 } } },
        orderBy: { _count: { creator: 'desc' } },
        take: limit,
      });

      /*
       * The reputation is computed per creator rather than in the group-by,
       * because "rugged" is a comparison between a token's PEAK valuation and
       * its CURRENT liquidity — two columns, per row — which is not something a
       * grouping aggregate can express.
       */
      const data = await Promise.all(
        rows.map(async (row) => ({
          address: row.creator!,
          launches: row._count._all,
          bestMarketCapUsd: row._max.marketCapUsd,
          lastLaunchAt: row._max.launchTime?.toISOString() ?? null,
          history: await creatorHistory(row.creator!),
        }))
      );

      res.json({ data });
    })
  );

  /**
   * The creator's other launches.
   *
   * A record is built ENTIRELY from what this deployment has seen, and it says
   * so: a creator with one launch has no record, and that is reported rather
   * than filled in with a neutral-looking verdict.
   */
  router.get(
    '/creators/:address',
    publicCache(30),
    wrap(async (req, res) => {
      const address = String(req.params.address ?? '');
      if (!looksLikeMint(address)) throw AppError.badRequest('That is not a Solana address.');

      const [history, tokens] = await Promise.all([
        creatorHistory(address),
        prisma.token.findMany({
          where: { creator: address },
          orderBy: { launchTime: 'desc' },
          take: 50,
          include: { calls: { orderBy: { calledAt: 'desc' }, take: 1 } },
        }),
      ]);

      res.json({
        data: {
          history,
          tokens: tokens.map((t) => tokenDetail(t, t.calls[0] ?? null)),
        },
      });
    })
  );

  return router;
}
