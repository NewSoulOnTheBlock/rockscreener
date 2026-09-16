import type { Launchpad } from './chain.js';
import type { RockScoreSummary } from './score.js';
import type { CallSummary, DexOrderType } from './signal.js';

/**
 * How much of the pipeline a token gets.
 *
 * Tens of thousands of mints are created on Solana every day and the
 * overwhelming majority never trade twice. Carrying holder syncs, security
 * reports and price polling for all of them is exactly what made the product
 * this replaces both expensive and useless — it listed everything, so it
 * recommended nothing. Only ACTIVE and GRADUATED run the full pipeline.
 */
export const TOKEN_TIERS = ['DORMANT', 'SEEDED', 'ACTIVE', 'GRADUATED'] as const;
export type TokenTier = (typeof TOKEN_TIERS)[number];

/** Where the token currently trades. */
export const TOKEN_STATUS = ['BONDING', 'MIGRATED'] as const;
export type TokenStatus = (typeof TOKEN_STATUS)[number];

export type RiskLevel = 'safe' | 'warning' | 'danger' | 'unknown';

/**
 * Why a token has no name yet — the difference between "we have not asked" and
 * "we asked and nothing answered". An empty symbol means both, and a renderer
 * that cannot tell them apart either spins forever or gives up two seconds
 * early.
 */
export const NAME_STATES = ['named', 'pending', 'unreadable'] as const;
export type NameState = (typeof NAME_STATES)[number];

/** Compact row used by the screener lists — one row's worth of data. */
export interface TokenSummary {
  mint: string;
  launchpad: Launchpad;
  tier: TokenTier;
  status: TokenStatus;

  name: string;
  symbol: string;
  nameState: NameState;
  imageUrl: string | null;
  creator: string;

  /** ISO-8601. */
  launchTime: string;
  lastActivityAt: string | null;
  migratedAt: string | null;

  /**
   * Bonding-curve progress in basis points, 0..10000.
   *
   * NULL when the curve account has not been read. A card must not draw "0%"
   * for a curve nobody has looked at — that is a fabricated reading of the most
   * specific kind, and it appeared on every bonding token until this was made
   * nullable.
   */
  progressBps: number | null;

  /**
   * THE MARKET, AND ALL OF IT IS NULLABLE.
   *
   * A mint discovered seconds ago has no pool, so nothing has a price, a
   * valuation or a depth — and `0` is a claim about all three. It would put
   * "$0" in a market-cap column for a token whose market simply does not exist
   * yet, which reads as a worthless token rather than as an unlisted one, and
   * it would let a screener sort a brand-new mint to the bottom of a liquidity
   * ranking as though it had been measured and found empty.
   *
   * A MEASURED ZERO IS DIFFERENT and is carried as `0`: a pool that exists and
   * is empty is one of the most damning readings available, and the liquidity
   * pillar scores it at zero rather than skipping it.
   */
  priceUsd: number | null;
  priceSol: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;

  volume5mUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  volume24hUsd: number;

  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;

  txns24h: number;
  buys24h: number;
  sells24h: number;
  /**
   * Distinct wallets that traded in 24h.
   *
   * Carried separately from `txns24h` because they are the pair that matters:
   * one wallet trading against itself produces any transaction count you like
   * for the price of a few thousand lamports, and producing two hundred
   * distinct counterparties costs two hundred funded wallets.
   */
  traders24h: number | null;

  holderCount: number | null;
  /** Top ten holders' share with AMM vaults, lockers and burn excluded. */
  top10Pct: number | null;
  creatorPct: number | null;

  risk: RiskLevel;
  riskWarnings: number;

  /**
   * The Rock Score for this row.
   *
   * Null means NOT SCORED YET, never "scored zero". A token seconds old has no
   * distribution and no trading to read, and the scorer refuses to publish a
   * number it would have to invent four fifths of.
   */
  rock: RockScoreSummary | null;

  /**
   * The standing call on this token, or null if it has never been called.
   *
   * NULL IS THE COMMON CASE AND MUST STAY VISIBLE AS SUCH. Most indexed tokens
   * are never called — that is what makes a call worth anything.
   */
  call: CallSummary | null;

  hasSocials: boolean;
  /** Tri-state: null means DexScreener has never been asked about this token. */
  dexPaid: boolean | null;
  dexPaidTypes: DexOrderType[];
  boosts: number;

  /** Which market the price comes from — `raydium`, `pumpswap`, `meteora`. */
  dexId: string | null;
  poolAddress: string | null;
}

/** Everything the token page needs beyond the row. */
export interface TokenDetail extends TokenSummary {
  description: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;

  decimals: number;
  /** Raw base units as a decimal string — a uint64 supply does not fit a double. */
  totalSupply: string;

  /** Token-2022 transfer fee, basis points. Zero for a plain SPL mint. */
  transferFeeBps: number;
  /** Null when nobody has read the mint account yet. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  metadataMutable: boolean | null;

  /** Share of the LP that is locked or burnt, 0..100. Null when unread. */
  lpLockedPct: number | null;
  lpLockedUsd: number | null;
  marketCount: number;

  allTimeHighUsd: number | null;
  allTimeHighAt: string | null;

  launchTx: string | null;
  explorerUrl: string;
}

/** One holder, as the concentration panel draws it. */
export interface HolderRow {
  address: string;
  /** Raw base units, decimal string. */
  amount: string;
  /** Share of total supply, 0..100. */
  pct: number;
  /** What this account IS, when we know. A pool is not a whale. */
  kind: 'wallet' | 'amm' | 'locker' | 'burn' | 'creator' | 'unknown';
  label: string | null;
  rank: number;
}

/** One trade, for the tape. */
export interface TapeTrade {
  signature: string;
  side: 'buy' | 'sell';
  /** ISO-8601. */
  at: string;
  trader: string;
  amountUsd: number;
  amountSol: number;
  amountToken: number;
  priceUsd: number;
}
