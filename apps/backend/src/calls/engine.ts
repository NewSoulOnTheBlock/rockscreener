import type { Call as CallRow, Token } from '@prisma/client';
import { CALL_THRESHOLD, type CallTier } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { seedSpark } from '../sources/geckoterminal.js';
import { callRefusal, tierFor } from './gate.js';

/**
 * THE CALLS ENGINE — the only thing in this product that makes a claim.
 *
 * A SCORE IS NOT A SIGNAL. A score is a continuous opinion that changes every
 * minute and is therefore never wrong; a CALL is a moment — "at 14:02, at a
 * $38K market cap, this was worth buying" — which can be measured afterwards
 * and can be wrong. The predecessor to this product listed every token it had
 * indexed and let the reader do the selecting, which is not a signal, it is a
 * database with a sort order.
 *
 * SO A CALL IS RARE BY CONSTRUCTION. Every gate in `wouldFire` has to pass, and
 * most launches never clear all of them. That is the point: a feed that called
 * a hundred tokens a day would be the database again, wearing a badge.
 *
 * AND EVERY CALL IS TRACKED FOREVER, including the ones that went to zero.
 * `track()` runs on every live call whatever it is doing, and a rugged call
 * keeps its row, its entry price and its multiple. The record above the feed
 * counts them all the same way, because a product that publishes only the calls
 * that worked is an advertisement.
 */
