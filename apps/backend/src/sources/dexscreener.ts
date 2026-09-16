import type { DexOrderType } from '@rockscreener/shared';
import { loadConfig } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * DexScreener — the market.
 *
 * IT IS THE ONLY PLACE PRICES COME FROM, and that is a rule rather than a
 * convenience. Two sources for one number is how a product ends up disagreeing
 * with itself on the same screen: the card says $41K because it asked Jupiter
 * and the row says $38K because it asked DexScreener, and neither is wrong.
 * Jupiter is used here for ROUTING and for the sell check, never for a
 * displayed price.
 *
 * NOTHING IS STORED AS A CANDLE. The token page embeds DexScreener's own chart,
 * so this client fetches aggregates only — price, liquidity, volume buckets,
 * transaction counts — and the product never carries an OHLCV table for
 * hundreds of thousands of mints it would have to backfill and prune.
 */

const BASE = 'https://api.dexscreener.com';
const cfg = loadConfig();
const spacer = new Spacer(cfg.sources.dexscreener.minIntervalMs);
const log = logger.child({ source: 'dexscreener' });

export interface DexPair {
  mint: string;
  pairAddress: string | null;
  dexId: string | null;
  priceUsd: number;
  priceNative: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  volume24hUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  buys24h: number;
  sells24h: number;
  /** How many markets this token was returned in. One thin pool is not a market. */
  marketCount: number;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
  createdAtMs: number | null;
  boosts: number;
}

async function request<T>(path: string): Promise<T | null> {
  await spacer.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.sources.dexscreener.timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    if (res.status === 429) {
      spacer.backoff();
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    // A source that is down is a source that answers null. Every caller here
    // treats null as "not measured", which is the honest state — and is exactly
    // why none of these fields default to zero in the database.
    log.debug({ path, err: errField(err) }, 'request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Up to `batchSize` mints in one request.
 *
 * THIRTY IS A HARD CEILING AND EXCEEDING IT FAILS SILENTLY — DexScreener
 * truncates the list and answers 200, so a batch of fifty looks like twenty
 * tokens that mysteriously never update. The config schema bounds it at 30 for
 * that reason rather than as a guess at politeness.
 */
export async function fetchPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  if (mints.length === 0) return out;

  const data = await request<unknown[]>(`/tokens/v1/solana/${mints.slice(0, 30).join(',')}`);
  if (!Array.isArray(data)) return out;

  for (const raw of data) {
    const pair = raw as Record<string, any>;
    const mint = pair?.baseToken?.address as string | undefined;
    if (!mint) continue;

    const liquidityUsd = num(pair.liquidity?.usd);
    const existing = out.get(mint);
    /*
     * DEEPEST POOL WINS. A token trades in several markets and the thin ones
     * carry prices that have not moved in an hour; taking the first response
     * would make the displayed price depend on DexScreener's ordering, which
     * is not a property of the token.
     */
    if (existing && existing.liquidityUsd >= liquidityUsd) {
      out.set(mint, { ...existing, marketCount: existing.marketCount + 1 });
      continue;
    }

    const info = (pair.info ?? {}) as Record<string, any>;
    const socials: { type?: string; url?: string }[] = Array.isArray(info.socials) ? info.socials : [];
    const websites: { url?: string }[] = Array.isArray(info.websites) ? info.websites : [];

    out.set(mint, {
      mint,
      pairAddress: (pair.pairAddress as string) ?? null,
      dexId: (pair.dexId as string) ?? null,
      priceUsd: num(pair.priceUsd),
      priceNative: num(pair.priceNative),
      marketCapUsd: num(pair.marketCap),
      fdvUsd: num(pair.fdv) || num(pair.marketCap),
      liquidityUsd,
      volume5mUsd: num(pair.volume?.m5),
      volume1hUsd: num(pair.volume?.h1),
      volume6hUsd: num(pair.volume?.h6),
      volume24hUsd: num(pair.volume?.h24),
      priceChange5m: num(pair.priceChange?.m5),
      priceChange1h: num(pair.priceChange?.h1),
      priceChange6h: num(pair.priceChange?.h6),
      priceChange24h: num(pair.priceChange?.h24),
      buys24h: num(pair.txns?.h24?.buys),
      sells24h: num(pair.txns?.h24?.sells),
      marketCount: (existing?.marketCount ?? 0) + 1,
      name: (pair.baseToken?.name as string) ?? null,
      symbol: (pair.baseToken?.symbol as string) ?? null,
      imageUrl: (info.imageUrl as string) ?? null,
      websiteUrl: websites[0]?.url ?? null,
      twitterUrl: socials.find((s) => s.type === 'twitter')?.url ?? null,
      telegramUrl: socials.find((s) => s.type === 'telegram')?.url ?? null,
      createdAtMs: typeof pair.pairCreatedAt === 'number' ? pair.pairCreatedAt : null,
      boosts: num(pair.boosts?.active),
    });
  }
  return out;
}

/**
 * What has been PAID FOR on a token — and it is reported, never scored.
 *
 * A filled profile is what a real project does and most scams do not bother
 * with; a trending-bar advert is exactly as likely to be a marketing budget as
 * an exit being funded. Collapsing the two into one "promoted" flag would make
 * the second look like the first.
 *
 * Returns null when the lookup could not be made, which is different from an
 * empty array: empty means checked and nothing bought, and that is not a mark
 * against a token.
 */
export async function fetchPaidOrders(mint: string): Promise<DexOrderType[] | null> {
  const data = await request<{ type?: string; status?: string }[]>(`/orders/v1/solana/${mint}`);
  if (!Array.isArray(data)) return null;
  const approved = data.filter((o) => o.status === 'approved');
  const known: DexOrderType[] = ['tokenProfile', 'communityTakeover', 'tokenAd', 'trendingBarAd'];
  return known.filter((t) => approved.some((o) => o.type === t));
}

/** The boost boards — one request for the whole chain, rather than per token. */
export async function fetchBoostBoard(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const path of ['/token-boosts/latest/v1', '/token-boosts/top/v1']) {
    const data = await request<{ chainId?: string; tokenAddress?: string; amount?: number; totalAmount?: number }[]>(path);
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      if (row.chainId !== 'solana' || !row.tokenAddress) continue;
      const amount = num(row.totalAmount ?? row.amount);
      out.set(row.tokenAddress, Math.max(out.get(row.tokenAddress) ?? 0, amount));
    }
  }
  return out;
}

/**
 * Newly profiled tokens — a discovery source, and a weak one.
 *
 * It only ever contains tokens somebody PAID to list, so it is biased toward
 * launches with a budget. It is used as one input among several rather than as
 * the feed, precisely because a screener fed only by this would be a directory
 * of whoever is advertising hardest.
 */
export async function fetchLatestProfiles(): Promise<string[]> {
  const data = await request<{ chainId?: string; tokenAddress?: string }[]>('/token-profiles/latest/v1');
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r.chainId === 'solana' && r.tokenAddress).map((r) => r.tokenAddress!);
}
