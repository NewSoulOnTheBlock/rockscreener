import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_TRADE } from '@rockscreener/shared';
import { evaluateEntry, type EntryCandidate } from '../src/autotrade/entry.js';

const rules = DEFAULT_AUTO_TRADE.entry;

/** A candidate that passes everything, so each test can break exactly one thing. */
function candidate(overrides: Partial<EntryCandidate> = {}): EntryCandidate {
  return {
    mint: 'TestMint1111111111111111111111111111111111',
    symbol: 'TEST',
    launchpad: 'pumpfun',
    score: 84,
    tier: 'diamond',
    coverage: 95,
    liquidityUsd: 80_000,
    marketCapUsd: 400_000,
    ageSeconds: 3_600,
    holderCount: 500,
    traders24h: 200,
    top10Pct: 20,
    bundledPct: 4,
    clusteredPct: 3,
    creatorPct: 1,
    creatorLinkedPct: 0,
    lpLockedPct: 100,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    transferFeeBps: 0,
    sellOk: true,
    sellImpactPct: 2,
    creator: 'Creator111111111111111111111111111111111111',
    creatorReputation: null,
    secondsSinceLastExit: null,
    ...overrides,
  };
}

describe('the baseline', () => {
  it('accepts a token that clears every default rule', () => {
    expect(evaluateEntry(candidate(), rules)).toEqual({ ok: true });
  });
});

describe('null fails the launch gates', () => {
  it('refuses an unestablished bundle rather than treating it as zero', () => {
    const decision = evaluateEntry(candidate({ bundledPct: null }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.rule).toBe('entry.maxBundledPct');
      // The message has to say WHY, not just that it failed.
      expect(decision.message).toContain('could not be established');
    }
  });

  it('refuses an unestablished cluster reading', () => {
    const decision = evaluateEntry(candidate({ clusteredPct: null }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('entry.maxClusteredPct');
  });

  it('counts the creator bag together with the wallets they funded', () => {
    // 4 + 3 = 7, above the default ceiling of 5, though neither alone is.
    const decision = evaluateEntry(candidate({ creatorPct: 4, creatorLinkedPct: 3 }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('entry.maxCreatorPct');
  });
});

describe('null SKIPS the pipeline-shaped gates', () => {
  it('does not refuse a token merely because the holder sync has not run', () => {
    // The distinction: a null here is OUR pipeline being behind, not the token
    // misrepresenting itself.
    expect(evaluateEntry(candidate({ holderCount: null, traders24h: null }), rules)).toEqual({
      ok: true,
    });
  });
});

describe('the sell check', () => {
  it('refuses an unchecked token, not only a failed one', () => {
    const unchecked = evaluateEntry(candidate({ sellOk: null }), rules);
    expect(unchecked.ok).toBe(false);
    if (!unchecked.ok) {
      expect(unchecked.rule).toBe('entry.requireSellConfirmed');
      expect(unchecked.message).toContain('Nothing has confirmed');
    }
  });

  it('distinguishes "cannot be sold" from "not checked" in the message', () => {
    const failed = evaluateEntry(candidate({ sellOk: false }), rules);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toContain('No route');
  });
});

describe('the mint gates', () => {
  it('refuses an unread freeze authority, not only a live one', () => {
    const unread = evaluateEntry(candidate({ freezeAuthorityRevoked: null }), rules);
    expect(unread.ok).toBe(false);
    if (!unread.ok) expect(unread.rule).toBe('entry.requireFreezeRevoked');
  });

  it('refuses unlocked liquidity and unknown liquidity alike', () => {
    expect(evaluateEntry(candidate({ lpLockedPct: null }), rules).ok).toBe(false);
    expect(evaluateEntry(candidate({ lpLockedPct: 40 }), rules).ok).toBe(false);
    expect(evaluateEntry(candidate({ lpLockedPct: 100 }), rules).ok).toBe(true);
  });
});

describe('the grade itself', () => {
  it('refuses a provisional score however high it is', () => {
    const decision = evaluateEntry(candidate({ score: 97, coverage: 41 }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.rule).toBe('entry.coverage');
      expect(decision.message).toContain('provisional');
    }
  });

  it('refuses an unscored token', () => {
    const decision = evaluateEntry(candidate({ score: null, tier: null }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('entry.minScore');
  });
});

describe('every refusal explains itself', () => {
  it('names the rule and carries both numbers', () => {
    const decision = evaluateEntry(candidate({ liquidityUsd: 900 }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.rule).toBe('entry.minLiquidityUsd');
      expect(decision.message).toContain('900');
      expect(decision.message).toContain('15,000');
    }
  });

  it('applies the re-entry cooldown against this user, not globally', () => {
    const decision = evaluateEntry(candidate({ secondsSinceLastExit: 600 }), rules);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('entry.reentryCooldownSeconds');

    expect(evaluateEntry(candidate({ secondsSinceLastExit: 7_200 }), rules).ok).toBe(true);
  });
});
