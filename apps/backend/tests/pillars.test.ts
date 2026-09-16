import { describe, expect, it } from 'vitest';
import type { LaunchAnalysis, SellCheck } from '@rockscreener/shared';
import type { MomentumInput } from '../src/score/pillars.js';
import {
  scoreDistribution,
  scoreLaunch,
  scoreLiquidity,
  scoreMomentum,
  scorePresence,
  scoreSafety,
} from '../src/score/pillars.js';

/**
 * The pillars are pure functions, so these tests state their inputs rather than
 * describing a state of the world. Each one below asserts a rule that the rest
 * of the system depends on being true — most of them about NULL.
 */

const NO_SELL: SellCheck = { ok: null, via: null, impactPct: null, effectiveTaxBps: null, checkedAt: null };

const emptyLaunch: LaunchAnalysis = {
  analyzed: false,
  bundledPct: null,
  bundleWallets: null,
  sniperPct: null,
  sniperWallets: null,
  clusteredPct: null,
  clusters: null,
  stillHeldPct: null,
  creatorPct: null,
  creatorLinkedPct: null,
  bundleSlot: null,
  launchSlot: null,
};

describe('an unmeasured pillar is null, never zero', () => {
  it('returns null for safety when nothing has been read', () => {
    const result = scoreSafety({
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      metadataMutable: null,
      transferFeeBps: null,
      sell: NO_SELL,
      rugged: null,
      criticalRisks: [],
      // A launchpad alone is a reading, so it is absent here too.
      launchpad: 'unknown',
    });
    expect(result.score).toBeNull();
  });

  it('returns null for distribution when no holder data exists', () => {
    expect(scoreDistribution({ top10Pct: null, creatorPct: null, holderCount: null }).score).toBeNull();
  });

  it('returns null for launch when nothing was analysed', () => {
    expect(scoreLaunch(emptyLaunch, null).score).toBeNull();
  });

  it('returns null for momentum below the minimum trade count', () => {
    const result = scoreMomentum(momentum({ buys24h: 3, sells24h: 2, traders24h: 4 }));
    expect(result.score).toBeNull();
  });
});

/**
 * A healthy, unremarkable token: traded all day, calm hour, steady interest.
 * Every test below moves ONE thing away from this and asserts the direction.
 */
function momentum(over: Partial<MomentumInput> = {}): MomentumInput {
  return {
    ageSeconds: 6 * 3_600,
    buys24h: 260,
    sells24h: 240,
    traders24h: 180,
    volume24hUsd: 120_000,
    liquidityUsd: 40_000,
    allTimeHighUsd: 1.1,
    priceUsd: 1,
    volume5mUsd: 900,
    volume1hUsd: 11_000,
    volume6hUsd: 66_000,
    priceChange5m: 0.4,
    priceChange1h: 3,
    priceChange6h: 9,
    ...over,
  };
}

const scoreOf = (over: Partial<MomentumInput> = {}): number => scoreMomentum(momentum(over)).score!;
const codes = (over: Partial<MomentumInput> = {}): string[] =>
  scoreMomentum(momentum(over)).findings.map((f) => f.code);

/**
 * THE ENTRY-TIMING TERMS.
 *
 * These exist because the first seventy-nine calls had a MEDIAN PEAK OF 1.00x —
 * half of them never traded above their entry price, not even briefly. The
 * pillar read nothing but 24-hour totals, so every signal it had peaked at the
 * same instant the price did, and the engine called tokens at the top of their
 * own move. Each test below is one of those instants.
 */
