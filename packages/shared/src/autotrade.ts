import type { RockTier } from './score.js';

/**
 * Auto-trade: the rules a user writes down once, and the engine that follows
 * them without asking again.
 *
 * TWO PRINCIPLES SHAPE EVERY FIELD HERE.
 *
 * First, a rule that is ABSENT must never mean "do it anyway". Every filter is
 * a gate the token has to pass, and an unset optional filter is simply not
 * checked — but the ones that bound LOSS (`maxSpendPerHourLamports`,
 * `maxConcurrentPositions`, `dailyLossCapLamports`) are required and have no
 * unlimited value. There is no configuration of this object that spends without
 * a ceiling, because the failure mode of automated buying is not one bad trade,
 * it is forty bad trades in ninety seconds.
 *
 * Second, the engine must be able to EXPLAIN ITSELF. Every decision it makes is
 * recorded as an `AutoTradeEvent` naming the rule that fired — including the
 * decisions to do nothing, which are the ones a user actually questions when
 * they watch a token run without being bought.
 */

/** Everything is armed off. Turning it on is an explicit, separate action. */
export interface AutoTradeSettings {
  enabled: boolean;
  /** Which custodial wallet the engine spends from. Null = not configured. */
  walletId: string | null;

  // --- Spending, all required --------------------------------------------
  /** Position size, in lamports. */
  buyAmountLamports: string;
  maxConcurrentPositions: number;
  /** Ceiling on total spend in any rolling hour, lamports. */
  maxSpendPerHourLamports: string;
  /**
   * Realised loss in a UTC day that DISARMS the engine.
   *
   * Disarms rather than pauses: it sets `enabled` to false and records why, so
   * the user has to come back and look at what happened before it spends again.
   * A cap that silently resumes at midnight is a cap that loses the same money
   * every day.
   */
  dailyLossCapLamports: string;
  slippageBps: number;
  /** Priority fee ceiling per transaction, lamports. Solana-specific. */
  maxPriorityFeeLamports: string;

  entry: EntryRules;
  exit: ExitRules;

  /** ISO-8601, set when the engine disarmed itself. Null while armed or idle. */
  disarmedAt: string | null;
  disarmedReason: string | null;
}

/**
 * What a token must look like before the engine will buy it.
 *
 * Nulls mean "not checked". The score floor is the exception: it is required,
 * because the entire premise of the engine is that it acts on the score, and an
 * engine with no score floor is a bot that buys every launch.
 */
export interface EntryRules {
  /** Required. The engine never buys below this. */
  minScore: number;
  /** Tiers that may be bought. Empty = the score floor alone decides. */
  allowedTiers: RockTier[];
  /** Launchpads to buy from. Empty = all of them. */
  allowedLaunchpads: string[];

  minLiquidityUsd: number | null;
  minMarketCapUsd: number | null;
  maxMarketCapUsd: number | null;
  /** Youngest a token may be, seconds. Guards against buying the mint. */
  minAgeSeconds: number | null;
  maxAgeSeconds: number | null;

  minHolders: number | null;
  /** Distinct buying wallets — the number a bundle cannot fake cheaply. */
  minUniqueTraders: number | null;

  // --- The launch-analysis gates ------------------------------------------
  maxBundledPct: number | null;
  maxClusteredPct: number | null;
  /** Creator plus every wallet the creator funded. */
  maxCreatorPct: number | null;
  maxTop10Pct: number | null;

  // --- Mint gates ---------------------------------------------------------
  /** Refuse a mint whose authority is still live — supply can be diluted. */
  requireMintRevoked: boolean;
  /**
   * Refuse a mint that can still freeze your token account.
   *
   * Defaults ON and should stay on. A freeze authority is the Solana-native
   * honeypot: the trade succeeds, the balance arrives, and the account is
   * frozen before you can send it anywhere.
   */
  requireFreezeRevoked: boolean;
  /** LP must be locked or burnt. The single most effective filter here. */
  requireLpSecured: boolean;
  /** Maximum Token-2022 transfer fee, basis points. */
  maxTransferFeeBps: number | null;
  /**
   * Refuse anything the sell check could not clear.
   *
   * Note what it rejects: not just a token that failed, but one the check could
   * not answer for. For a token minutes old that is the common case, and
   * treating "we could not check" as a pass is how an automated buyer walks
   * into the one trade it exists to avoid.
   */
  requireSellConfirmed: boolean;
  /** Price impact a real-size exit may take before the token is refused. */
  maxSellImpactPct: number | null;

  /** Creator reputations that are refused outright. */
  blockCreatorReputation: ('suspect' | 'serial_rugger')[];
  blockedCreators: string[];
  /** Seconds before the same token may be bought again after an exit. */
  reentryCooldownSeconds: number;
}

/**
 * When to sell. Laddered, because one exit price is a bet on a top.
 *
 * Every rule is checked on every price tick and the FIRST one that fires wins —
 * evaluated in the order declared here, which is WORST NEWS FIRST: a rug signal
 * beats a stop, a stop beats a take-profit, and the time limit is last because
 * it is the only one that is not about what the position is worth.
 */
