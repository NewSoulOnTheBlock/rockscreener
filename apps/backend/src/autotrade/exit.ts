import type { ExitRules } from '@rockscreener/shared';

/**
 * When to sell, and which rule said so.
 *
 * WORST NEWS FIRST, and the order below is the rule rather than a convenience.
 * A rug signal beats a stop, a stop beats a take-profit, and the time limit is
 * last because it is the only one that is not about what the position is worth.
 * Evaluating in any other order produces the exact failure this ordering exists
 * to prevent: a position that hits its first take-profit rung in the same tick
 * the liquidity is pulled sells 40% and holds the rest into zero.
 *
 * PURE, like the entry gates, and for the same reason — these decisions are
 * somebody's money and they have to be checkable without a chain.
 */

export interface PositionState {
  symbol: string;
  /** Token base units still held. */
  amount: bigint;
  entryPriceUsd: number;
  highPriceUsd: number;
  lastPriceUsd: number;
  /** What the remaining position is worth in lamports, at the last price. */
  valueLamports: bigint;
  openedAtMs: number;
  filledSteps: number[];
  /** The token's grade now. Null when it has stopped being scored. */
  currentScore: number | null;
  /**
   * Something is wrong with the TOKEN: the liquidity left, the sell check
   * started failing, the mint was frozen.
   */
  rugSignal: string | null;
  /**
   * The CALL this position was opened on has been retracted, and why.
   *
   * Distinct from `rugSignal` on purpose: a rug is something wrong with the
   * token, this is the product changing its mind. They read differently in the
   * event log and they should — "the liquidity left" and "twenty five minutes
   * passed and it never moved" are different things to have happened to
   * somebody's money.
   *
   * Null is "the call still stands" OR "there is no call to consult", and in
   * both cases the rule simply does not fire. That is the correct behaviour for
   * an unknown rather than a false.
   */
  callWithdrawn: string | null;
}

export type ExitDecision =
  | { sell: false }
  /** Sell `pct` of what is still held, 1..100. */
  | { sell: true; pct: number; rule: string; reason: string; step?: number };

export function evaluateExit(p: PositionState, r: ExitRules, nowMs: number): ExitDecision {
  /*
   * DUST FIRST, and note that it BLOCKS every rule below rather than being one
   * of them. A position worth less than the rent, the priority fee and the
   * slippage of closing it cannot be exited profitably by any rule, and an
   * engine that does not know this spends real SOL selling forty cents of a
   * token on every tick forever.
   *
   * A RUG SIGNAL IS THE ONE EXCEPTION. There, getting out of the token at all
   * is worth more than the gas, and leaving a frozen or unsellable position
   * open forever is a worse outcome than a wasted fee.
   */
  const minExit = BigInt(r.minExitValueLamports);
  if (p.amount <= 0n) return { sell: false };
  if (p.valueLamports < minExit && p.rugSignal === null) return { sell: false };

  if (r.exitOnRugSignal && p.rugSignal) {
    return { sell: true, pct: 100, rule: 'exit.exitOnRugSignal', reason: p.rugSignal };
  }

  /*
   * Directly under the rug rule and ABOVE everything about price.
   *
   * Above the stops because it is not a price fact and does not compete with
   * one: a call withdrawn as stagnant is by definition a position no stop and
   * no take-profit rung will ever fire on, so leaving it below them means
   * leaving it to `maxHoldSeconds`, which is a day. The whole point of the rule
   * is to stop holding a flat bag for the other twenty three.
   *
   * Below the rug rule because a rug is worse news, and the reason recorded
   * against the sale should be the worst true one.
   */
  if (r.exitOnCallWithdrawn && p.callWithdrawn) {
    return { sell: true, pct: 100, rule: 'exit.exitOnCallWithdrawn', reason: p.callWithdrawn };
  }

  if (r.exitBelowScore !== null && p.currentScore !== null && p.currentScore < r.exitBelowScore) {
    return {
      sell: true,
      pct: 100,
      rule: 'exit.exitBelowScore',
      reason: `The grade fell to ${Math.round(p.currentScore)}, below your ${r.exitBelowScore}.`,
    };
  }

  const gainPct = pctChange(p.entryPriceUsd, p.lastPriceUsd);

  if (r.stopLossPct !== null && gainPct <= -r.stopLossPct) {
    return {
      sell: true,
      pct: 100,
      rule: 'exit.stopLossPct',
      reason: `Down ${Math.abs(gainPct).toFixed(1)}% from entry.`,
    };
  }

  /*
   * THE TRAILING STOP RUNS ALONGSIDE THE FIXED ONE, not instead of it. The
   * fixed stop bounds the loss from entry; this one protects a gain that has
   * already happened. A position that went up 300% and came back to entry has
   * lost nothing by the fixed stop's reckoning and given up everything by this
   * one's — which is the whole reason to have both.
   */
  if (r.trailingStopPct !== null && p.highPriceUsd > p.entryPriceUsd) {
    const fromHigh = pctChange(p.highPriceUsd, p.lastPriceUsd);
    if (fromHigh <= -r.trailingStopPct) {
      return {
        sell: true,
        pct: 100,
        rule: 'exit.trailingStopPct',
        reason: `Down ${Math.abs(fromHigh).toFixed(1)}% from its high.`,
      };
    }
  }

  /*
   * TAKE PROFIT, HIGHEST ARMED RUNG FIRST.
   *
   * A position that gaps straight from entry to +500% has armed every rung at
   * once. Taking the lowest would sell 40% at a level the market has long left
   * behind and leave the rest to be sold on the next tick at whatever the price
   * has become; taking the highest sells the share the user chose for the level
   * the price actually reached.
   */
  const armed = r.takeProfit
    .map((step, index) => ({ ...step, index }))
    .filter((step) => !p.filledSteps.includes(step.index) && gainPct >= step.gainPct)
    .sort((a, b) => b.gainPct - a.gainPct);

  const step = armed[0];
  if (step) {
    return {
      sell: true,
      pct: step.sellPct,
      rule: `exit.takeProfit[${step.index}]`,
      reason: `Up ${gainPct.toFixed(0)}% — taking ${step.sellPct}% off at the +${step.gainPct}% rung.`,
      step: step.index,
    };
  }

  if (r.maxHoldSeconds !== null && nowMs - p.openedAtMs >= r.maxHoldSeconds * 1_000) {
    return {
      sell: true,
      pct: 100,
      rule: 'exit.maxHoldSeconds',
      reason: `Held for the full ${Math.round(r.maxHoldSeconds / 3600)}h you allow.`,
    };
  }

  return { sell: false };
}

/**
 * Percentage change between two prices.
 *
 * Returns 0 rather than Infinity for a zero base — a position whose entry price
 * we do not have has not gained infinitely, and Infinity here would fire every
 * take-profit rung at once.
 */
export function pctChange(from: number, to: number): number {
  if (!(from > 0)) return 0;
  return (to / from - 1) * 100;
}

/**
 * Which rungs a partial sell retires.
 *
 * EVERY RUNG AT OR BELOW THE ONE THAT FIRED, because the price passed through
 * all of them to get here. Without this, a gap from entry to +500% sells at the
 * top rung and then sells again at the lower ones on the following ticks, at
 * whatever the market has moved to — three exits where the user wrote one.
 */
export function retiredSteps(rules: ExitRules, firedIndex: number, already: number[]): number[] {
  const firedGain = rules.takeProfit[firedIndex]?.gainPct ?? 0;
  const retired = rules.takeProfit
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.gainPct <= firedGain)
    .map(({ index }) => index);
  return [...new Set([...already, ...retired])].sort((a, b) => a - b);
}
