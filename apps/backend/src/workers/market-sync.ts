import type { Prisma } from '@prisma/client';
import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { fetchBoostBoard, fetchPairs, fetchPaidOrders } from '../sources/dexscreener.js';

/**
 * THE MARKET SYNC — prices, depth, volume, and the activation decision.
 *
 * IT IS ALSO WHERE A TOKEN EARNS THE EXPENSIVE PIPELINE. The activation
 * thresholds in configuration.json are applied here, on data this pass already
 * has, so nothing else in the system needs to ask "is this token worth
 * bothering with" — it reads the tier.
 *
 * ROUND-ROBIN BY STALENESS, thirty mints a request. Sorting by
 * `lastActivityAt` ascending means the token nobody has looked at for longest
 * goes first, so a busy index degrades into "everything is a little stale"
 * rather than "the newest tokens are current and everything else is frozen".
 *
 * AND A HOT LANE ON TOP OF IT, because "everything is a little stale" is not
 * good enough for the handful of tokens this product has staked a claim on.
 * Twelve thousand mints at thirty a request every six seconds is a FORTY MINUTE
 * lap, which is a perfectly reasonable refresh for a screener row and a
 * catastrophic one for a live call: the calls engine reads the token's price to
 * track its own claim, so a call was being marked against a price up to forty
 * minutes old. It showed up as twenty-six calls closed with the reason "25
 * minutes on and it has not moved" — every one of which was a call nobody had
 * looked at twice, recorded as a token that went nowhere. A track record is the
 * only reason to believe any of this, and it was being written from stale
 * prices.
 *
 * THE HOT SET IS TINY AND BOUNDED: tokens with a live call, plus tokens with an
 * open auto-trade position. One extra request per tick covers both with room to
 * spare, and both are cases where the product's own money or reputation is on
 * the number.
 */
/**
 * The columns both passes read. Shared so the two cannot drift: the round robin
 * and the hot lane write through the SAME function, and a field selected in one
 * but not the other would be `undefined` in half the calls.
 */
const SELECTION = {
  mint: true,
  tier: true,
  status: true,
  allTimeHighUsd: true,
  launchTime: true,
} as const;

type Selected = {
  mint: string;
  tier: string;
  status: string;
  allTimeHighUsd: number | null;
  launchTime: Date;
};

