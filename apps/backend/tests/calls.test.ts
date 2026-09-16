import { describe, expect, it } from 'vitest';
import { callRefusal, tierFor, type CallCandidate } from '../src/calls/gate.js';
import type { CallsConfig } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';

/**
 * THE CALL GATE is the only claim this product makes, so it gets the most
 * literal tests in the suite: each one breaks exactly one fact on a candidate
 * that otherwise fires, and asserts that the refusal names the right reason.
 *
 * The config is the REAL one from configuration.json rather than a fixture, so
 * a threshold changed there without thinking shows up here.
 */
const cfg: CallsConfig = loadConfig().calls;

function candidate(overrides: Partial<CallCandidate> = {}): CallCandidate {
  return {
    symbol: 'TEST',
    score: 85,
    coverage: 100,
    clamped: null,
    liquidityUsd: 40_000,
    marketCapUsd: 250_000,
    holderCount: 3_000,
    ageSeconds: 7_200,
    launchAnalyzed: true,
    clusteredPct: 3,
    sellOk: true,
    rugged: false,
    // A calm, liquid moment: nothing about the timing is a reason to refuse.
    priceChange5m: 1,
    priceChange1h: 6,
    volume1hUsd: 25_000,
    ...overrides,
  };
}

describe('a call fires only when everything clears', () => {
  it('fires on a token that clears every gate', () => {
    expect(callRefusal(candidate(), 'strong_buy', cfg)).toBeNull();
  });
});

describe('the ceiling', () => {
  it('refuses a token that is already enormous', () => {
    /*
     * THE LIVE BUG THIS EXISTS FOR: on its first run against mainnet the engine
     * called PUMP at a $1.67bn market cap. It graded 83.9 honestly — seven
     * hundred thousand holders, twenty million dollars of liquidity — and it is
     * not a call anybody can act on, because the move it would be a call about
     * happened months ago.
     */
    const refusal = callRefusal(candidate({ marketCapUsd: 1_670_000_000 }), 'strong_buy', cfg);
    expect(refusal).toContain('past the ceiling');
  });

  it('still fires on a small token', () => {
    expect(callRefusal(candidate({ marketCapUsd: 120_000 }), 'buy', cfg)).toBeNull();
  });

  it('has NO maximum age — a sleeper waking up is the call worth making', () => {
    const threeWeeks = 21 * 24 * 3_600;
    expect(callRefusal(candidate({ ageSeconds: threeWeeks }), 'strong_buy', cfg)).toBeNull();
  });
});

describe('holders', () => {
  it('refuses a token a handful of wallets hold', () => {
    expect(callRefusal(candidate({ holderCount: 12 }), 'strong_buy', cfg)).toContain('12 holders');
  });

  it('does NOT refuse merely because the holder sync has not run', () => {
    // A null here is our pipeline being behind; the coverage gate already
    // refuses a token whose distribution went unread.
    expect(callRefusal(candidate({ holderCount: null }), 'strong_buy', cfg)).toBeNull();
  });
});

describe('the sell check', () => {
  it('refuses an unconfirmed sell, not only a failed one', () => {
    expect(callRefusal(candidate({ sellOk: null }), 'strong_buy', cfg)).toContain(
      'has not confirmed'
    );
    expect(callRefusal(candidate({ sellOk: false }), 'strong_buy', cfg)).toContain('cannot be sold');
  });
});

describe('coverage and clamps', () => {
  it('refuses a provisional grade however high the number is', () => {
    expect(callRefusal(candidate({ score: 97, coverage: 41 }), 'strong_buy', cfg)).toContain(
      'coverage'
    );
  });

  it('never calls a clamped token', () => {
    /*
     * A clamp means one critical finding disqualified four good pillars. A
     * token that was capped and still cleared a threshold has something
     * critically wrong with it by definition.
     */
    const refusal = callRefusal(
      candidate({ clamped: { at: 45, reason: 'Most of the supply was taken at launch.' } }),
      'buy',
      cfg
    );
    expect(refusal).toContain('capped');
  });
});

describe('the launch analysis', () => {
  it('accepts the insider graph alone, with no first-slot analysis', () => {
    // A deployment with no transaction-history key still gets the funding
    // cluster reading, which is the more predictive of the two.
    expect(
      callRefusal(candidate({ launchAnalyzed: false, clusteredPct: 4 }), 'strong_buy', cfg)
    ).toBeNull();
  });

  it('refuses when neither reading exists', () => {
    expect(
      callRefusal(candidate({ launchAnalyzed: false, clusteredPct: null }), 'strong_buy', cfg)
    ).toContain('launch has not been analysed');
  });
});

describe('tiers', () => {
  it('never fires a watch as a call', () => {
    // A "watch" is not a claim that something is worth buying, and publishing
    // it beside real calls would treble the feed with entries the record would
    // then have to count.
    expect(tierFor(55)).toBeNull();
    expect(tierFor(68)).toBe('buy');
    expect(tierFor(82)).toBe('strong_buy');
  });
});

/**
 * THE TIMING GATES.
 *
 * Measured, not theorised: of the first seventy-nine calls, FORTY-ONE never
 * traded above their entry price and the median peak across the record was
 * 1.00x. Every quality reading — volume, turnover, buy share, traders — peaks
 * at the same instant the price does, so a gate built only from quality
 * thresholds fires at the top of the move by construction. These are the veto
 * on the moment rather than on the token.
 */
describe('the moment, not just the token', () => {
  it('refuses a token that went vertical in the last five minutes', () => {
    const refusal = callRefusal(candidate({ priceChange5m: 140 }), 'strong_buy', cfg);
    expect(refusal).toContain('mid-candle');
  });

  it('refuses a token whose hour has already made the move', () => {
    const refusal = callRefusal(candidate({ priceChange1h: 900 }), 'strong_buy', cfg);
    expect(refusal).toContain('already priced');
  });

  it('refuses a token that qualified on yesterday and is not trading now', () => {
    /*
     * The 24h volume gate cannot see this: a token can do all of its business
     * in one morning burst and read as busy for the rest of the day.
     */
    const refusal = callRefusal(candidate({ volume1hUsd: 40 }), 'strong_buy', cfg);
    expect(refusal).toContain('in the last hour');
  });

  it('fires on a strong token in a calm hour — a rise is not a refusal', () => {
    expect(callRefusal(candidate({ priceChange1h: 35 }), 'strong_buy', cfg)).toBeNull();
  });

  it('lets a NULL through every timing gate', () => {
    /*
     * These columns are maintained by our own market pass, so a null means the
     * row has not been priced yet — us, not the token. Failing closed would
     * make the entire feed conditional on where the round robin happens to be,
     * which is the one dependency a call must not have.
     */
    expect(
      callRefusal(
        candidate({ priceChange5m: null, priceChange1h: null, volume1hUsd: null }),
        'strong_buy',
        cfg
      )
    ).toBeNull();
  });
});
