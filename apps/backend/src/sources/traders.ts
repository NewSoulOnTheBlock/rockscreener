import { env } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * DISTINCT TRADERS — the number a bundle cannot fake cheaply.
 *
 * WHY IT IS WORTH FETCHING AT ALL. One wallet trading against itself produces
 * any transaction count you like for the price of a few thousand lamports;
 * producing two hundred distinct counterparties costs two hundred funded
 * wallets. The aggregate feeds publish only the transaction count, so the
 * momentum pillar has been falling back to it at a deliberately lower ceiling.
 * This is the real reading.
 *
 * IT IS A LOWER BOUND, AND THAT IS EXACTLY RIGHT FOR WHAT USES IT.
 *
 * Only the most recent few hundred transactions are read, so on a very busy
 * token the window covered is shorter than a day and the count is an
 * UNDERSTATEMENT. That matters not at all, because the momentum pillar puts
 * this on a log scale that saturates around two hundred and fifty traders: a
 * token where three hundred sampled transactions came from two hundred
 * different wallets has already earned everything the reading can give it.
 *
 * On a quiet token the same three hundred transactions cover far more than a
 * day, and the count is EXACT — which is the half of the range where precision
 * actually changes a grade.
 *
 * Understating is also the safe direction: it can only ever lower a score.
 */

const log = logger.child({ source: 'traders' });
const spacer = new Spacer(150);

const PAGE = 100;
const MAX_PAGES = 3;

export function tradersAvailable(): boolean {
  return env.heliusApiKey !== null;
}

/**
 * Distinct fee payers on a pool's recent transactions, within 24 hours.
 *
 * The FEE PAYER rather than a parsed swap participant: a swap's payer is the
 * person doing it, it is present on every transaction regardless of which
 * program routed the trade, and it does not require understanding six AMM
 * instruction layouts that each change on their own schedule.
 */
export async function distinctTraders24h(poolAddress: string): Promise<number | null> {
  const key = env.heliusApiKey;
  if (!key) return null;

  const since = Math.floor(Date.now() / 1000) - 86_400;
  const wallets = new Set<string>();
  let before: string | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      await spacer.wait();
      const url = `https://api.helius.xyz/v0/addresses/${poolAddress}/transactions?api-key=${key}&limit=${PAGE}${
        before ? `&before=${before}` : ''
      }`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) break;

      const batch = (await res.json()) as { signature: string; timestamp: number; feePayer?: string }[];
      if (!Array.isArray(batch) || batch.length === 0) break;

      let reachedWindow = false;
      for (const tx of batch) {
        if (tx.timestamp < since) {
          // Past 24 hours. Everything older is outside the window this number
          // is about, so the walk stops here rather than counting it.
          reachedWindow = true;
          break;
        }
        if (tx.feePayer) wallets.add(tx.feePayer);
      }

      if (reachedWindow || batch.length < PAGE) break;
      before = batch[batch.length - 1]!.signature;
    }

    // Zero transactions read is "nothing answered", not "nobody traded" — the
    // transaction count on the row already says whether anybody traded.
    return wallets.size > 0 ? wallets.size : null;
  } catch (err) {
    log.debug({ poolAddress, err: errField(err) }, 'trader count failed');
    return null;
  }
}
