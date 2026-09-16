import { Prisma } from '@prisma/client';
import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { gather } from './gather.js';
import { computeScore, topWarning } from './score.js';

/**
 * The scorer's loop.
 *
 * IT SCORES WHAT HAS CHANGED, NOT EVERYTHING. A full pass over the token table
 * every few seconds would be most of the database's day for no benefit — a
 * token nobody has traded and nothing new has been read about grades the same
 * as it did a minute ago. The selection below is the whole optimisation: rows
 * that have never been scored first, then rows whose facts are newer than their
 * grade, then rows whose grade has simply gone stale.
 *
 * IT NEVER SCORES A SEEDED ROW. Those are cheap identity records for mints that
 * have not cleared the activation thresholds; they have no liquidity reading,
 * no security report and nothing to grade. Publishing a number for them is
 * exactly what made the predecessor's list meaningless.
 */
export class Scorer {
  private readonly task: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig().scoring;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'scorer' });
    this.task = new IntervalTask('scorer', this.cfg.intervalMs, () => this.tick(), this.log);
  }

  start(): void {
    this.task.start(true);
  }

  stop(): void {
    this.task.stop();
  }

  private async tick(): Promise<void> {
    const stale = new Date(Date.now() - this.cfg.rescoreAfterSeconds * 1_000);

    const tokens = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        OR: [
          // Never scored. These come first by the ordering below.
          { scoredAt: null },
          // A fact landed after the last grade — a security report, a mint read,
          // a sell check. Re-grading here is what makes the number current
          // rather than merely recent.
          { scoredAt: { lt: stale } },
        ],
      },
      orderBy: [{ scoredAt: { sort: 'asc', nulls: 'first' } }],
      take: this.cfg.batchSize,
    });

    if (tokens.length === 0) return;

    let scored = 0;
    for (const token of tokens) {
      try {
        const request = await gather(token);
        const result = computeScore(request);

        /*
         * HISTORY IS THINNED, and the epsilon is why the table stays small
         * enough to query. A pillar wobbling by a tenth of a point — a holder
         * count ticking over, a volume window rolling — would otherwise write a
         * row every five seconds per token saying nothing happened.
         */
        const moved =
          token.score === null ||
          Math.abs(result.score - token.score) >= this.cfg.historyEpsilon;

        const data: Prisma.TokenUpdateInput = {
          score: result.score,
          tier_: result.tier,
          coverage: result.coverage,
          topWarning: topWarning(result.findings),
          pillars: result.pillars as unknown as Prisma.InputJsonValue,
          findings: result.findings as unknown as Prisma.InputJsonValue,
          clamped: (result.clamped ?? Prisma.DbNull) as Prisma.InputJsonValue,
          scoredAt: new Date(),
          // Only advanced when the score actually moved, so the delta arrow
          // compares against the last DIFFERENT number rather than against the
          // identical one from four seconds ago.
          ...(moved && token.score !== null ? { prevScore: token.score } : {}),
        };

        await prisma.token.update({ where: { mint: token.mint }, data });

        if (moved) {
          await prisma.scoreHistory.create({
            data: { mint: token.mint, score: result.score, coverage: result.coverage },
          });
        }
        scored += 1;
      } catch (err) {
        // One token that cannot be graded must not stop the batch behind it.
        this.log.warn({ mint: token.mint, err: errField(err) }, 'scoring failed');
      }
    }

    this.log.debug({ scored, considered: tokens.length }, 'scoring pass');
  }
}