export interface ExitRules {
  /**
   * Sell everything on a rug signal — liquidity pulled, the sell route gone,
   * the account frozen, a mint executed.
   *
   * This is the rule the engine exists to enforce. A human watching a chart
   * learns about a liquidity pull when the price is already zero.
   */
  exitOnRugSignal: boolean;
  /**
   * Sell everything when the CALL this position was opened on is withdrawn.
   *
   * Shaped as a boolean rather than as its own thresholds on purpose: the
   * engine buys what the product called, and a second configurable idea of when
   * a call has stopped standing would be a second opinion competing with the
   * first. The user chooses whether to follow the retraction, not what a
   * retraction IS.
   */
  exitOnCallWithdrawn: boolean;
  /** Sell everything when the score falls below this. Null = never. */
  exitBelowScore: number | null;

  stopLossPct: number | null;
  /**
   * Trailing stop from the high-water mark, percent. Null = off.
   *
   * Runs ALONGSIDE `stopLossPct` rather than instead of it: the fixed stop
   * bounds the loss from entry, the trailing one protects a gain that has
   * already happened, and a position that never moved up is only ever bounded
   * by the first.
   */
  trailingStopPct: number | null;

  /** Ladder: sell `sellPct` of the REMAINING position at `gainPct` up. */
  takeProfit: TakeProfitStep[];

  maxHoldSeconds: number | null;
  /**
   * Sell nothing while the position is worth less than this in lamports.
   *
   * A dust position costs more to exit than it is worth — rent, priority fee
   * and slippage — and an engine that does not know this spends real SOL
   * selling forty cents of a token forever.
   */
  minExitValueLamports: string;
}

export interface TakeProfitStep {
  gainPct: number;
  sellPct: number;
}

/** A position the engine opened and is responsible for. */
export interface AutoPosition {
  id: string;
  mint: string;
  symbol: string;
  imageUrl: string | null;
  status: 'opening' | 'open' | 'closing' | 'closed' | 'failed';
  /** SOL spent on entry, lamports. */
  spentLamports: string;
  /** SOL received from every exit so far, lamports. */
  receivedLamports: string;
  /** Token base units currently held. */
  amount: string;
  decimals: number;
  entryPriceUsd: number;
  /** Highest price seen since entry, for the trailing stop. */
  highPriceUsd: number;
  lastPriceUsd: number;
  /** Unrealised + realised, lamports, signed. */
  pnlLamports: string;
  pnlPct: number;
  /** Score at the moment of entry, kept so a rule change stays auditable. */
  entryScore: number;
  /** Take-profit rungs already executed, by index into the ladder. */
  filledSteps: number[];
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

/**
 * Everything the engine did, and everything it deliberately did NOT do.
 *
 * The `skipped` events are not diagnostics and must not be filtered out of the
 * feed by default. "Why didn't it buy that one" is the question every user of
 * an automated buyer asks within the first hour, and the answer —
 * `entry.maxBundledPct: 34.1% above your 20%` — is what turns the settings page
 * from a form into a control.
 */
export interface AutoTradeEvent {
  id: string;
  at: string;
  kind: 'considered' | 'skipped' | 'bought' | 'sold' | 'failed' | 'disarmed';
  mint: string | null;
  symbol: string | null;
  /** The rule that decided this, e.g. `entry.maxBundledPct`. Null for buys. */
  rule: string | null;
  message: string;
  signature: string | null;
}

/**
 * Defaults a new user gets: armed off, and tuned to refuse most launches.
 *
 * Deliberately conservative. A default that trades often produces a good demo
 * and a bad month, and the person who adjusts these numbers down has DECIDED
 * to — which is a different thing from having been opted in.
 */
export const DEFAULT_AUTO_TRADE: AutoTradeSettings = {
  enabled: false,
  walletId: null,
  buyAmountLamports: '50000000', // 0.05 SOL
  maxConcurrentPositions: 3,
  maxSpendPerHourLamports: '500000000', // 0.5 SOL
  dailyLossCapLamports: '500000000', // 0.5 SOL
  slippageBps: 500,
  maxPriorityFeeLamports: '2000000', // 0.002 SOL
  entry: {
    minScore: 70,
    allowedTiers: [],
    allowedLaunchpads: [],
    minLiquidityUsd: 15_000,
    minMarketCapUsd: 20_000,
    maxMarketCapUsd: 2_000_000,
    minAgeSeconds: 180,
    maxAgeSeconds: 86_400,
    minHolders: 80,
    minUniqueTraders: 40,
    maxBundledPct: 20,
    maxClusteredPct: 20,
    maxCreatorPct: 5,
    maxTop10Pct: 35,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    requireLpSecured: true,
    maxTransferFeeBps: 0,
    requireSellConfirmed: true,
    maxSellImpactPct: 8,
    blockCreatorReputation: ['suspect', 'serial_rugger'],
    blockedCreators: [],
    reentryCooldownSeconds: 3_600,
  },
  exit: {
    exitOnRugSignal: true,
    exitOnCallWithdrawn: true,
    exitBelowScore: 40,
    stopLossPct: 35,
    trailingStopPct: 25,
    takeProfit: [
      { gainPct: 50, sellPct: 40 },
      { gainPct: 150, sellPct: 50 },
      { gainPct: 400, sellPct: 100 },
    ],
    maxHoldSeconds: 86_400,
    minExitValueLamports: '10000000', // 0.01 SOL
  },
  disarmedAt: null,
  disarmedReason: null,
};
