import { VersionedTransaction } from '@solana/web3.js';
import type { TradingWallet as WalletRow } from '@prisma/client';
import { SOL_MINT } from '@rockscreener/shared';
import { tradeRpc } from '../clients/solana.js';
import { AppError } from '../infra/errors.js';
import { sleep } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { quote, swapTransaction } from '../sources/jupiter.js';
import { balanceOf } from '../sources/mint-account.js';
import { keypairFor } from './wallets.js';

/**
 * Filling a trade.
 *
 * THE RESULT IS READ FROM THE SETTLED TRANSACTION, NOT FROM THE QUOTE AND NOT
 * FROM A BALANCE DELTA. A quote is an estimate made before the transaction
 * existed. A balance delta — read the wallet before, read it after, subtract —
 * is closer but still wrong, because it attributes to THIS trade everything
 * that happened to the wallet in between: the entry and exit loops both run on
 * the same wallet and can overlap, and on a busy wallet the two deltas silently
 * contaminate each other's cost basis. `meta.preBalances` and
 * `meta.preTokenBalances` on the confirmed transaction are exact, attributable
 * to this signature alone, and cost one extra RPC read.
 *
 * A SEND THAT TIMES OUT IS NOT A FAILURE. It is an UNKNOWN, and the difference
 * decides whether the caller owns a bag it is not tracking. A timed-out buy may
 * well have landed, so it is raised as `UnconfirmedTrade` — a distinct type
 * carrying the signature — rather than as an error, and the engine keeps the
 * position open and settles it against the chain instead of writing it off.
 */

export interface FillResult {
  signature: string;
  /** Lamports actually spent (buy) or received (sell), measured on chain. */
  lamports: bigint;
  /** Token base units received (buy) or sold (sell), measured on chain. */
  tokens: bigint;
}

/**
 * The transaction was signed and broadcast, and we do not know how it ended.
 *
 * IT IS A CLASS, NOT A MESSAGE, so that no caller can mistake it for an
 * ordinary failure with an `instanceof`. The signature is the whole point: it
 * is the only handle on a trade that may be holding real money, and a caller
 * that swallows this type loses the ability to ever find out.
 */
export class UnconfirmedTrade extends Error {
  constructor(
    readonly signature: string,
    readonly detail: string
  ) {
    super(`The trade was broadcast but not confirmed in time (${signature}): ${detail}`);
    this.name = 'UnconfirmedTrade';
  }
}

/** How long to keep re-broadcasting before giving up on a signature. */
const CONFIRM_TIMEOUT_MS = 60_000;
/** How often to re-send the same signed transaction while waiting. */
const REBROADCAST_MS = 2_000;