export class CallsEngine {
  private readonly fireTask: IntervalTask;
  private readonly trackTask: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig().calls;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'calls' });
    this.fireTask = new IntervalTask('calls-fire', this.cfg.intervalMs, () => this.fire(), this.log);
    /*
     * TRACKING RUNS AT TWICE THE RATE OF FIRING, and the asymmetry is the same
     * one the trading engine makes: a missed call costs an opportunity, a
     * missed peak costs the record its accuracy — and the record is the only
     * reason to believe the calls.
     */
    this.trackTask = new IntervalTask(
      'calls-track',
      Math.max(2_000, Math.floor(this.cfg.intervalMs / 2)),
      () => this.track(),
      this.log
    );
  }

  start(): void {
    this.trackTask.start(true);
    this.fireTask.start(false);
  }

  stop(): void {
    this.fireTask.stop();
    this.trackTask.stop();
  }

  // -------------------------------------------------------------------- fire

  private async fire(): Promise<void> {
    /*
     * The SQL narrows to a superset of what could possibly fire — the score
     * floor of the weakest tier, plus the cheap indexable gates. `wouldFire`
     * owns every real rule, so that the reasons a token did not get called are
     * all in one readable function rather than split between here and a query.
     */
    const candidates = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        score: { gte: CALL_THRESHOLD.watch },
        coverage: { gte: this.cfg.minCoverage },
        liquidityUsd: { gte: this.cfg.minLiquidityUsd },
        marketCapUsd: { lte: this.cfg.maxMarketCapUsd },
        launchTime: { lt: new Date(Date.now() - this.cfg.minAgeSeconds * 1_000) },
      },
      orderBy: { score: 'desc' },
      take: 60,
    });

    for (const token of candidates) {
      try {
        const tier = tierFor(token.score ?? 0);
        if (!tier) continue;

        const reason = callRefusal(
          {
            symbol: token.symbol,
            score: token.score,
            coverage: token.coverage,
            clamped: token.clamped,
            liquidityUsd: token.liquidityUsd,
            marketCapUsd: token.marketCapUsd,
            holderCount: token.holderCount,
            ageSeconds: (Date.now() - token.launchTime.getTime()) / 1_000,
            launchAnalyzed: token.launchAnalyzed,
            clusteredPct: token.clusteredPct,
            sellOk: token.sellOk,
            rugged: token.rugged,
            priceChange5m: token.priceChange5m,
            priceChange1h: token.priceChange1h,
            volume1hUsd: token.volume1hUsd,
          },
          tier,
          this.cfg
        );
        if (reason) continue;

        /*
         * ONE CALL PER TOKEN PER TIER, enforced by a unique index rather than
         * by a read-then-write. A token that strengthens from `buy` to
         * `strong_buy` earns a SECOND row, because those are two different
         * claims made at two different prices; a token merely wobbling across
         * one threshold gets one.
         */
        const existing = await prisma.call.findUnique({
          where: { mint_tier: { mint: token.mint, tier } },
        });
        if (existing) continue;

        /*
         * THE RE-ARM WINDOW stops a call becoming a stream. Without it a token
         * oscillating around 68 would fire, be invalidated at 67, and fire
         * again at 69 — a dozen "calls" on one token in an afternoon, each of
         * which would count separately in the record.
         */
        const recent = await prisma.call.findFirst({
          where: {
            mint: token.mint,
            calledAt: { gt: new Date(Date.now() - this.cfg.rearmHours * 3_600_000) },
          },
        });
        if (recent) continue;

        await this.open(token, tier);
      } catch (err) {
        this.log.warn({ mint: token.mint, err: errField(err) }, 'call evaluation failed');
      }
    }
  }

  private async open(token: Token, tier: CallTier): Promise<void> {
    const price = token.priceUsd ?? 0;
    const marketCap = token.marketCapUsd ?? 0;
    if (!(price > 0) || !(marketCap > 0)) return;

    const call = await prisma.call.create({
      data: {
        mint: token.mint,
        tier,
        score: token.score ?? 0,
        coverage: token.coverage ?? 0,
        headline: token.topWarning,
        entryPriceUsd: price,
        entryMarketCapUsd: marketCap,
        entryLiquidityUsd: token.liquidityUsd ?? 0,
        // Peak and trough START AT THE ENTRY, not at zero or at infinity. A
        // call that has never moved has a peak multiple of exactly 1, which is
        // the honest reading, and a trough seeded at 0 would report a -100%
        // drawdown on a call made four seconds ago.
        peakPriceUsd: price,
        peakMarketCapUsd: marketCap,
        lastPriceUsd: price,
        lastMarketCapUsd: marketCap,
        troughPriceUsd: price,
        spark: [1],
      },
    });

    this.log.info(
      { mint: token.mint, symbol: token.symbol, tier, score: token.score, marketCap },
      'call fired'
    );

    /*
     * Seeding the sparkline is best-effort and deliberately NOT awaited into
     * the write above: a call is a claim about a moment, and delaying the
     * moment to fetch a nicer picture of it would be the wrong trade. If the
     * seed fails the card starts as a flat mark and fills in as it is tracked.
     */
    if (token.poolAddress) {
      void seedSpark(token.poolAddress, price, this.cfg.sparkPoints)
        .then(async (series) => {
          if (series.length < 2) return;
          await prisma.call.update({
            where: { id: call.id },
            data: { spark: [...series.slice(-this.cfg.sparkPoints + 1), 1] },
          });
        })
        .catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------- track

  /**
   * Every live call, on every pass.
   *
   * THE PEAK AND THE TROUGH ARE MONOTONIC and are updated before any outcome is
   * decided, so a call that rugs still records the peak it reached on the way.
   * Deciding the outcome first and then returning early — the obvious ordering —
   * would silently understate the record of every call that ended badly, which
   * is the one direction a track record must never be wrong in.
   */
  private async track(): Promise<void> {
    const live = await prisma.call.findMany({
      where: { outcome: 'live' },
      include: { token: true },
      take: 300,
    });

    for (const call of live) {
      try {
        await this.trackOne(call, call.token);
      } catch (err) {
        this.log.warn({ call: call.id, err: errField(err) }, 'call tracking failed');
      }
    }
  }

  private async trackOne(call: CallRow, token: Token): Promise<void> {
    const price = token.priceUsd ?? 0;
    const marketCap = token.marketCapUsd ?? 0;
    // A price that has gone to zero in the feed is usually a feed problem, not
    // a token problem. The rug test below reads LIQUIDITY, which does not
    // evaporate for the same reasons a price lookup does.
    if (!(price > 0)) return;

    const peakPriceUsd = Math.max(call.peakPriceUsd, price);
    const troughPriceUsd = Math.min(call.troughPriceUsd, price);
    const multiple = price / call.entryPriceUsd;

    // The sparkline is a ring buffer of multiples. It is appended on a tick
    // rather than on every price change, so a call's card has a bounded and
    // evenly spaced history rather than a dense one for busy tokens.
    const spark = [...call.spark, multiple].slice(-this.cfg.sparkPoints);

    const outcome = this.outcomeFor(call, token, multiple);

    await prisma.call.update({
      where: { id: call.id },
      data: {
        lastPriceUsd: price,
        lastMarketCapUsd: marketCap,
        peakPriceUsd,
        peakMarketCapUsd: Math.max(call.peakMarketCapUsd, marketCap),
        ...(peakPriceUsd > call.peakPriceUsd ? { peakAt: new Date() } : {}),
        troughPriceUsd,
        spark,
        ...(outcome
          ? { outcome: outcome.outcome, closedAt: new Date(), closeReason: outcome.reason }
          : {}),
      },
    });

    if (outcome) {
      this.log.info(
        { call: call.id, mint: call.mint, outcome: outcome.outcome, multiple: multiple.toFixed(2) },
        'call closed'
      );
    }
  }

  /**
   * How a call ends, WORST NEWS FIRST.
   *
   * The order is the rule. A token that both rugged and fell below the score
   * floor should be recorded as RUGGED — that is the more specific and the more
   * damning fact, and a record that logged it as "invalidated" would be
   * describing its own opinion changing rather than the money disappearing.
   */
  private outcomeFor(
    call: CallRow,
    token: Token,
    multiple: number
  ): { outcome: 'rugged' | 'invalidated' | 'settled'; reason: string } | null {
    const liquidity = token.liquidityUsd ?? 0;

    /*
     * RUGGED: the liquidity that existed at the call is gone, or the token has
     * stopped being sellable. Measured against the liquidity AT THE CALL rather
     * than against an absolute floor — a call made on a $20k pool and a call
     * made on a $2M pool both rug when most of what backed them leaves.
     */
    if (
      call.entryLiquidityUsd > 0 &&
      liquidity < call.entryLiquidityUsd * (1 - this.cfg.ruggedLiquidityDrop)
    ) {
      return {
        outcome: 'rugged',
        reason: `Liquidity fell from $${Math.round(call.entryLiquidityUsd).toLocaleString('en-US')} to $${Math.round(liquidity).toLocaleString('en-US')}.`,
      };
    }
    if (token.sellOk === false || token.rugged === true) {
      return { outcome: 'rugged', reason: 'The token stopped being sellable.' };
    }

    /*
     * INVALIDATED: the grade collapsed under the call. This is the product
     * changing its mind, and it is recorded as a different thing from a rug
     * because it is — "the liquidity left" and "we were wrong" are not the same
     * event, and a reader deciding whether to trust the feed needs to see which
     * happened.
     */
    if ((token.score ?? 0) < this.cfg.invalidateBelowScore) {
      return {
        outcome: 'invalidated',
        reason: `The grade fell to ${Math.round(token.score ?? 0)}.`,
      };
    }

    /*
     * STAGNANT. A call that has not moved ten percent in either direction after
     * the stagnation window is not working, and holding it is an opportunity
     * cost rather than a risk. It is recorded as INVALIDATED rather than
     * settled, because the call was a claim that this was worth buying NOW and
     * it demonstrably was not.
     *
     * This is also the signal auto-trade's `exitOnCallWithdrawn` acts on — and
     * it is defined here, once, rather than duplicated as a pair of user
     * settings. The user chooses whether to follow the retraction, not what a
     * retraction is.
     */
    const ageMinutes = (Date.now() - call.calledAt.getTime()) / 60_000;
    if (ageMinutes >= this.cfg.stagnantAfterMinutes && Math.abs(multiple - 1) < 0.1) {
      return {
        outcome: 'invalidated',
        reason: `${Math.round(ageMinutes)} minutes on and it has not moved. The call no longer stands.`,
      };
    }

    /*
     * SETTLED: tracked to the end of its window and closed on its own numbers.
     * This is the only ending that is not a judgement — the call ran its course
     * and the record keeps whatever it did.
     */
    if (ageMinutes >= this.cfg.trackHours * 60) {
      return {
        outcome: 'settled',
        reason: `Tracked for ${this.cfg.trackHours} hours and closed at ${multiple.toFixed(2)}x.`,
      };
    }

    return null;
  }
}
