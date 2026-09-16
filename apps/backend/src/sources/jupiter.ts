import { SOL_MINT } from '@rockscreener/shared';
import { env, loadConfig } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * Jupiter — ROUTING, and never a displayed price.
 *
 * THE DIVISION OF LABOUR MATTERS. DexScreener is the only source of the prices
 * this product shows, because two sources for one number is how a card and a
 * row come to disagree on the same screen. Jupiter answers two different
 * questions that no price feed can:
 *
 *   "can a real balance actually get out, and at what cost?"   -> `quote`
 *   "what is this trade going to look like on chain?"          -> `swap`
 *
 * The one exception is `priceOf`, used for the ROCK gate — there is no card
 * showing that number beside a DexScreener one, and the gate needs a price for
 * a token that may have almost no market.
 */

const cfg = loadConfig();
const spacer = new Spacer(cfg.sources.jupiter.minIntervalMs);
const log = logger.child({ source: 'jupiter' });

/** The keyed host has real limits; the lite host is what an unkeyed run gets. */
const SWAP_API = env.jupiterApiKey ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
/**
 * PRICE V3, not v2. The v2 host answers 404 — it was retired — and v3 changed
 * the response shape as well as the path: the payload is now keyed by mint at
 * the top level with no `data` wrapper, and the field is `usdPrice` rather than
 * `price`. Both changes are handled in `priceOf`, and a shape that does not
 * match returns null rather than NaN.
 */
const PRICE_API = env.jupiterApiKey ? 'https://api.jup.ag/price/v3' : 'https://lite-api.jup.ag/price/v3';
const HEADERS: Record<string, string> = env.jupiterApiKey ? { 'x-api-key': env.jupiterApiKey } : {};

export interface Quote {
  inputMint: string;
  outputMint: string;
  /** Base units in, as a decimal string. */
  inAmount: string;
  outAmount: string;
  /** What the route would cost against the spot mid, percent. */
  priceImpactPct: number;
  /** The raw response, handed back to `/swap` untouched. */
  raw: unknown;
}

async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
  await spacer.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.sources.jupiter.timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (res.status === 429) {
      spacer.backoff();
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    log.debug({ url, err: errField(err) }, 'request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A route, or null.
 *
 * NULL IS A MEANINGFUL ANSWER HERE and callers must not treat it as an outage.
 * "No route for this size" is precisely the honeypot condition the sell check
 * is looking for — a token that cannot be sold has no route out of it — which
 * is why `sellCheck` distinguishes a null caused by a timeout from a null
 * caused by the aggregator having nothing to offer. See `probeSell`.
 */
export async function quote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number
): Promise<Quote | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
    // Direct routes only would understate what is actually available; the
    // default multi-hop search is the one a real trade would take.
    restrictIntermediateTokens: 'true',
  });
  const data = await call<Record<string, any>>(`${SWAP_API}/quote?${params}`);
  if (!data || !data.outAmount) return null;
  return {
    inputMint,
    outputMint,
    inAmount: String(data.inAmount ?? amount),
    outAmount: String(data.outAmount),
    priceImpactPct: Number(data.priceImpactPct ?? 0) * 100,
    raw: data,
  };
}

/** The unsigned, serialised swap transaction for a quote we already hold. */
export interface SwapBuild {
  /** The unsigned transaction, base64. */
  transaction: string;
  /**
   * The last block height at which the transaction can still land.
   *
   * RETURNED RATHER THAN DISCARDED because it is the ONLY correct deadline for
   * confirming this transaction, and it cannot be recovered afterwards: asking
   * the RPC for a fresh blockhash after sending gives the deadline of a
   * DIFFERENT blockhash, roughly a minute later than the real one. A confirm
   * loop told to wait that long keeps waiting on a transaction that can no
   * longer land, and the engine holds an entry slot open the whole time.
   */
  lastValidBlockHeight: number | null;
}

export async function swapTransaction(
  quoteRaw: unknown,
  userPublicKey: string,
  maxPriorityFeeLamports: number
): Promise<SwapBuild | null> {
  const data = await call<{ swapTransaction?: string; lastValidBlockHeight?: number }>(`${SWAP_API}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteRaw,
      userPublicKey,
      // Both of these are about the trade LANDING rather than about its price.
      // A swap that is correct and never confirms is a swap that did not happen.
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: maxPriorityFeeLamports,
          priorityLevel: 'high',
        },
      },
      // The account is closed after a full exit, so the rent comes back rather
      // than being left scattered across a hundred empty token accounts.
      dynamicSlippage: false,
    }),
  });
  if (!data?.swapTransaction) return null;
  return {
    transaction: data.swapTransaction,
    lastValidBlockHeight:
      typeof data.lastValidBlockHeight === 'number' ? data.lastValidBlockHeight : null,
  };
}

/**
 * A dollar price for one mint. Used by the ROCK gate and by nothing the screener
 * displays.
 *
 * Returns null rather than zero when no source answers, and the gate treats
 * that null as CLOSED. A gate that fails open on a pricing outage is not a gate.
 */
export async function priceOf(mint: string): Promise<number | null> {
  const data = await call<Record<string, { usdPrice?: number | string }>>(`${PRICE_API}?ids=${mint}`);
  const raw = data?.[mint]?.usdPrice;
  const price = typeof raw === 'string' ? Number(raw) : raw;
  // Zero and NaN are both "no price" rather than a free token: the gate reads
  // this and is built to fail closed on a null.
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * THE SELL CHECK'S SIMULATION HALF: would a real-size exit route, and at what
 * cost?
 *
 * TWO FAILURES, TOLD APART. A route that does not exist is evidence about the
 * TOKEN; a request that timed out is evidence about us. They are returned as
 * different things because conflating them is how "our API was slow for ninety
 * seconds" becomes "these four hundred tokens cannot be sold".
 *
 * The probe is sized in DOLLARS rather than in tokens, because the question is
 * whether a position a person would actually hold can be closed — a one-token
 * sell routes through anything and proves nothing.
 */
export async function probeSell(
  mint: string,
  decimals: number,
  priceUsd: number,
  probeUsd: number
): Promise<
  | { kind: 'routed'; impactPct: number; effectiveTaxBps: number }
  | { kind: 'no_route' }
  | { kind: 'unavailable' }
> {
  if (!(priceUsd > 0)) return { kind: 'unavailable' };

  const tokens = probeUsd / priceUsd;
  const amount = BigInt(Math.max(1, Math.floor(tokens * 10 ** decimals))).toString();

  const solOut = await quote(mint, SOL_MINT, amount, 300);
  if (!solOut) {
    /*
     * One retry at a tenth of the size before concluding "no route".
     *
     * A thin but genuine pool can fail a $250 probe and pass a $25 one, and
     * calling that token unsellable would be wrong in the direction that costs
     * a user a good trade. A token that fails BOTH has no exit at any size
     * worth taking, and that is the finding.
     */
    const smaller = BigInt(Math.max(1, Math.floor((tokens / 10) * 10 ** decimals))).toString();
    const retry = await quote(mint, SOL_MINT, smaller, 300);
    if (!retry) return { kind: 'no_route' };
    return {
      kind: 'routed',
      impactPct: retry.priceImpactPct,
      effectiveTaxBps: Math.max(0, Math.round(retry.priceImpactPct * 100)),
    };
  }

  return {
    kind: 'routed',
    impactPct: solOut.priceImpactPct,
    effectiveTaxBps: Math.max(0, Math.round(solOut.priceImpactPct * 100)),
  };
}
