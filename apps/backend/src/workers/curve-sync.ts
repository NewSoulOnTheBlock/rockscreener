import { LAMPORTS_PER_SOL, SOL_MINT } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { readCurveBatch } from '../sources/bonding-curve.js';
import { priceOf } from '../sources/jupiter.js';

/**
 * Curve progress, for the tokens that still have one.
 *
 * ORDERED BY LAST READ, so a busy index degrades into "every curve is a little
 * stale" rather than "the newest curves are current and the rest are frozen at
 * whatever they were when they were discovered".
 *
 * A COMPLETED CURVE PROMOTES THE TOKEN. The migration stream is the fast path
 * and this is the backstop: a graduation that happened while the socket was
 * reconnecting would otherwise leave a token marked BONDING forever, sitting in
 * the wrong lane with a curve that reads 100%.
 */
export class CurveSync {
  private readonly task: IntervalTask;
  private readonly log: Logger;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'curve-sync' });
    this.task = new IntervalTask('curve-sync', 5_000, () => this.tick(), this.log);
  }

  /**
   * The SOL price, held for a minute.
   *
   * Every curve read needs it to express a reserve in dollars, and a pass
   * touches a dozen curves — asking per token would be a dozen identical price
   * lookups a tick for a number that moves in tenths of a percent over that
   * window.
   */
  private solPriceUsd: number | null = null;
  private solPriceAt = 0;

  start(): void {
    this.task.start(false);
  }
  stop(): void {
    this.task.stop();
  }

  private async solPrice(): Promise<number | null> {
    if (this.solPriceUsd !== null && Date.now() - this.solPriceAt < 60_000) return this.solPriceUsd;
    const price = await priceOf(SOL_MINT);
    if (price !== null) {
      this.solPriceUsd = price;
      this.solPriceAt = Date.now();
    }
    return this.solPriceUsd;
  }

  private async tick(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { status: 'BONDING', tier: { in: ['SEEDED', 'ACTIVE'] }, launchpad: 'pumpfun' },
      /*
       * LEAST RECENTLY READ FIRST, on the curve's own timestamp.
       *
       * It used to order on `lastActivityAt`, which a FAILED read does not
       * touch — so the hundred tokens whose curve account does not exist came
       * back every tick and nothing behind them was ever reached. Curve
       * progress also genuinely changes as people buy, so "least recently read"
       * is the right queue here rather than "never read".
       */
      orderBy: [{ curveReadAt: { sort: 'asc', nulls: 'first' } }],
      select: { mint: true, progressBps: true },
      /*
       * A HUNDRED, which is the RPC's ceiling for one `getMultipleAccounts`.
       *
       * At twelve a cycle took twenty minutes over three thousand bonding
       * tokens, and the liquidity column for every one of them sat at zero for
       * that whole cycle — which is precisely the state somebody sees when they
       * say the screener has no data. Batching makes the pass cost ONE request
       * either way, so the small number was buying nothing.
       */
      take: 100,
    });

    const solPrice = await this.solPrice();
    const curves = await readCurveBatch(tokens.map((t) => t.mint));

    for (const token of tokens) {
      try {
        const curve = curves.get(token.mint);

        /*
         * NO CURVE ACCOUNT. The token is not on a pump.fun curve — usually
         * because it reached us through the profile poll with its launchpad
         * guessed. `progressBps` STAYS NULL, so nothing is claimed about a
         * curve that does not exist; only the read timestamp is stamped, which
         * is what moves it out of the queue.
         */
        if (!curve) {
          await prisma.token.update({
            where: { mint: token.mint },
            data: { curveReadAt: new Date() },
          });
          continue;
        }

        /*
         * THE CURVE'S OWN SOL IS THE TOKEN'S LIQUIDITY.
         *
         * Written only when SOL could be priced — a reserve is lamports, and a
         * dollar figure derived from a price nobody could fetch would be a
         * fabricated number in a column people read as depth.
         *
         * NOT written once the curve is complete: from then on the token has a
         * real pool and the market sync owns that column. Two writers on one
         * number is how a row starts flickering between two answers.
         */
        const liquidityUsd =
          solPrice !== null && !curve.complete
            ? (Number(curve.solLamports) / LAMPORTS_PER_SOL) * solPrice
            : undefined;

        await prisma.token.update({
          where: { mint: token.mint },
          data: {
            curveReadAt: new Date(),
            ...(curve.complete
              ? { progressBps: 10_000, status: 'MIGRATED', migratedAt: new Date(), tier: 'ACTIVE' }
              : {
                  progressBps: curve.progressBps,
                  ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
                }),
          },
        });
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'curve sync failed');
      }
    }
  }
}