export class MarketSync {
  private readonly task: IntervalTask;
  private readonly hotTask: IntervalTask;
  private readonly boostTask: IntervalTask;
  private readonly paidTask: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig();

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'market-sync' });
    this.task = new IntervalTask(
      'market-sync',
      this.cfg.ingestion.pollIntervalMs,
      () => this.tick(),
      this.log
    );
    /*
     * The hot lane runs at the SAME rate as the round robin rather than faster.
     * Faster would buy very little — DexScreener's own numbers do not update
     * every second — and it would spend the rate limit that the round robin
     * needs to keep the other twelve thousand rows from going stale.
     */
    this.hotTask = new IntervalTask(
      'market-hot',
      this.cfg.ingestion.pollIntervalMs,
      () => this.hot(),
      this.log
    );
    // The boost board is ONE request for the whole chain, so it is cheap enough
    // to run often and far too cheap to justify per-token lookups.
    this.boostTask = new IntervalTask('boost-board', 120_000, () => this.syncBoosts(), this.log);
    // The paid check is metered per token, so it is a slow trickle over tokens
    // that have never been asked about.
    this.paidTask = new IntervalTask('paid-orders', 15_000, () => this.syncPaid(), this.log);
  }

  start(): void {
    this.task.start(true);
    this.hotTask.start(true);
    this.boostTask.start(false);
    this.paidTask.start(false);
  }

  stop(): void {
    this.task.stop();
    this.hotTask.stop();
    this.boostTask.stop();
    this.paidTask.stop();
  }

  private async tick(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { tier: { in: ['SEEDED', 'ACTIVE', 'GRADUATED'] } },
      orderBy: [{ lastActivityAt: { sort: 'asc', nulls: 'first' } }],
      select: SELECTION,
      take: this.cfg.ingestion.batchSize,
    });
    await this.sync(tokens);
  }

  /**
   * The tokens the product has staked something on, priced every pass.
   *
   * THE TWO SETS ARE UNIONED IN SQL, NOT IN JAVASCRIPT, because a token can
   * easily be in both — the auto-trader buys what the calls engine calls — and
   * two `findMany`s stitched together would ask DexScreener about the same mint
   * twice in one request, which silently costs one of the thirty slots.
   *
   * IT IS CAPPED AT THE SAME BATCH SIZE as the round robin, and the cap is
   * ordered so the NEWEST claims win. DexScreener truncates past thirty mints
   * without saying so, and a hot lane that quietly dropped its tail would be
   * worse than no hot lane at all: the dropped rows would still look fresh.
   */
  private async hot(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: {
        OR: [
          { calls: { some: { outcome: 'live' } } },
          // `opening` counts too: a position mid-swap has real money committed
          // and the exit rules read the same price column.
          { positions: { some: { status: { in: ['opening', 'open'] } } } },
        ],
      },
      orderBy: [{ lastActivityAt: { sort: 'asc', nulls: 'first' } }],
      select: SELECTION,
      take: this.cfg.ingestion.batchSize,
    });
    await this.sync(tokens);
  }

  /** One DexScreener request, then one write per token. */
  private async sync(tokens: Selected[]): Promise<void> {
    if (tokens.length === 0) return;

    const pairs = await fetchPairs(tokens.map((t) => t.mint));

    for (const token of tokens) {
      const pair = pairs.get(token.mint);
      if (!pair) {
        /*
         * NOT ON DEXSCREENER. That is the normal answer for a mint that has
         * never had a pool, and it is recorded as a TOUCH rather than as a
         * write of zeros: the row keeps whatever it last knew, and the round
         * robin moves on instead of returning to it every pass.
         */
        await prisma.token
          .update({ where: { mint: token.mint }, data: { lastActivityAt: new Date() } })
          .catch(() => undefined);
        continue;
      }

      try {
        const activates =
          pair.liquidityUsd >= this.cfg.ingestion.activation.minLiquidityUsd ||
          pair.buys24h + pair.sells24h >= this.cfg.ingestion.activation.minTxns24h;

        const data: Prisma.TokenUpdateInput = {
          priceUsd: pair.priceUsd,
          priceSol: pair.priceNative,
          marketCapUsd: pair.marketCapUsd,
          fdvUsd: pair.fdvUsd,
          /*
           * NOT WRITTEN FOR A CURVE. DexScreener reports `liquidity.usd = 0`
           * for a pump.fun curve pair, because it is not a pool — and writing
           * that zero would stamp over the real SOL reserve the curve sync
           * reads out of the curve account itself. The market sync owns this
           * column only once the token has a genuine pool.
           */
          ...(pair.liquidityUsd > 0 || token.status === 'MIGRATED'
            ? { liquidityUsd: pair.liquidityUsd }
            : {}),
          poolAddress: pair.pairAddress,
          dexId: pair.dexId,
          marketCount: pair.marketCount,
          volume5mUsd: pair.volume5mUsd,
          volume1hUsd: pair.volume1hUsd,
          volume6hUsd: pair.volume6hUsd,
          volume24hUsd: pair.volume24hUsd,
          priceChange5m: pair.priceChange5m,
          priceChange1h: pair.priceChange1h,
          priceChange6h: pair.priceChange6h,
          priceChange24h: pair.priceChange24h,
          buys24h: pair.buys24h,
          sells24h: pair.sells24h,
          txns24h: pair.buys24h + pair.sells24h,
          boosts: pair.boosts,
          lastActivityAt: new Date(),
          /*
           * Identity fields are filled ONLY WHERE THEY ARE MISSING, using
           * Prisma's `set` on a conditional rather than overwriting. The
           * launchpad's own name for a token is better than DexScreener's
           * reformatting of it, and a sync that overwrote on every pass would
           * flip a name back and forth between two sources forever.
           */
          ...(pair.name ? { name: pair.name } : {}),
          ...(pair.symbol ? { symbol: pair.symbol, nameState: 'named' } : {}),
          ...(pair.imageUrl ? { imageUrl: pair.imageUrl } : {}),
          ...(pair.websiteUrl ? { websiteUrl: pair.websiteUrl } : {}),
          ...(pair.twitterUrl ? { twitterUrl: pair.twitterUrl } : {}),
          ...(pair.telegramUrl ? { telegramUrl: pair.telegramUrl } : {}),
          ...(activates && token.tier === 'SEEDED' ? { tier: 'ACTIVE' } : {}),
          /*
           * THE ALL-TIME HIGH IS MONOTONIC and is maintained here because this
           * is the only pass that sees every price. Reconstructing it later
           * from stored candles is exactly the work this product avoids by not
           * storing candles.
           */
          ...(pair.priceUsd > (token.allTimeHighUsd ?? 0)
            ? { allTimeHighUsd: pair.priceUsd, allTimeHighAt: new Date() }
            : {}),
          /*
           * DexScreener knows when the PAIR was created, which for a graduated
           * token is its migration rather than its launch. It is used only when
           * we have nothing better, and only when it is EARLIER — a later date
           * would make a token look younger than it is, and age is a gate.
           */
          ...(pair.createdAtMs && pair.createdAtMs < token.launchTime.getTime()
            ? { launchTime: new Date(pair.createdAtMs) }
            : {}),
        };

        await prisma.token.update({ where: { mint: token.mint }, data });
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'market update failed');
      }
    }
  }

  private async syncBoosts(): Promise<void> {
    const board = await fetchBoostBoard();
    for (const [mint, amount] of board) {
      await prisma.token
        .updateMany({ where: { mint }, data: { boosts: amount } })
        .catch(() => undefined);
    }
  }

  private async syncPaid(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { tier: { in: ['ACTIVE', 'GRADUATED'] }, dexCheckedAt: null },
      orderBy: { lastActivityAt: 'desc' },
      select: { mint: true },
      take: 3,
    });

    for (const { mint } of tokens) {
      const types = await fetchPaidOrders(mint);
      /*
       * NULL MEANS THE LOOKUP FAILED AND THE ROW IS LEFT UNTOUCHED, so
       * `dexPaid` stays null and the card keeps showing a dashed chip. Writing
       * `false` here would turn "we could not ask" into "checked, nothing
       * paid", which is a claim.
       */
      if (types === null) continue;
      await prisma.token
        .update({
          where: { mint },
          data: { dexPaid: types.length > 0, dexPaidTypes: types, dexCheckedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }
}
