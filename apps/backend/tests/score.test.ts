import { describe, expect, it } from 'vitest';
import { ROCK_WEIGHTS, type LaunchAnalysis, type SellCheck } from '@rockscreener/shared';
import { computeScore, creatorReputation, topWarning } from '../src/score/score.js';

const SELL_OK: SellCheck = {
  ok: true,
  via: 'observed_sells',
  impactPct: 2,
  effectiveTaxBps: 200,
  checkedAt: new Date().toISOString(),
};

const launch: LaunchAnalysis = {
  analyzed: true,
  bundledPct: 4,
  bundleWallets: 2,
  sniperPct: 8,
  sniperWallets: 5,
  clusteredPct: 2,
  clusters: 1,
  stillHeldPct: 1,
  creatorPct: 0.4,
  creatorLinkedPct: 0,
  bundleSlot: 1,
  launchSlot: 0,
};

function request(overrides: Partial<Parameters<typeof computeScore>[0]> = {}) {
  return computeScore({
    mint: 'TestMint1111111111111111111111111111111111',
    safety: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      metadataMutable: false,
      transferFeeBps: 0,
      sell: SELL_OK,
      rugged: false,
      criticalRisks: [],
      launchpad: 'pumpfun',
    },
    liquidity: {
      liquidityUsd: 60_000,
      marketCapUsd: 400_000,
      lpLockedPct: 100,
      marketCount: 2,
      bonding: false,
      progressBps: 0,
    },
    distribution: { top10Pct: 18, creatorPct: 0.4, holderCount: 900 },
    momentum: {
      ageSeconds: 86_400,
      buys24h: 600,
      sells24h: 400,
      traders24h: 300,
      volume24hUsd: 200_000,
      liquidityUsd: 60_000,
      allTimeHighUsd: 1,
      priceUsd: 0.9,
    },
    launch,
    creator: null,
    sell: SELL_OK,
    presence: null,
    ...overrides,
  });
}

describe('coverage', () => {
  it('is 100 when all five pillars were measured', () => {
    expect(request().coverage).toBe(100);
  });

  it('falls, and the score is still computed, when pillars are missing', () => {
    const partial = request({ distribution: null, momentum: null });
    /*
     * DERIVED FROM THE WEIGHTS, NOT TYPED IN. Coverage is by definition the
     * share of the weight that was measured, so writing the number here would
     * make this test fail every time the weights are recalibrated — which is
     * exactly when it should keep passing, because the RULE has not changed.
     * The number is not what is being protected; the identity is.
     */
    const measured = ROCK_WEIGHTS.safety + ROCK_WEIGHTS.launch + ROCK_WEIGHTS.liquidity;
    expect(partial.coverage).toBe(Math.round(measured * 100));
    expect(partial.score).toBeGreaterThan(0);
  });

  it('is NOT raised by the presence adjustment', () => {
    const withPresence = request({
      presence: { paid: true, paidTypes: ['tokenProfile'], boosts: 0, liquidityUsd: 60_000 },
    });
    // Somebody buying a profile must not make a token look better MEASURED.
    expect(withPresence.coverage).toBe(100);
  });

  it('renormalises rather than substituting a neutral value', () => {
    /*
     * ASSERTED AS THE INVARIANT ITSELF rather than as a direction.
     *
     * An earlier version of this test said "dropping momentum should raise the
     * score, because momentum is the weakest pillar and this token scores well
     * on it" — which was true of one calibration and stopped being true when
     * the safety weights were retuned. The test then failed for a change that
     * was correct, which is the worst kind of test.
     *
     * The rule being protected is exact and has nothing to do with the
     * numbers: the total is the weighted mean OVER THE MEASURED PILLARS,
     * renormalised to their own weights. Substituting a neutral 50 for a
     * missing one would break this at any calibration.
     */
    const expectMatchesRenormalisedMean = (result: ReturnType<typeof request>): void => {
      let weighted = 0;
      let used = 0;
      for (const key of Object.keys(ROCK_WEIGHTS) as (keyof typeof ROCK_WEIGHTS)[]) {
        const value = result.pillars[key];
        if (value === null) continue;
        weighted += value * ROCK_WEIGHTS[key];
        used += ROCK_WEIGHTS[key];
      }
      expect(result.score).toBeCloseTo(Math.round((weighted / used) * 10) / 10, 1);
    };

    expectMatchesRenormalisedMean(request());
    expectMatchesRenormalisedMean(request({ momentum: null }));
    expectMatchesRenormalisedMean(request({ momentum: null, distribution: null }));
  });
});

