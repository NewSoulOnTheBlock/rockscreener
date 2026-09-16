import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * GeckoTerminal — used for ONE thing, and deliberately not for more.
 *
 * NO CANDLES ARE STORED BY THIS PRODUCT. The token page embeds DexScreener's
 * own chart, which is free, already correct, and does not require backfilling
 * and pruning an OHLCV table for hundreds of thousands of mints.
 *
 * The single thing a chart embed cannot give is the object the call cards are
 * built on: a price path denominated in MULTIPLES OF THE PRICE A CALL WAS MADE
 * AT, where 1.0 is the line between the call having worked and not. So when a
 * call is created, this fetches a short recent history and converts it into
 * that series, and the tracker appends live points afterwards.
 *
 * Seeding rather than requiring: a call whose seed fails starts as a flat mark
 * and fills in as it is tracked. It is a nicer first render, never a fact the
 * product depends on.
 */

const BASE = 'https://api.geckoterminal.com/api/v2';
// Their published ceiling is 30 requests a minute for the free tier, and this
// runs once per call rather than per tick.
const spacer = new Spacer(2_100);
const log = logger.child({ source: 'geckoterminal' });

/**
 * Recent closes for a pool, oldest first, as multiples of `entryPriceUsd`.
 *
 * Returns an empty array on any failure — including "this pool is too new to
 * have a history", which is the usual answer for exactly the tokens calls fire
 * on.
 */
export async function seedSpark(
  poolAddress: string,
  entryPriceUsd: number,
  points: number
): Promise<number[]> {
  if (!(entryPriceUsd > 0)) return [];

  await spacer.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=${points}`,
      { signal: controller.signal, headers: { accept: 'application/json;version=20230302' } }
    );
    if (!res.ok) {
      if (res.status === 429) spacer.backoff();
      return [];
    }
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = body.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) return [];

    /*
     * Their list is NEWEST FIRST and each row is [ts, o, h, l, c, v]. Reversing
     * is not cosmetic — a sparkline drawn backwards shows every call as having
     * done the exact opposite of what it did.
     */
    return list
      .slice()
      .reverse()
      .map((row) => row[4])
      .filter((close): close is number => typeof close === 'number' && close > 0)
      .map((close) => close / entryPriceUsd);
  } catch (err) {
    log.debug({ poolAddress, err: errField(err) }, 'ohlcv seed failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}
