import type { RockTier } from './score.js';

/** Every success is `{ data }`; every failure is `{ error }`. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface ApiResponse<T> {
  data: T;
}

/**
 * Keyset (cursor) pagination — never OFFSET.
 *
 * The token table runs to millions of rows, where `OFFSET n` makes the database
 * walk and discard n rows and `COUNT(*)` over a filtered set degenerates into a
 * scan. The cursor encodes the last row's sort key plus its mint as a
 * tiebreaker, so page 10,000 costs exactly what page 1 costs.
 */
export interface CursorPage<T> {
  data: T[];
  /** Opaque; pass back as `cursor`. Null = end of list. */
  nextCursor: string | null;
}

export const SCREENER_SORTS = [
  'score',
  'calledAt',
  'peakMultiple',
  'trending',
  'new',
  'marketCap',
  'liquidity',
  'volume24h',
  'progress',
  'migratedAt',
] as const;
export type ScreenerSort = (typeof SCREENER_SORTS)[number];

/**
 * The lanes, as the tab strip draws them.
 *
 * A PRESET IS A CLAIM, not a saved filter. `calls` is "what we actually said to
 * buy"; `rocks` is "what is graded well right now"; `new` is the raw firehose,
 * and it exists precisely so the two lanes above it can be checked rather than
 * believed.
 */
export const SCREENER_PRESETS = [
  'calls',
  'rocks',
  'new',
  'bonding',
  'graduated',
  'watchlist',
] as const;
export type ScreenerPreset = (typeof SCREENER_PRESETS)[number];

export interface ScreenerQuery {
  preset?: ScreenerPreset;
  sort?: ScreenerSort;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  search?: string;
  /** Hide rows with no score at all, and rows whose score is provisional. */
  scoredOnly?: boolean;
  minScore?: number;
  tiers?: RockTier[];
  launchpads?: string[];
  minLiquidityUsd?: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  maxAgeHours?: number;
}

/** What the status line reports — one request, no fan-out. */
export interface SystemStatus {
  /** Whether the indexer has written anything in the last minute. */
  indexing: boolean;
  /** Seconds since the last token row was touched. Null when never. */
  lagSeconds: number | null;
  tokensTracked: number;
  scoredLastHour: number;
  callsLast24h: number;
  /** Whether THIS deployment can trade at all (master key present). */
  tradingConfigured: boolean;
  /** Whether the auto-trade engine process is alive. */
  engineAlive: boolean;
  solPriceUsd: number | null;
  rockPriceUsd: number | null;
}
