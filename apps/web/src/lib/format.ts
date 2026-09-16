/**
 * Formatting, and the one rule that matters: A NUMBER NOBODY TOOK IS NOT ZERO.
 *
 * Every helper here takes `number | null | undefined` and returns an em dash for
 * the nullish case rather than "0" or "$0.00". That is not politeness, it is the
 * whole tri-state discipline of the product reaching the pixel: "0 holders" is a
 * claim about a token and "—" is an admission about us, and a reader deciding
 * what to buy is entitled to know which one they are looking at.
 */

const DASH = '—';

/** Money, compacted the way a trader reads it: $41.2K, $1.83M, $0.0000394. */
export function usd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const compact = opts.compact ?? true;
  const abs = Math.abs(value);

  if (abs === 0) return '$0';
  if (compact && abs >= 1_000) {
    return `$${compactNumber(value)}`;
  }
  if (abs >= 1) return `$${value.toFixed(2)}`;

  /*
   * Sub-dollar prices get SIGNIFICANT digits rather than fixed decimals.
   * `toFixed(6)` prints $0.000000 for most of this market, which is a price of
   * zero on a token that is trading — the single most misleading thing a
   * screener can put on a screen.
   */
  return `$${value.toPrecision(3).replace(/(\.\d*?[1-9])0+$/, '$1')}`;
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}K`;
  return `${sign}${abs >= 100 ? Math.round(abs) : trim(abs)}`;
}

/**
 * Two significant figures, and NO DECIMALS ON A WHOLE NUMBER.
 *
 * The integer case is why this is not a one-liner: a holder count of 0 or 7 is
 * a COUNT, and `toFixed(2)` printed it as "0.00" — which then lost one trailing
 * zero to the strip and rendered as "0.0 holders". A count with a decimal point
 * in it reads as a measurement that has been through an average.
 */
function trim(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(0);
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/0$/, '');
}

/** A plain count. Null is a dash; zero is "0", because zero holders is a fact. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return compactNumber(value);
}

/** A percentage change, signed, for the movement columns. */
export function pctChange(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** A share of something, unsigned. `34.1%`. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(digits)}%`;
}

/** A multiple, as a call's record shows it. `4.26x`. */
export function multiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(2)}x`;
}

/** Lamports to SOL, for the one place a raw integer reaches the screen. */
export function sol(lamports: string | number | null | undefined, digits = 3): string {
  if (lamports === null || lamports === undefined) return DASH;
  const n = typeof lamports === 'string' ? Number(lamports) : lamports;
  if (!Number.isFinite(n)) return DASH;
  return `${(n / 1_000_000_000).toFixed(digits)} SOL`;
}

/**
 * How long ago, in the shortest form that is still unambiguous.
 *
 * Seconds up to a minute, because on a launch feed the difference between 8s
 * and 45s old is the entire decision.
 */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return DASH;
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** An age in seconds, for the row's "how new is this" chip. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * A mint, shortened. Solana addresses are 32-44 base58 characters and no row
 * has room for one, but the first four and last four are what people actually
 * compare against the address in their wallet.
 */
export function shortMint(address: string | null | undefined, lead = 4, tail = 4): string {
  if (!address) return DASH;
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export { DASH };
