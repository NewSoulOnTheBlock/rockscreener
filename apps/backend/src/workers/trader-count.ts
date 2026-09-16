import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { distinctTraders24h, tradersAvailable } from '../sources/traders.js';

/**
 * Counting distinct traders, for the tokens where it changes a grade.
 *
 * SPENT WHERE IT MATTERS. This is three paged requests per token and the
 * momentum pillar is worth a tenth of the grade, so it runs only on tokens
 * above the call liquidity floor — the ones that could actually be called or
 * bought — and never on the long tail that will not clear a threshold whatever
 * its trader count turns out to be.
 *
 * WITHOUT A KEY IT SIMPLY DOES NOT RUN, and the column stays null. The momentum
 * pillar already handles that: it falls back to the transaction count at a
 * LOWER ceiling, so the cheap-to-fake number never earns what the expensive one
 * is worth.
 */
export class TraderCount {
  private readonly task: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig();

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'trader-count' });
    this.task = new IntervalTask('trader-count', 10_000, () => this.tick(), this.log);
  }

  start(): void {
    if (!tradersAvailable()) {
      this.log.warn(
        'HELIUS_API_KEY is not set: distinct trader counts are unavailable. The momentum pillar falls back to the transaction count at a lower ceiling, which is the designed behaviour rather than a silent substitution.'
      );
      return;
    }
    this.task.start(false);
  }

  stop(): void {
    this.task.stop();
  }

  private async tick(): Promise<void> {
    const stale = new Date(Date.now() - 20 * 60_000);

    const tokens = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        poolAddress: { not: null },
        liquidityUsd: { gte: this.cfg.calls.minLiquidityUsd },
        // Re-counted on the same clock the grade turns over on, so a token that
        // has just started trading does not keep yesterday's count.
        OR: [{ traders24h: null }, { lastActivityAt: { lt: stale } }],
      },
      orderBy: { liquidityUsd: 'desc' },
      select: { mint: true, poolAddress: true },
      take: 2,
    });

    for (const token of tokens) {
      try {
        const traders = await distinctTraders24h(token.poolAddress!);
        // Null is left null: the row keeps whatever it had rather than being
        // overwritten with a failed read.
        if (traders === null) continue;
        await prisma.token.update({ where: { mint: token.mint }, data: { traders24h: traders } });
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'trader count failed');
      }
    }
  }
}