export class Executor {
  private readonly log: Logger;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'executor' });
  }

  /**
   * SOL -> token. `lamports` is what the user is putting in.
   *
   * `onBroadcast` FIRES THE MOMENT THE SIGNATURE EXISTS and is awaited before
   * the wait for confirmation begins. That ordering is the whole safety
   * property: if this process dies between the send and the confirmation, the
   * signature is already on the position row, and the bag it may have bought
   * can still be found. A callback after the fill would be too late to help in
   * the one case it exists for.
   */
  async buy(
    wallet: WalletRow,
    mint: string,
    lamports: bigint,
    slippageBps: number,
    maxPriorityFeeLamports: bigint,
    onBroadcast?: (signature: string) => Promise<void>
  ): Promise<FillResult> {
    return this.swap(
      wallet,
      SOL_MINT,
      mint,
      lamports.toString(),
      slippageBps,
      maxPriorityFeeLamports,
      onBroadcast
    );
  }

  /** Token -> SOL. `tokens` is base units. */
  async sell(
    wallet: WalletRow,
    mint: string,
    tokens: bigint,
    slippageBps: number,
    maxPriorityFeeLamports: bigint
  ): Promise<FillResult> {
    /*
     * NEVER SELL MORE THAN IS THERE. The position row is this engine's belief
     * about the balance; the chain is the balance. They diverge whenever a fill
     * partially landed, a transfer fee took a cut, or somebody moved tokens by
     * hand — and a swap for more than the wallet holds fails outright, leaving
     * a position the engine believes it has exited.
     */
    const held = await this.tokenBalance(wallet.address, mint);
    const amount = tokens > held ? held : tokens;
    if (amount <= 0n) {
      throw AppError.badRequest('There is nothing left of that position to sell.');
    }

    return this.swap(wallet, mint, SOL_MINT, amount.toString(), slippageBps, maxPriorityFeeLamports);
  }

  /**
   * Build, sign, broadcast, keep broadcasting, then read what settled.
   *
   * @throws {UnconfirmedTrade} when the transaction was sent and its fate is
   * unknown. Every other failure means nothing was signed or nothing landed.
   */
  private async swap(
    wallet: WalletRow,
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    maxPriorityFeeLamports: bigint,
    onBroadcast?: (signature: string) => Promise<void>
  ): Promise<FillResult> {
    const routed = await quote(inputMint, outputMint, amount, slippageBps);
    if (!routed) {
      /*
       * No route is a REFUSAL, not an error to retry. On a sell it means the
       * thing the sell check exists to catch has happened; on a buy it means
       * the market moved out from under the candidate between scoring and
       * filling, and the engine should simply not be in it.
       */
      throw AppError.badRequest('No route is available for that trade right now.');
    }

    const built = await swapTransaction(routed.raw, wallet.address, Number(maxPriorityFeeLamports));
    if (!built) throw AppError.badRequest('The aggregator would not build that transaction.');

    const raw = Buffer.from(built.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(raw);
    const keypair = keypairFor(wallet);
    transaction.sign([keypair]);
    const wire = transaction.serialize();

    const connection = tradeRpc();
    /*
     * `skipPreflight` is ON, and it is the right call for this shape of trade.
     * Preflight simulates against a slightly stale slot; on a token moving fast
     * enough to be worth buying it routinely fails a transaction that would
     * have landed. The slippage tolerance in the quote is the real protection,
     * and it is enforced by the program rather than by a simulation.
     */
    const signature = await connection.sendRawTransaction(wire, {
      skipPreflight: true,
      maxRetries: 0,
    });

    // Before the wait, never after. See the note on `buy`.
    if (onBroadcast) await onBroadcast(signature).catch(() => undefined);

    await this.land(signature, wire, built.lastValidBlockHeight);
    return this.settled(signature, wallet.address, inputMint, outputMint);
  }

  /**
   * Waits for the signature, RE-BROADCASTING the whole time.
   *
   * THE RE-BROADCAST IS THE POINT. `sendRawTransaction` hands the transaction
   * to one RPC node once; `maxRetries` delegates the resending to that node,
   * which is exactly the thing that is overloaded during the congestion where a
   * resend matters. Re-sending the same signed bytes is free and idempotent —
   * the signature is already fixed, so a duplicate is dropped by the cluster,
   * never executed twice — and it is the difference between a trade that lands
   * and one that is silently dropped in a busy slot.
   *
   * THE DEADLINE IS THE TRANSACTION'S OWN. See `SwapBuild.lastValidBlockHeight`:
   * confirming against a blockhash fetched after the send is confirming against
   * somebody else's deadline.
   */
  private async land(
    signature: string,
    wire: Uint8Array,
    lastValidBlockHeight: number | null
  ): Promise<void> {
    const connection = tradeRpc();
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const status = await connection
        .getSignatureStatus(signature, { searchTransactionHistory: false })
        .catch(() => null);
      const value = status?.value ?? null;

      if (value?.err) {
        // It landed and the program rejected it. This IS a failure, and a
        // definite one — there is no bag to reconcile.
        throw AppError.badRequest(
          `The transaction failed on chain: ${JSON.stringify(value.err)}`
        );
      }
      if (value && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')) {
        this.log.info({ signature }, 'swap confirmed');
        return;
      }

      /*
       * THE BLOCK HEIGHT CHECK COMES AFTER THE STATUS CHECK, so a transaction
       * that landed in its final valid block is not written off by a height
       * read taken a moment later.
       */
      if (lastValidBlockHeight !== null) {
        const height = await connection.getBlockHeight('confirmed').catch(() => null);
        if (height !== null && height > lastValidBlockHeight) {
          /*
           * EXPIRED IS THE ONE CASE THAT IS DEFINITELY NOT A BAG. Past its
           * last valid block height a transaction can never be included, so
           * nothing was spent and the caller is free to try again.
           */
          throw AppError.badRequest('The transaction expired before it could land.');
        }
      }

      await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
      await sleep(REBROADCAST_MS);
    }

    throw new UnconfirmedTrade(signature, `no confirmation within ${CONFIRM_TIMEOUT_MS / 1_000}s`);
  }

  /**
   * What the transaction actually moved, from its own metadata.
   *
   * The wallet is always index 0 of a Jupiter swap's account keys — it is the
   * fee payer and the signer — but that is ASSERTED here by matching the
   * address rather than assumed, because a silently wrong index would produce a
   * plausible number rather than an error.
   */
  private async settled(
    signature: string,
    owner: string,
    inputMint: string,
    outputMint: string
  ): Promise<FillResult> {
    const tx = await tradeRpc()
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      .catch(() => null);

    if (!tx?.meta) {
      /*
       * Confirmed but not yet readable. The trade landed, so this is an
       * UNKNOWN SIZE rather than a failure, and the caller reconciles it from
       * the wallet the same way it reconciles a timeout.
       */
      throw new UnconfirmedTrade(signature, 'confirmed but its metadata could not be read');
    }

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
    const index = keys.staticAccountKeys.findIndex((k) => k.toBase58() === owner);
    if (index < 0) throw new UnconfirmedTrade(signature, 'the wallet is not in the account keys');

    /*
     * THE LAMPORT DELTA INCLUDES THE FEE AND ANY RENT for a token account that
     * did not exist before, and that is CORRECT for a cost basis: the position
     * cost what left the wallet, not what the swap leg alone was worth.
     */
    const solDelta = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0);

    const buying = inputMint === SOL_MINT;
    const tokenMint = buying ? outputMint : inputMint;
    const tokenDelta = this.tokenDelta(tx.meta, owner, tokenMint);

    return {
      signature,
      lamports: buying ? -solDelta : solDelta,
      tokens: buying ? tokenDelta : -tokenDelta,
    };
  }

  /** The owner's balance change in one mint, signed, from the token balances. */
  private tokenDelta(
    meta: { preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null },
    owner: string,
    mint: string
  ): bigint {
    const pick = (rows: TokenBalance[] | null | undefined): bigint => {
      const row = (rows ?? []).find((b) => b.owner === owner && b.mint === mint);
      return BigInt(row?.uiTokenAmount?.amount ?? '0');
    };
    return pick(meta.postTokenBalances) - pick(meta.preTokenBalances);
  }

  private async tokenBalance(owner: string, mint: string): Promise<bigint> {
    try {
      return await balanceOf(owner, mint);
    } catch (err) {
      this.log.debug({ owner, mint, err: errField(err) }, 'token balance read failed');
      return 0n;
    }
  }
}

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}
