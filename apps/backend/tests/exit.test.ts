import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_TRADE } from '@rockscreener/shared';
import { evaluateExit, pctChange, retiredSteps, type PositionState } from '../src/autotrade/exit.js';

const rules = DEFAULT_AUTO_TRADE.exit;
const NOW = 1_800_000_000_000;

function position(overrides: Partial<PositionState> = {}): PositionState {
  return {
    symbol: 'TEST',
    amount: 1_000_000_000n,
    entryPriceUsd: 1,
    highPriceUsd: 1,
    lastPriceUsd: 1,
    valueLamports: 100_000_000n,
    openedAtMs: NOW - 60_000,
    filledSteps: [],
    currentScore: 80,
    rugSignal: null,
    callWithdrawn: null,
    ...overrides,
  };
}

describe('ordering — worst news first', () => {
  it('a rug beats a take-profit that armed in the same tick', () => {
    const decision = evaluateExit(
      position({ lastPriceUsd: 2, highPriceUsd: 2, rugSignal: 'Liquidity fell 91% from entry.' }),
      rules,
      NOW
    );
    /*
     * THE FAILURE THIS PREVENTS: selling 40% at the first rung and holding the
     * rest into zero, because the ladder was evaluated before the rug.
     */
    expect(decision).toMatchObject({ sell: true, pct: 100, rule: 'exit.exitOnRugSignal' });
  });

  it('a rug beats a stop loss', () => {
    const decision = evaluateExit(
      position({ lastPriceUsd: 0.4, rugSignal: 'The token has been pulled.' }),
      rules,
      NOW
    );
    expect(decision).toMatchObject({ rule: 'exit.exitOnRugSignal' });
  });

  it('a withdrawn call is acted on above every price rule', () => {
    const decision = evaluateExit(
      position({ lastPriceUsd: 1.02, callWithdrawn: '25 minutes on and it has not moved.' }),
      rules,
      NOW
    );
    // No stop and no rung would ever fire on a flat position; without this rule
    // it would be held for the full day.
    expect(decision).toMatchObject({ sell: true, pct: 100, rule: 'exit.exitOnCallWithdrawn' });
  });
});

describe('stops', () => {
  it('the fixed stop bounds the loss from entry', () => {
    const decision = evaluateExit(position({ lastPriceUsd: 0.6 }), rules, NOW);
    expect(decision).toMatchObject({ sell: true, pct: 100, rule: 'exit.stopLossPct' });
  });

  it('the trailing stop fires on a position that gave back its gain', () => {
    // Up 300% then back to 2x: nothing lost from entry, everything given back.
    const decision = evaluateExit(
      position({ entryPriceUsd: 1, highPriceUsd: 4, lastPriceUsd: 2.5 }),
      rules,
      NOW
    );
    expect(decision).toMatchObject({ sell: true, rule: 'exit.trailingStopPct' });
  });

  it('the trailing stop never fires on a position that only went down', () => {
    const decision = evaluateExit(
      position({ entryPriceUsd: 1, highPriceUsd: 1, lastPriceUsd: 0.8 }),
      rules,
      NOW
    );
    // Down 20%: inside the fixed stop, and the trailing stop has no high to
    // trail from.
    expect(decision).toEqual({ sell: false });
  });
});

describe('the take-profit ladder', () => {
  it('fills the HIGHEST armed rung on a gap', () => {
    // +500% arms all three rungs at once.
    const decision = evaluateExit(position({ lastPriceUsd: 6, highPriceUsd: 6 }), rules, NOW);
    expect(decision).toMatchObject({ sell: true, step: 2, pct: 100 });
  });

  it('retires every rung the price passed through', () => {
    const retired = retiredSteps(rules, 2, []);
    // Otherwise the lower rungs fire again on the next ticks, at whatever the
    // market has moved to — three exits where the user wrote one.
    expect(retired).toEqual([0, 1, 2]);
  });

  it('does not re-fire a rung already filled', () => {
    const decision = evaluateExit(
      position({ lastPriceUsd: 1.6, highPriceUsd: 1.6, filledSteps: [0] }),
      rules,
      NOW
    );
    expect(decision).toEqual({ sell: false });
  });
});

describe('dust', () => {
  it('blocks every price rule on a position not worth closing', () => {
    const decision = evaluateExit(
      position({ lastPriceUsd: 0.2, valueLamports: 1_000n }),
      rules,
      NOW
    );
    // Deep in the stop, and still not worth the fee to exit.
    expect(decision).toEqual({ sell: false });
  });

  it('does NOT block a rug exit', () => {
    const decision = evaluateExit(
      position({ valueLamports: 1_000n, rugSignal: 'The token has been pulled.' }),
      rules,
      NOW
    );
    expect(decision).toMatchObject({ sell: true, rule: 'exit.exitOnRugSignal' });
  });
});

describe('pctChange', () => {
  it('returns zero rather than Infinity for a missing entry price', () => {
    // Infinity here would arm every take-profit rung at once.
    expect(pctChange(0, 5)).toBe(0);
  });
});