describe('clamps', () => {
  it('a live freeze authority caps a token that is otherwise excellent', () => {
    const clean = request();
    const frozen = request({
      safety: {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: false,
        metadataMutable: false,
        transferFeeBps: 0,
        sell: SELL_OK,
        rugged: false,
        criticalRisks: [],
        launchpad: 'pumpfun',
      },
    });

    expect(clean.score).toBeGreaterThan(60);
    expect(frozen.clamped).not.toBeNull();
    expect(frozen.score).toBeLessThanOrEqual(frozen.clamped!.at);
  });

  it('the lowest applicable ceiling wins when two criticals fire', () => {
    const result = request({
      safety: {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        metadataMutable: true,
        transferFeeBps: 0,
        sell: { ...SELL_OK, ok: false, via: 'route_quote' },
        rugged: false,
        criticalRisks: [],
        launchpad: 'unknown',
      },
    });
    // `no_exit` caps at 5; the freeze clamp at 18. Two criticals do not cancel.
    expect(result.clamped?.at).toBe(5);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('a moderate bundle does not clamp, only an extreme one does', () => {
    const moderate = request({ launch: { ...launch, bundledPct: 16 } });
    const extreme = request({ launch: { ...launch, bundledPct: 55 } });
    /*
     * The distinction this protects: without the severity check, a 16% bundle
     * would be capped at 45 alongside a 55% one, and the grade would stop
     * telling them apart at exactly the range where it matters.
     */
    expect(moderate.clamped).toBeNull();
    expect(extreme.clamped).not.toBeNull();
  });

  it('the presence bonus cannot lift a token back over its ceiling', () => {
    const result = request({
      safety: {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: false,
        metadataMutable: false,
        transferFeeBps: 0,
        sell: SELL_OK,
        rugged: false,
        criticalRisks: [],
        launchpad: 'pumpfun',
      },
      presence: { paid: true, paidTypes: ['tokenProfile'], boosts: 0, liquidityUsd: 60_000 },
    });
    expect(result.score).toBeLessThanOrEqual(result.clamped!.at);
  });
});

describe('findings', () => {
  it('are ordered worst-first with the positives last', () => {
    const result = request({ launch: { ...launch, bundledPct: 30, clusteredPct: 20 } });
    const severities = result.findings.map((f) => f.severity);
    const firstGood = severities.indexOf('good');
    if (firstGood !== -1) {
      // Nothing after the first `good` may be worse than `good`.
      expect(severities.slice(firstGood).every((s) => s === 'good')).toBe(true);
    }
  });

  it('topWarning skips the positives and the noise', () => {
    const result = request({ launch: { ...launch, bundledPct: 30 } });
    const warning = topWarning(result.findings);
    expect(warning).not.toBeNull();
    expect(result.findings.find((f) => f.message === warning)?.severity).not.toBe('good');
  });
});

describe('creator reputation', () => {
  it('is null on a first launch — one launch is not a record', () => {
    expect(creatorReputation(1, 0, 0)).toBeNull();
    expect(creatorReputation(1, 1, 0)).toBeNull();
  });

  it('names a serial rugger only with enough launches to mean it', () => {
    expect(creatorReputation(2, 2, 0)).toBe('suspect');
    expect(creatorReputation(5, 4, 0)).toBe('serial_rugger');
  });

  it('calls a creator trusted only on survivors', () => {
    expect(creatorReputation(4, 0, 3)).toBe('trusted');
    expect(creatorReputation(4, 0, 0)).toBe('neutral');
  });

  it('names a token factory, which rugs nothing because nothing gets far', () => {
    /*
     * FROM LIVE DATA: one address in the index had launched 81 tokens with a
     * single rug and not one survivor, and read as "neutral". `rugged` is
     * deliberately narrow — it requires a token to have reached a real
     * valuation first — so a creator whose launches never go anywhere escapes
     * it entirely.
     */
    expect(creatorReputation(81, 1, 0)).toBe('suspect');
    expect(creatorReputation(8, 0, 0)).toBe('suspect');
    // Under the floor it is still just a quiet run, not a verdict.
    expect(creatorReputation(5, 0, 0)).toBe('neutral');
    // And one survivor is enough to stop it being a factory.
    expect(creatorReputation(20, 0, 1)).toBe('neutral');
  });
});
