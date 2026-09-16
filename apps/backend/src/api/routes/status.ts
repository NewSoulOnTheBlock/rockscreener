import { Router } from 'express';
import { SOL_MINT, type SystemStatus } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { cached } from '../../clients/redis.js';
import { env, loadConfig } from '../../config/load.js';
import { priceOf } from '../../sources/jupiter.js';
import { encryptionConfigured } from '../../trading/crypto.js';
import { publicCache } from '../middleware/cache.js';
import { wrap } from '../middleware/error-handler.js';

/**
 * THE STATUS LINE'S DATA — one request, no fan-out.
 *
 * The number that matters is `lagSeconds`: not "is the web server up", which
 * the reader can already tell, but HOW LONG AGO the indexer last wrote a row.
 * When that climbs, the feed is stale and the bar says so in words — which is
 * the difference between a screener and a screenshot of one.
 *
 * Everything here is cached for a few seconds, because it is identical for
 * every reader and is polled by all of them at once.
 */
export function statusRouter(): Router {
  const router = Router();
  const cfg = loadConfig();

  router.get(
    '/status',
    publicCache(5),
    wrap(async (_req, res) => {
      const data = await cached('rock:status', 5, async (): Promise<SystemStatus> => {
        const hourAgo = new Date(Date.now() - 3_600_000);
        const dayAgo = new Date(Date.now() - 86_400_000);

        const [latest, tokensTracked, scoredLastHour, callsLast24h, solPrice, rockPrice] =
          await Promise.all([
            prisma.token.findFirst({
              where: { lastActivityAt: { not: null } },
              orderBy: { lastActivityAt: 'desc' },
              select: { lastActivityAt: true },
            }),
            prisma.token.count({ where: { tier: { in: ['ACTIVE', 'GRADUATED'] } } }),
            prisma.token.count({ where: { scoredAt: { gte: hourAgo } } }),
            prisma.call.count({ where: { calledAt: { gte: dayAgo } } }),
            priceOf(SOL_MINT),
            priceOf(env.rockMint),
          ]);

        const lagSeconds = latest?.lastActivityAt
          ? Math.round((Date.now() - latest.lastActivityAt.getTime()) / 1_000)
          : null;

        return {
          // "Indexing" is defined as HAVING WRITTEN RECENTLY, not as a process
          // being alive — a stuck worker is alive and is not indexing.
          indexing: lagSeconds !== null && lagSeconds < 60,
          lagSeconds,
          tokensTracked,
          scoredLastHour,
          callsLast24h,
          tradingConfigured: encryptionConfigured(),
          engineAlive: cfg.autotrade.enabled,
          solPriceUsd: solPrice,
          rockPriceUsd: rockPrice,
        };
      });

      res.json({ data });
    })
  );

  return router;
}
