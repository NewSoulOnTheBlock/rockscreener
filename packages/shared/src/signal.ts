/**
 * A CALL — and the difference between this and a score is the whole product.
 *
 * A score is a continuous opinion that changes every minute; it is never wrong,
 * because it never committed to anything. A call is a moment: "at 14:02, at a
 * $38K market cap, this was worth buying." It can be measured afterwards, it
 * can be WRONG, and it is the only thing here that can be held to account.
 *
 * THIS IS THE FIX FOR WHAT WAS BROKEN BEFORE. A screener that lists every token
 * it has indexed is not making calls — it is publishing its database and
 * leaving the selecting to the reader. So a call fires ONCE, when a token first
 * crosses a threshold with enough of it measured to mean something, and is then
 * tracked forever: where it was called, what it peaked at, where it is now, how
 * far it fell on the way, and how it ended.
 */

/** Calls, strongest first. `watch` is recorded but is not a buy. */
export const CALL_TIERS = ['strong_buy', 'buy', 'watch'] as const;
export type CallTier = (typeof CALL_TIERS)[number];

export const CALL_LABEL: Record<CallTier, string> = {
  strong_buy: 'Strong buy',
  buy: 'Buy',
  watch: 'Watch',
};

/**
 * Score a token must reach to fire each call — THE SAME NUMBERS as the tier
 * bands in score.ts, on purpose.
 *
 * A separate set of thresholds would mean a token displayed as "Diamond" that
 * never produced a Strong buy, and a reader having to learn two scales
 * measuring the same thing. The call IS the grade, committed to at a moment.
 */
export const CALL_THRESHOLD: Record<CallTier, number> = {
  strong_buy: 76,
  buy: 68,
  watch: 50,
};

/** How a call ended, or that it has not. */
export type CallOutcome = 'live' | 'invalidated' | 'rugged' | 'settled';

export interface Call {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  tier: CallTier;

  /** The score at the moment of the call, and how much of it was measured. */
  score: number;
  coverage: number;
  /** The most important thing the scorer had found. Null when clean. */
  headline: string | null;

  /** ISO-8601. */
  calledAt: string;
  entryPriceUsd: number;
  /**
   * Market cap at the call — THE FIGURE A PERSON ACTUALLY REMEMBERS. Nobody
   * recalls that a token was called at $0.0000394; everybody recalls that it
   * was called at $38K. It is also the only one of the two comparable across
   * tokens, since a price means nothing without a supply.
   */
  entryMarketCapUsd: number;
  entryLiquidityUsd: number;

  peakPriceUsd: number;
  peakMarketCapUsd: number;
  peakAt: string | null;
  /** Peak / entry. 1 means it never went up. */
  peakMultiple: number;

  lastPriceUsd: number;
  lastMarketCapUsd: number;
  /** Last / entry — what somebody still holding actually has. */
  currentMultiple: number;
  /** Deepest drawdown from entry, percent, as a negative number. */
  maxDrawdownPct: number;

  outcome: CallOutcome;
  closedAt: string | null;
  closeReason: string | null;

  /**
   * A coarse price path since the call, for the sparkline on the call card.
   *
   * MULTIPLES OF THE ENTRY PRICE, not dollars, and that is what makes it
   * plottable: the card's whole claim is "this is what the call did", so the
   * series is denominated in the only unit that answers it, and 1.0 is the line
   * the call was made at. Roughly two dozen points — enough to show the shape,
   * far too few to trade from, which is the correct amount of chart for a card.
   *
   * Empty for a call minutes old that has no history yet. The card draws a flat
   * mark rather than an empty box.
   */
  spark: number[];
}

/** The compact form a screener row carries. */
export interface CallSummary {
  tier: CallTier;
  calledAt: string;
  /**
   * THE THREE MARKET CAPS, and they are three different questions.
   *
   * `entry` is what it was worth when the claim was made and is FROZEN — it is
   * the number the call can be judged against and nothing may ever rewrite it.
   * `peak` is the best it ever got, which is the number a feed that only quotes
   * its winners is quoting. `last` is what it is worth now, which is the only
   * one of the three anybody could still have acted on.
   *
   * Printing only the multiple collapses all three into a ratio and hides the
   * SIZE of the thing called: 3x on a $40k cap and 3x on a $40m cap are not the
   * same claim, and the second one is usually not a claim at all.
   */
  entryMarketCapUsd: number;
  peakMarketCapUsd: number;
  lastMarketCapUsd: number;
  peakMultiple: number;
  currentMultiple: number;
  outcome: CallOutcome;
}

/**
 * The multiple at which a call counts as having WORKED.
 *
 * 1.25 rather than 2, because this is the line between a call that went
 * somewhere and one that did not — not the line between a good outcome and a
 * great one. 2x is a good outcome and a rare one, and `hit2xPct` reports it
 * separately.
 */
export const CALL_WORKED_MULTIPLE = 1.25;

/**
 * The track record — the number that decides whether any of this is worth
 * reading, PUBLISHED WHOLE, INCLUDING THE LOSSES.
 *
 * A product that makes calls and shows only the ones that worked is an
 * advertisement. The window is explicit for the same reason: "our calls average
 * 3.1x" means nothing without "over how long, and how many".
 */
export interface CallRecord {
  tier: CallTier | 'all';
  windowHours: number;
  calls: number;
  /** Calls that reached CALL_WORKED_MULTIPLE at any point while tracked. */
  successCount: number;
  hit2xPct: number;
  hit5xPct: number;
  /** Share that lost more than half from the call at some point, percent. */
  drawdown50Pct: number;
  /**
   * Median peak multiple — median, not mean: one 400x would carry the mean and
   * say nothing about what the typical call did.
   *
   * NULL on the combined `all` row, and that is not an omission. A median of
   * medians is not a median, and printing a fabricated 1.00x there is exactly
   * the kind of invented number the rest of this codebase refuses.
   */
  medianPeakMultiple: number | null;
  /** Median of where they are NOW — the honest half of the pair. */
  medianCurrentMultiple: number | null;
  ruggedCount: number;
}

/**
 * What DexScreener has been PAID for on a token.
 *
 * Money spent on visibility is not money spent on the product, and it cuts both
 * ways — which is why the types are carried separately rather than collapsed
 * into one "promoted" flag. A paid profile means somebody wrote a description
 * and attached links, which every real project does and most scams do not
 * bother with. A trending-bar ad means somebody is buying attention, which is
 * exactly as likely to be a marketing budget as an exit being funded.
 */
export const DEX_ORDER_TYPES = [
  'tokenProfile',
  'communityTakeover',
  'tokenAd',
  'trendingBarAd',
] as const;
export type DexOrderType = (typeof DEX_ORDER_TYPES)[number];

export const DEX_ORDER_LABEL: Record<DexOrderType, string> = {
  tokenProfile: 'Profile',
  communityTakeover: 'Takeover',
  tokenAd: 'Ad',
  trendingBarAd: 'Trending ad',
};
