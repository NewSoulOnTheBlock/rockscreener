import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTransferFeeConfig } from '@solana/spl-token';
import { PublicKey, rpc } from '../clients/solana.js';
import { errField, logger } from '../infra/logger.js';

/**
 * The mint account, read from the chain itself.
 *
 * WHY THIS EXISTS WHEN RUGCHECK ALREADY REPORTS AUTHORITIES. RugCheck does not
 * cover every mint, and the tokens it does not cover are exactly the ones that
 * matter most here: the minutes-old launches an automated buyer would most like
 * to act on. Reading the account directly costs one RPC call and answers the
 * two questions that can take a whole position — can more supply be printed,
 * and can your account be frozen — for any mint that exists at all.
 *
 * IT IS ALSO THE AUTHORITY WHERE THE TWO DISAGREE. A third party's report is a
 * claim about the chain; this is the chain.
 */

const log = logger.child({ source: 'mint-account' });

export interface MintFacts {
  decimals: number;
  /** Raw base units as a decimal string — a uint64 does not fit a double. */
  supply: string;
  /** TRUE = revoked. These are never null when the read succeeded. */
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Token-2022 transfer fee in basis points. Zero for a plain SPL mint. */
  transferFeeBps: number;
  isToken2022: boolean;
}

/**
 * MANY MINTS, ONE ROUND TRIP.
 *
 * `getMint` is one request per mint, and the mint account is the cheapest and
 * most universally needed reading in the system — it answers the two questions
 * that can take a whole position. Reading it one at a time made it the slowest
 * thing in the indexer for no reason: the account layout is fixed, so a hundred
 * of them decode out of one `getMultipleAccounts`.
 *
 * TOKEN-2022 FALLS BACK TO THE SINGLE READ. Its extensions live past the base
 * layout and `getTransferFeeConfig` wants a decoded mint, so a token whose
 * owner program is Token-2022 is re-read individually — a small minority of
 * mints paying for the generality they actually use.
 */
export async function readMintBatch(mints: string[]): Promise<Map<string, MintFacts | null>> {
  const out = new Map<string, MintFacts | null>();
  if (mints.length === 0) return out;

  const keys: { mint: string; key: PublicKey }[] = [];
  for (const mint of mints.slice(0, 100)) {
    try {
      keys.push({ mint, key: new PublicKey(mint) });
    } catch {
      out.set(mint, null);
    }
  }
  if (keys.length === 0) return out;

  try {
    const accounts = await rpc().getMultipleAccountsInfo(
      keys.map((k) => k.key),
      'confirmed'
    );

    const token2022: string[] = [];
    keys.forEach((k, i) => {
      const account = accounts[i];
      if (!account) {
        out.set(k.mint, null);
        return;
      }
      if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        // Extensions: worth the individual read, and there are few of them.
        token2022.push(k.mint);
        return;
      }
      out.set(k.mint, parseMint(account.data));
    });

    for (const mint of token2022) {
      out.set(mint, await readMint(mint));
    }
  } catch (err) {
    log.debug({ count: keys.length, err: errField(err) }, 'mint batch read failed');
  }
  return out;
}

/**
 * The classic SPL mint layout, 82 bytes and fixed.
 *
 *   4  mint authority option   32  mint authority
 *   8  supply                   1  decimals      1  isInitialized
 *   4  freeze authority option 32  freeze authority
 *
 * The OPTION words are the point: a zero there means the authority is revoked,
 * and the 32 bytes after it are then meaningless padding rather than an
 * address. Reading the bytes without the option is how a revoked authority
 * comes to look like a live one owned by the system program.
 */
function parseMint(data: Buffer): MintFacts | null {
  if (data.length < 82) return null;
  const mintAuthorityOption = data.readUInt32LE(0);
  const supply = data.readBigUInt64LE(36);
  const decimals = data.readUInt8(44);
  const freezeAuthorityOption = data.readUInt32LE(46);

  return {
    decimals,
    supply: supply.toString(),
    mintAuthorityRevoked: mintAuthorityOption === 0,
    freezeAuthorityRevoked: freezeAuthorityOption === 0,
    // A classic SPL mint has no extensions, so zero is a READING rather than a
    // default: this token charges no transfer fee, and cannot.
    transferFeeBps: 0,
    isToken2022: false,
  };
}

export async function readMint(mint: string): Promise<MintFacts | null> {
  const key = new PublicKey(mint);

  /*
   * BOTH PROGRAMS, IN ORDER. A Token-2022 mint read through the classic program
   * id does not fail cleanly — it decodes garbage or throws depending on the
   * layout — so the program is established by trying the common case first and
   * falling through, rather than guessed from the address.
   */
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const info = await getMint(rpc(), key, 'confirmed', programId);
      const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);

      /*
       * The transfer fee is the Solana form of a sell tax, and it is the one
       * that is INVISIBLE in a price feed: the pool quotes a fair price and the
       * holder receives less than the transaction says they did. It only exists
       * on Token-2022, so a classic mint reads a true zero rather than a null.
       */
      let transferFeeBps = 0;
      if (isToken2022) {
        const config = getTransferFeeConfig(info);
        if (config) {
          transferFeeBps = Math.max(
            config.newerTransferFee.transferFeeBasisPoints,
            config.olderTransferFee.transferFeeBasisPoints
          );
        }
      }

      return {
        decimals: info.decimals,
        supply: info.supply.toString(),
        mintAuthorityRevoked: info.mintAuthority === null,
        freezeAuthorityRevoked: info.freezeAuthority === null,
        transferFeeBps,
        isToken2022,
      };
    } catch {
      // Wrong program, or the account does not exist. Try the next one; the
      // caller gets null only when neither answered.
      continue;
    }
  }

  log.debug({ mint }, 'mint account could not be read under either token program');
  return null;
}

/**
 * How much of one mint an owner holds, across both token programs.
 *
 * Used by the ROCK gate, and it sums rather than taking the first hit: a wallet
 * can hold the same mint in more than one account, and a gate that read only
 * the associated one would tell somebody holding through a different account
 * that they hold nothing.
 */
export async function balanceOf(owner: string, mint: string): Promise<bigint> {
  const ownerKey = new PublicKey(owner);
  const mintKey = new PublicKey(mint);
  let total = 0n;

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const res = await rpc().getParsedTokenAccountsByOwner(ownerKey, { mint: mintKey, programId });
      for (const { account } of res.value) {
        const raw = (account.data as any)?.parsed?.info?.tokenAmount?.amount;
        if (typeof raw === 'string') total += BigInt(raw);
      }
    } catch (err) {
      log.debug({ owner, mint, err: errField(err) }, 'balance read failed');
    }
  }
  return total;
}
