/**
 * Solana, and only Solana.
 *
 * There is no `ChainKey` in this product and that is deliberate. The
 * predecessor this replaces carried a chain column through every table, every
 * cache key and every API path in order to serve exactly one chain — which
 * bought nothing and cost a join key on the hot path of every screener query.
 * If a second chain ever arrives it will arrive as a second deployment.
 */
export const CHAIN = 'solana' as const;
export type Chain = typeof CHAIN;

/** Wrapped SOL. Every price in this product is quoted through it. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** USDC, for the rare pool that quotes in dollars rather than in SOL. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Where a token was born. Named rather than inferred, because the launchpad is
 * the single strongest prior available about a Solana token's contract: a
 * pump.fun mint has no mint authority and no freeze authority by construction,
 * and a token that claims to be one and is not is already lying.
 */
export const LAUNCHPADS = [
  'pumpfun',
  'pumpswap',
  'raydium',
  'raydium-cpmm',
  'meteora',
  'moonshot',
  'boop',
  'believe',
  'jupiter-studio',
  'unknown',
] as const;
export type Launchpad = (typeof LAUNCHPADS)[number];

/**
 * Mints whose balance nobody should read as a holder.
 *
 * The largest "holder" of almost every Solana token is its own AMM vault, and
 * a distribution metric that counts it reports every healthy graduated token as
 * maximally concentrated. RugCheck labels these in `knownAccounts`; this list
 * is the fallback for the ones it does not.
 */
export const BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
];

/** A Solana address, as far as its shape can say. Not a curve check. */
export function looksLikeMint(raw: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
}

/** Solscan, because it is the one every Solana trader already has open. */
export function explorerToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

export function explorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function explorerAccount(address: string): string {
  return `https://solscan.io/account/${address}`;
}

/**
 * ROCK — the platform token, and the key to the auto-trade engine.
 *
 * Held rather than spent: see `RockGate` in account.ts for why the entitlement
 * is a position rather than a subscription. The mint is a constant here and
 * OVERRIDABLE by `ROCK_MINT` in the backend environment, because a devnet
 * deployment and a staging deployment both need a different one and neither
 * should require a code change to get it.
 */
export const ROCK_MINT = '7LxC96Ag4DnBotK6bMMUj4kdneAo1kdV1xHnzVF5s7W2';

/** Dollar value of ROCK that opens auto-trade. */
export const ROCK_GATE_USD = 500;
