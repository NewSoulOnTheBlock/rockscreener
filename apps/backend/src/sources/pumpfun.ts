import { loadConfig } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';
import { normalizeUri } from './token-metadata.js';

/**
 * pump.fun's own record of a coin — the ONLY place its artwork exists.
 *
 * WHY THIS HAD TO BE BUILT. The metadata reader before it derives the Metaplex
 * PDA and reads it off any RPC, which works for every SPL token on Solana
 * except the one launchpad that is most of this index: pump.fun DOES NOT CREATE
 * A METADATA ACCOUNT. This was verified against the chain rather than assumed —
 * BONK's PDA reads perfectly, 679 bytes with the right owner, and every
 * pump.fun mint's PDA is simply absent. So the on-chain pass correctly stamps
 * "read, nothing there" on nine thousand tokens and they never get a picture.
 *
 * WHAT IT COSTS. One unauthenticated HTTP call per mint, no batch endpoint
 * (`/coins?mint=a&mint=b` exists and ignores the parameters, returning an
 * unrelated page — it was tried). That is the price of the only copy of the
 * data, and it is spaced rather than hammered.
 *
 * EVERY FIELD IS UNTRUSTED. The name, the symbol, the description and the image
 * URL are all attacker-controlled strings — whoever launched the token typed
 * them — so they are length-capped here and the URLs go through the same
 * `normalizeUri` allowlist the IPFS path uses: http(s) only, no `data:`.
 *
 * WHAT IS DELIBERATELY NOT TAKEN: the market numbers. `market_cap`,
 * `virtual_sol_reserves` and `ath_market_cap` are all here and all ignored.
 * DexScreener is the only price this product displays, and quietly mixing a
 * second source into the same column is how a screener ends up showing two
 * different market caps for one token depending on which worker ran last.
 */

const API = 'https://frontend-api-v3.pump.fun/coins';
const cfg = loadConfig();
const spacer = new Spacer(cfg.sources.pumpfun.minIntervalMs);
const log = logger.child({ source: 'pumpfun' });

/** How much of an attacker-supplied string is worth keeping. */
const MAX_NAME = 64;
const MAX_SYMBOL = 16;
const MAX_DESCRIPTION = 500;

export interface PumpCoin {
  name: string | null;
  symbol: string | null;
  description: string | null;
  /** Already an https URL — pump.fun resolves IPFS on its side. Re-checked. */
  imageUrl: string | null;
  metadataUri: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
  creator: string | null;
  /** True once the curve has completed. Not written anywhere: see the note. */
  complete: boolean | null;
}

/**
 * The coin, or null.
 *
 * NULL IS RETURNED FOR BOTH "not found" AND "the call failed", and the CALLER
 * IS TOLD WHICH by the boolean — a 404 is a fact about the mint and should
 * never be retried, while a timeout is a fact about the network and should be.
 * Collapsing them is how a backfill either loops forever on dead mints or gives
 * up on live ones after one bad minute.
 */
export async function fetchCoin(
  mint: string
): Promise<{ coin: PumpCoin | null; definitive: boolean }> {
  await spacer.wait();

  try {
    const res = await fetch(`${API}/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(cfg.sources.pumpfun.timeoutMs),
      headers: { accept: 'application/json' },
    });

    if (res.status === 429) {
      spacer.backoff();
      return { coin: null, definitive: false };
    }
    // The mint is not a pump.fun coin, and never will be. Settled.
    if (res.status === 404) return { coin: null, definitive: true };
    if (!res.ok) return { coin: null, definitive: false };

    const body = (await res.json()) as Record<string, unknown>;
    // A response that is not an object with our mint in it is a response to
    // some other question — pump.fun answers `/coins?mint=` with an unrelated
    // listing, and this is the guard that keeps such a body from being written
    // onto the wrong token.
    if (typeof body.mint !== 'string' || body.mint !== mint) {
      return { coin: null, definitive: false };
    }

    return { coin: parse(body), definitive: true };
  } catch (err) {
    log.debug({ mint, err: errField(err) }, 'pump.fun coin fetch failed');
    return { coin: null, definitive: false };
  }
}

function parse(body: Record<string, unknown>): PumpCoin {
  return {
    name: str(body.name, MAX_NAME),
    symbol: str(body.symbol, MAX_SYMBOL),
    description: str(body.description, MAX_DESCRIPTION),
    imageUrl: url(body.image_uri),
    metadataUri: url(body.metadata_uri),
    websiteUrl: url(body.website),
    twitterUrl: url(body.twitter),
    telegramUrl: url(body.telegram),
    creator: str(body.creator, 64),
    complete: typeof body.complete === 'boolean' ? body.complete : null,
  };
}

/** A capped, trimmed string, or null for anything that is not one. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s.slice(0, max);
}

/** The same allowlist the IPFS path uses. `data:` and `javascript:` die here. */
function url(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? normalizeUri(v) : null;
}
