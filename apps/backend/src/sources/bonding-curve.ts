import { PublicKey, rpc } from '../clients/solana.js';
import { errField, logger } from '../infra/logger.js';

/**
 * How far a pump.fun curve has filled, read from the curve account itself.
 *
 * WHY READ IT AT ALL. For a token still on a curve there is no pool to measure,
 * no LP to check and no depth to score — the curve IS the liquidity, and its
 * only meaningful reading is how far it has gone. `scoreLiquidity` scores a
 * bonding token entirely on this number, and without it every pre-graduation
 * token reads as having no liquidity, which is true of the pool and false of
 * the token.
 *
 * NULL WHEN THE ACCOUNT CANNOT BE READ, and that is the whole reason this file
 * exists rather than a constant. The column used to be `0` for every bonding
 * token, which put "0%" on a chip beside a curve nobody had looked at — a
 * fabricated reading of the most specific kind.
 */

const log = logger.child({ source: 'bonding-curve' });

/** pump.fun's program. The curve account is a PDA under it. */
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/**
 * Tokens the curve starts with and sells down to zero.
 *
 * 793,100,000 of a 1,000,000,000 supply: the rest is reserved for the pool the
 * token graduates into. Progress is what has left the curve, not what the
 * market cap happens to be.
 */
const CURVE_TOKENS = 793_100_000n * 1_000_000n;

export interface CurveState {
  /** 0..10000. Basis points so the column is an integer. */
  progressBps: number;
  /** Set once the curve has filled and the token is migrating. */
  complete: boolean;
  /**
   * SOL actually sitting in the curve, in lamports.
   *
   * THIS IS THE TOKEN'S LIQUIDITY and nothing else reports it. DexScreener
   * returns `liquidity.usd = 0` for a pump.fun curve pair — it is not a pool
   * and has no LP — so the entire pre-graduation half of the index showed "$0"
   * in a liquidity column while holding real money. The reserve is what backs a
   * sell, which is exactly what the column is asking.
   *
   * REAL, not virtual. The curve carries a virtual reserve too, used to shape
   * the price curve; it is not money and cannot be sold into.
   */
  solLamports: bigint;
}

export function bondingCurveAddress(mint: string): PublicKey | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM
    );
    return pda;
  } catch {
    return null;
  }
}

/**
 * Reads one curve.
 *
 * THE LAYOUT IS FIXED AND IS PARSED BY HAND. It is an Anchor account: an
 * eight-byte discriminator followed by five little-endian u64s and a bool.
 * Pulling in the IDL and an Anchor client to read forty-one bytes would add a
 * heavyweight dependency — and a version-coupling to a program we do not
 * control — for a `readBigUInt64LE`.
 *
 * A SHORT ACCOUNT IS A REFUSAL, not a best effort. If pump.fun ever adds a
 * field the offsets stay valid (Anchor appends), and if the account is smaller
 * than expected it is not the account we think it is.
 */
/**
 * MANY CURVES, ONE ROUND TRIP.
 *
 * The curve address is a PDA derived from the mint, so a hundred of them are a
 * hundred local derivations and ONE `getMultipleAccountsInfo`. Read one at a
 * time, three thousand bonding tokens took twenty minutes a cycle — and the
 * liquidity column for every one of them stayed at zero for that whole cycle,
 * which is the state the screener was in.
 *
 * A HUNDRED IS THE RPC'S CEILING on that method.
 */
const MAX_ACCOUNTS_PER_CALL = 100;

export async function readCurveBatch(mints: string[]): Promise<Map<string, CurveState | null>> {
  const out = new Map<string, CurveState | null>();
  if (mints.length === 0) return out;

  const derived: { mint: string; address: PublicKey }[] = [];
  for (const mint of mints.slice(0, MAX_ACCOUNTS_PER_CALL)) {
    const address = bondingCurveAddress(mint);
    if (!address) out.set(mint, null);
    else derived.push({ mint, address });
  }
  if (derived.length === 0) return out;

  try {
    const accounts = await rpc().getMultipleAccountsInfo(
      derived.map((d) => d.address),
      'confirmed'
    );
    derived.forEach((d, i) => {
      const account = accounts[i];
      out.set(d.mint, account ? parseCurve(account.data) : null);
    });
  } catch (err) {
    log.debug({ count: derived.length, err: errField(err) }, 'curve batch read failed');
  }
  return out;
}

/** One curve, for the rare caller that has exactly one. */
export async function readCurve(mint: string): Promise<CurveState | null> {
  return (await readCurveBatch([mint])).get(mint) ?? null;
}

function parseCurve(data: Buffer): CurveState | null {
  if (data.length < 8 + 8 * 5 + 1) return null;

  // 8 discriminator, then: virtualToken, virtualSol, realToken, realSol,
  // tokenTotalSupply, complete.
  const realTokenReserves = data.readBigUInt64LE(8 + 8 * 2);
  const realSolReserves = data.readBigUInt64LE(8 + 8 * 3);
  const complete = data.readUInt8(8 + 8 * 5) === 1;

  /*
   * Progress is what has LEFT the curve. Clamped at both ends because a
   * reserve above the starting figure — which a program upgrade or an
   * unexpected layout would produce — must not render as a negative
   * percentage on a chip.
   */
  const sold = CURVE_TOKENS > realTokenReserves ? CURVE_TOKENS - realTokenReserves : 0n;
  const bps = Number((sold * 10_000n) / CURVE_TOKENS);

  return {
    progressBps: Math.max(0, Math.min(10_000, bps)),
    complete,
    solLamports: realSolReserves,
  };
}