describe('momentum: where in its arc the token is', () => {
  it('scores a vertical hour BELOW a calm one — the move is already priced', () => {
    expect(scoreOf({ priceChange1h: 300 })).toBeLessThan(scoreOf({ priceChange1h: 3 }));
    expect(codes({ priceChange1h: 300 })).toContain('already_ran');
  });

  it('penalises harder the further it has run', () => {
    expect(scoreOf({ priceChange1h: 400 })).toBeLessThan(scoreOf({ priceChange1h: 120 }));
  });

  it('treats a five-minute spike as its own, separate warning', () => {
    /*
     * The pair below reports a similar 1h number and they are opposite trades:
     * one climbed steadily, the other was flat for fifty-five minutes and then
     * went vertical. A pillar that read only the hour could not tell them apart
     * — and the spike is the one that pushes a token over the grade threshold.
     */
    const steady = scoreOf({ priceChange1h: 30, priceChange5m: 2 });
    const spiking = scoreOf({ priceChange1h: 30, priceChange5m: 90 });
    expect(spiking).toBeLessThan(steady);
    expect(codes({ priceChange5m: 90 })).toContain('spiking');
  });

  it('scores building interest above fading interest', () => {
    const building = scoreOf({ volume1hUsd: 30_000, volume6hUsd: 60_000 });
    const fading = scoreOf({ volume1hUsd: 2_000, volume6hUsd: 60_000 });
    expect(building).toBeGreaterThan(fading);
    expect(codes({ volume1hUsd: 2_000, volume6hUsd: 60_000 })).toContain('fading');
  });

  it('reads nothing from the older window rather than zero when the buckets disagree', () => {
    /*
     * DexScreener's 1h bucket can briefly exceed its 6h bucket. Deriving the
     * earlier rate by subtraction gives a negative there, and treating that as
     * "no trading before this hour" would read as infinite acceleration — the
     * strongest possible buy signal, manufactured out of a feed glitch.
     */
    const glitched = scoreOf({ volume1hUsd: 70_000, volume6hUsd: 60_000 });
    const neutral = scoreOf({ volume1hUsd: 0, volume6hUsd: 0 });
    expect(Number.isFinite(glitched)).toBe(true);
    expect(glitched).toBeLessThanOrEqual(neutral + 20);
  });

  it('calls churn what is volume without depth', () => {
    expect(codes({ volume24hUsd: 4_000_000, liquidityUsd: 40_000 })).toContain('churn');
    expect(scoreOf({ volume24hUsd: 4_000_000, liquidityUsd: 40_000 })).toBeLessThan(
      scoreOf({ volume24hUsd: 120_000, liquidityUsd: 40_000 })
    );
  });

  it('does not mistake a flat hour on a collapsing token for accumulation', () => {
    expect(scoreOf({ priceChange1h: 1, priceChange6h: -80 })).toBeLessThan(
      scoreOf({ priceChange1h: 1, priceChange6h: 9 })
    );
    expect(codes({ priceChange6h: -80 })).toContain('bleeding');
  });

  it('still bounds to 0..100 at every extreme', () => {
    const worst = scoreOf({
      priceChange5m: 900,
      priceChange1h: 4_000,
      priceChange6h: -99,
      volume1hUsd: 1,
      volume6hUsd: 900_000,
      volume24hUsd: 90_000_000,
      buys24h: 20,
      sells24h: 480,
      traders24h: 3,
      allTimeHighUsd: 100,
      priceUsd: 1,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(scoreOf({ traders24h: 5_000, priceChange1h: 2 })).toBeLessThanOrEqual(100);
  });
});

describe('safety', () => {
  const base = {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataMutable: false,
    transferFeeBps: 0,
    rugged: false,
    criticalRisks: [] as string[],
    launchpad: 'pumpfun',
  };

  it('a live freeze authority is critical and dominates every positive', () => {
    const clean = scoreSafety({ ...base, sell: { ...NO_SELL, ok: true, via: 'observed_sells' } });
    const frozen = scoreSafety({
      ...base,
      freezeAuthorityRevoked: false,
      sell: { ...NO_SELL, ok: true, via: 'observed_sells' },
    });

    expect(frozen.score!).toBeLessThan(clean.score!);
    expect(frozen.findings.some((f) => f.code === 'freeze_authority' && f.severity === 'critical')).toBe(
      true
    );
  });

  it('an unroutable sell zeroes the pillar rather than being averaged away', () => {
    const result = scoreSafety({ ...base, sell: { ...NO_SELL, ok: false, via: 'route_quote' } });
    // Every other input here is perfect. The pillar is still zero.
    expect(result.score).toBe(0);
  });

  it('an unchecked sell is NOT treated as a pass', () => {
    const confirmed = scoreSafety({ ...base, sell: { ...NO_SELL, ok: true, via: 'observed_sells' } });
    const unchecked = scoreSafety({ ...base, sell: NO_SELL });
    expect(unchecked.score!).toBeLessThan(confirmed.score!);
    expect(unchecked.findings.some((f) => f.code === 'sell_unchecked')).toBe(true);
  });

  it('a route that exists but costs a fortune is penalised', () => {
    const cheap = scoreSafety({
      ...base,
      sell: { ok: true, via: 'route_quote', impactPct: 1, effectiveTaxBps: 100, checkedAt: null },
    });
    const brutal = scoreSafety({
      ...base,
      sell: { ok: true, via: 'route_quote', impactPct: 35, effectiveTaxBps: 3_500, checkedAt: null },
    });
    expect(brutal.score!).toBeLessThan(cheap.score!);
    expect(brutal.findings.some((f) => f.code === 'thin_exit')).toBe(true);
  });
});

describe('launch', () => {
  it('scores on the funding cluster alone, with no first-slot analysis', () => {
    const result = scoreLaunch({ ...emptyLaunch, clusteredPct: 31, clusters: 3 }, null);
    // This is the reading a deployment without a history key still gets, and it
    // is the most predictive one available.
    expect(result.score).not.toBeNull();
    expect(result.findings.some((f) => f.code === 'funding_cluster')).toBe(true);
  });

  it('a measured zero cluster reading is a positive, not a missing one', () => {
    const measured = scoreLaunch({ ...emptyLaunch, clusteredPct: 0, clusters: 0 }, null);
    expect(measured.score).not.toBeNull();
    expect(measured.findings.some((f) => f.code === 'no_clusters')).toBe(true);
  });

  it('the penalty ramps rather than stepping at a threshold', () => {
    const mild = scoreLaunch({ ...emptyLaunch, analyzed: true, bundledPct: 10 }, null).score!;
    const bad = scoreLaunch({ ...emptyLaunch, analyzed: true, bundledPct: 25 }, null).score!;
    const awful = scoreLaunch({ ...emptyLaunch, analyzed: true, bundledPct: 45 }, null).score!;

    expect(mild).toBeGreaterThan(bad);
    expect(bad).toBeGreaterThan(awful);
    /*
     * THE REGRESSION THIS CATCHES: an earlier version of `ramp` bounded its
     * OUTPUT to 0..100, which floored every negative delta at zero — so the
     * whole bad half of every penalty ramp did nothing, and a 45% bundle scored
     * exactly the same as a 25% one.
     */
    expect(awful).toBeLessThan(bad - 5);
  });
});

describe('liquidity', () => {
  it('scores a bonding token on curve progress, not on pool depth', () => {
    const early = scoreLiquidity({
      liquidityUsd: 0,
      marketCapUsd: 20_000,
      lpLockedPct: null,
      marketCount: 0,
      bonding: true,
      progressBps: 1_000,
    });
    const nearly = scoreLiquidity({
      liquidityUsd: 0,
      marketCapUsd: 60_000,
      lpLockedPct: null,
      marketCount: 0,
      bonding: true,
      progressBps: 9_000,
    });
    // A curve has no LP to lock; scoring it on pool metrics would mark every
    // bonding token as having no liquidity at all.
    expect(nearly.score!).toBeGreaterThan(early.score!);
  });

  it('treats unlocked liquidity as critical and unknown as merely unproven', () => {
    const shape = { liquidityUsd: 40_000, marketCapUsd: 400_000, marketCount: 1, bonding: false, progressBps: 0 };
    const unlocked = scoreLiquidity({ ...shape, lpLockedPct: 0 });
    const unknown = scoreLiquidity({ ...shape, lpLockedPct: null });
    const locked = scoreLiquidity({ ...shape, lpLockedPct: 100 });

    expect(unlocked.findings.some((f) => f.severity === 'critical')).toBe(true);
    expect(unknown.score!).toBeGreaterThan(unlocked.score!);
    expect(locked.score!).toBeGreaterThan(unknown.score!);
  });
});

describe('presence', () => {
  it('an unchecked token gets exactly zero and no findings', () => {
    const result = scorePresence({ paid: null, paidTypes: [], boosts: 0, liquidityUsd: 10_000 });
    expect(result.delta).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('adverts move the score by nothing at all', () => {
    const result = scorePresence({
      paid: true,
      paidTypes: ['tokenAd', 'trendingBarAd'],
      boosts: 0,
      liquidityUsd: 50_000,
    });
    // Reported as a fact, scored as nothing: a paid advert is as likely to be a
    // marketing budget as an exit being funded.
    expect(result.delta).toBe(0);
    expect(result.findings.some((f) => f.code === 'dex_ad')).toBe(true);
  });

  it('is bounded whatever combination is thrown at it', () => {
    const result = scorePresence({
      paid: true,
      paidTypes: ['tokenProfile', 'communityTakeover', 'tokenAd', 'trendingBarAd'],
      boosts: 500,
      liquidityUsd: 900,
    });
    expect(Math.abs(result.delta)).toBeLessThanOrEqual(5);
  });
});

describe('readings that are computable but meaningless', () => {
  it('refuses to credit concentration on a token with three holders', () => {
    /*
     * THE BUG THIS EXISTS FOR, found on live data: a freshly graduated token
     * with 3 holders scored 97/100 on distribution, because a top-ten share of
     * 3.4% looks like a beautifully spread supply. There is nothing to
     * concentrate. It is not a well-distributed token, it is a token nobody
     * holds.
     */
    const tiny = scoreDistribution({ top10Pct: 3.4, creatorPct: 0, holderCount: 3 });
    const real = scoreDistribution({ top10Pct: 18, creatorPct: 0.4, holderCount: 900 });

    expect(tiny.score!).toBeLessThan(45);
    expect(real.score!).toBeGreaterThan(tiny.score!);
    expect(tiny.findings.some((f) => f.code === 'too_few_to_read')).toBe(true);
  });

  it('still separates two tokens below the floor by holder count', () => {
    const three = scoreDistribution({ top10Pct: 3, creatorPct: 0, holderCount: 3 });
    const twenty = scoreDistribution({ top10Pct: 30, creatorPct: 0, holderCount: 20 });
    // Twenty holders is worse-looking on concentration and better on substance.
    expect(twenty.score!).toBeGreaterThan(three.score!);
  });

  it('treats an empty pool as a measured zero, never as a missing reading', () => {
    /*
     * THE OTHER LIVE BUG: `liquidityUsd: 0` returned null, which renormalised
     * the worst pillar out of the weighted average — so a token with a pool and
     * nothing in it scored HIGHER than one with a thin pool.
     */
    const empty = scoreLiquidity({
      liquidityUsd: 0,
      marketCapUsd: 3_000,
      lpLockedPct: 100,
      marketCount: 1,
      bonding: false,
      progressBps: 0,
    });
    expect(empty.score).toBe(0);
    expect(empty.findings.some((f) => f.code === 'no_liquidity' && f.severity === 'critical')).toBe(
      true
    );
  });
});

describe('the pillars must keep discriminating', () => {
  /*
   * A REGRESSION GUARD ON SATURATION, written after measuring live data: half
   * the index (1,939 of 3,989 scored tokens) sat at 95 or above on safety,
   * because revoked authorities, no transfer fee and a known launchpad are
   * nearly free on this chain — and a fact true of 99% of a population
   * separates nothing.
   *
   * These tests pin the SHAPE rather than the exact numbers, so a deliberate
   * retune passes and an accidental drift back to the ceiling does not.
   */
  const ordinaryPumpFun = {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataMutable: false,
    transferFeeBps: 0,
    rugged: false,
    criticalRisks: [] as string[],
    launchpad: 'pumpfun',
  };

  it('does not max out safety on facts every token on the chain has', () => {
    const confirmed = scoreSafety({
      ...ordinaryPumpFun,
      sell: { ok: true, via: 'observed_sells', impactPct: null, effectiveTaxBps: null, checkedAt: null },
    });
    // Room left above it, so a better token can still be told from this one.
    expect(confirmed.score!).toBeLessThan(85);
  });

  it('leaves a wide gap between a confirmed exit and an unchecked one', () => {
    const confirmed = scoreSafety({
      ...ordinaryPumpFun,
      sell: { ok: true, via: 'observed_sells', impactPct: null, effectiveTaxBps: null, checkedAt: null },
    });
    const unchecked = scoreSafety({ ...ordinaryPumpFun, sell: NO_SELL });

    /*
     * THE PILLAR'S WHOLE JOB. Everything else about these two tokens is
     * identical; one has been shown to be sellable and one has not, and that is
     * the fact worth paying for.
     */
    expect(confirmed.score! - unchecked.score!).toBeGreaterThanOrEqual(25);
  });

  it('does not max out distribution below a genuinely exceptional holder base', () => {
    const good = scoreDistribution({ top10Pct: 18, creatorPct: 0.2, holderCount: 400 });
    // Good, not perfect: four hundred holders is a healthy launch, not the top
    // of the scale, and the pillar has to keep room for the token with four
    // thousand.
    expect(good.score!).toBeLessThan(92);

    const exceptional = scoreDistribution({ top10Pct: 12, creatorPct: 0, holderCount: 4_000 });
    expect(exceptional.score!).toBeGreaterThan(good.score!);
  });

  it('weights holder count above concentration, because it is harder to fake', () => {
    // Splitting a bag across wallets buys a low top-ten share for a few cents;
    // two thousand genuine holders cannot be bought at all.
    const fewHoldersSpread = scoreDistribution({ top10Pct: 8, creatorPct: 0, holderCount: 40 });
    const manyHoldersConcentrated = scoreDistribution({
      top10Pct: 38,
      creatorPct: 0,
      holderCount: 3_000,
    });
    expect(manyHoldersConcentrated.score!).toBeGreaterThan(fewHoldersSpread.score!);
  });

  it('reads a bonding curve on its depth as well as its progress', () => {
    const shape = { marketCapUsd: 40_000, lpLockedPct: null, marketCount: 0, bonding: true, progressBps: 3_000 };
    // Same progress, different money actually in the curve.
    const thin = scoreLiquidity({ ...shape, liquidityUsd: 600 });
    const deep = scoreLiquidity({ ...shape, liquidityUsd: 14_000 });
    expect(deep.score!).toBeGreaterThan(thin.score!);
  });
});
