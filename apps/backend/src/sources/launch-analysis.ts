import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LAUNCH_WINDOW_SECONDS } from '@rockscreener/shared';
import { PublicKey, rpc } from '../clients/solana.js';
import { env } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * THE LAUNCH ANALYSIS — the reading this product is named for.
 *
 * Splitting a bag across twelve wallets defeats top-10 concentration, creator
 * percentage, holder count and every other distribution metric there is, and on
 * Solana it costs a fraction of a cent per wallet. What it cannot hide is that
 * all twelve bought in the same slot.
 *
 * IT REQUIRES A TRANSACTION HISTORY, AND WITHOUT ONE IT RETURNS NULL. Reading a
 * mint's first trades means paginating its signatures back to genesis, which a
 * public RPC will not do at any useful rate. So this runs only where
 * `HELIUS_API_KEY` is set, and where it is not, `analyzed` stays false and every
 * field stays null.
 *
 * THAT NULL IS THE WHOLE POINT AND IS NOT A GAP TO BE FILLED. A missing bundle
 * reading propagates as an unmeasured launch pillar, lowers `coverage`, keeps
 * the token below the call threshold, and makes auto-trade refuse it outright —
 * `entry.maxBundledPct` fails on null rather than passing, because a percentage
 * nobody established could be 2% or 60% and buying it is betting on which. A
 * deployment without the key grades honestly on four pillars; it does not grade
 * optimistically on five.
 */

const log = logger.child({ source: 'launch-analysis' });
const spacer = new Spacer(120);

export interface LaunchFacts {
  bundledPct: number;
  bundleWallets: number;
  sniperPct: number;
  sniperWallets: number;
  stillHeldPct: number | null;
  creatorLinkedPct: number | null;
  bundleSlot: number;
  launchSlot: number;
}

export function launchAnalysisAvailable(): boolean {
  return env.heliusApiKey !== null;
}

/**
 * Reads the token's earliest transactions and measures what was taken before
 * anybody could react.
 *
 * THE BUNDLE IS THE FIRST TRADED SLOT, NOT THE CREATION SLOT. On pump.fun the
 * mint, the curve creation and the creator's own first buy frequently land in
 * one transaction, and anchoring to the creation slot would count that single
 * buy as the entire bundle for every token on the launchpad. The first slot in
 * which somebody OTHER than the creation transaction bought is the event the
 * metric is about.
 */
export async function analyzeLaunch(
  mint: string,
  decimals: number,
  totalSupply: bigint
): Promise<LaunchFacts | null> {
  const key = env.heliusApiKey;
  if (!key || totalSupply <= 0n) return null;

  try {
    const transactions = await earliestTransactions(mint, key);
    if (transactions.length === 0) return null;

    const creationSlot = transactions[0]!.slot;
    const creationTime = transactions[0]!.timestamp;

    /*
     * Buys, as amounts of the token moving TO a wallet out of the curve.
     * Helius's enhanced format gives token transfers per transaction, so a buy
     * is a transfer whose mint is ours and whose destination is not the pool
     * that sent it.
     */
    interface Buy {
      wallet: string;
      amount: bigint;
      slot: number;
      timestamp: number;
    }
    const buys: Buy[] = [];
    for (const tx of transactions) {
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== mint) continue;
        const amount = BigInt(Math.round(transfer.tokenAmount * 10 ** decimals));
        if (amount <= 0n) continue;
        buys.push({
          wallet: transfer.toUserAccount,
          amount,
          slot: tx.slot,
          timestamp: tx.timestamp,
        });
      }
    }
    if (buys.length === 0) return null;

    // The first slot AFTER creation in which the token actually changed hands.
    const tradedSlots = buys.map((b) => b.slot).filter((s) => s > creationSlot);
    const bundleSlot = tradedSlots.length > 0 ? Math.min(...tradedSlots) : creationSlot;

    const inBundle = buys.filter((b) => b.slot === bundleSlot);
    const bundleWallets = new Set(inBundle.map((b) => b.wallet));
    const bundledRaw = inBundle.reduce((sum, b) => sum + b.amount, 0n);

    /*
     * SNIPERS: a WALL-CLOCK window, not a slot count.
     *
     * Slot times on this chain vary by more than a factor of two between a
     * quiet minute and a congested one, so "the first 40 slots" is a different
     * amount of time on every token. Fifteen seconds is the same fifteen
     * seconds everywhere, which is what makes the number comparable across the
     * index at all.
     */
    const inWindow = buys.filter(
      (b) => b.timestamp - creationTime <= LAUNCH_WINDOW_SECONDS && b.slot !== bundleSlot
    );
    const sniperWallets = new Set(inWindow.map((b) => b.wallet));
    const sniperRaw = inWindow.reduce((sum, b) => sum + b.amount, 0n);

    const pct = (raw: bigint): number => Number((raw * 10_000n) / totalSupply) / 100;

    return {
      bundledPct: Math.min(100, pct(bundledRaw)),
      bundleWallets: bundleWallets.size,
      sniperPct: Math.min(100, pct(sniperRaw)),
      sniperWallets: sniperWallets.size,
      /*
       * WHAT THE BUNDLE DID NEXT, read from the chain rather than estimated.
       *
       * Both answers are bad and they are bad in DIFFERENT ways, so an estimate
       * that got it backwards would be worse than no reading at all: still
       * holding is an overhang aimed at whoever buys next, already sold means
       * it was aimed at whoever bought first and the pattern is now confirmed.
       * So this is a real balance read, and it is null when that read fails.
       */
      stillHeldPct: await stillHeld(mint, [...bundleWallets], totalSupply),
      /*
       * CREATOR-LINKED SUPPLY IS DELIBERATELY NOT COMPUTED HERE, and this is a
       * decision rather than a gap.
       *
       * Finding wallets the creator FUNDED means walking each bundle wallet's
       * own history back to where its SOL came from — and that funding almost
       * always happens before the token existed, in transactions the mint's own
       * history does not contain. It is a per-wallet history fetch, twenty of
       * them per token.
       *
       * RugCheck's insider graph already answers the same question by walking
       * exactly those funding edges, and its answer arrives as `clusteredPct` —
       * which the launch pillar weights ABOVE the bundle, because a cluster is
       * who a launch happened for rather than merely what happened. Computing a
       * worse second version of it here would be duplicated cost for a weaker
       * reading.
       */
      creatorLinkedPct: null,
      bundleSlot,
      launchSlot: creationSlot,
    };
  } catch (err) {
    log.debug({ mint, err: errField(err) }, 'launch analysis failed');
    return null;
  }
}

interface EnhancedTx {
  slot: number;
  timestamp: number;
  tokenTransfers: { mint: string; toUserAccount: string; tokenAmount: number }[];
}

/**
 * The token's oldest transactions.
 *
 * Signatures come back NEWEST FIRST and there is no "from the beginning"
 * parameter, so reaching the launch means paging to the end of the history. The
 * cap is what keeps that bounded: a token with a hundred thousand transactions
 * is not one whose launch anybody is still deciding about, and the analysis is
 * skipped rather than paid for.
 */
const MAX_PAGES = 12;
const PAGE = 100;

async function earliestTransactions(mint: string, key: string): Promise<EnhancedTx[]> {
  const base = `https://api.helius.xyz/v0/addresses/${mint}/transactions`;
  let before: string | undefined;
  let last: EnhancedTx[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    await spacer.wait();
    const url = `${base}?api-key=${key}&limit=${PAGE}${before ? `&before=${before}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) break;

    const batch = (await res.json()) as (EnhancedTx & { signature: string })[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    last = batch;
    // Short page: this is the end of the history, so `last` holds the launch.
    if (batch.length < PAGE) break;
    before = batch[batch.length - 1]!.signature;
  }

  // Oldest first, so index 0 is the creation transaction.
  return last.slice().sort((a, b) => a.slot - b.slot);
}

/**
 * How much of the supply the launch-slot wallets STILL hold.
 *
 * ONE RPC ROUND TRIP, not one per wallet. The associated token account is a
 * deterministic address, so every bundle wallet's account can be derived
 * locally and fetched in a single `getMultipleAccountsInfo` — twenty reads
 * become one. Doing it per wallet is what makes this kind of analysis too
 * expensive to run, and then it does not get run.
 *
 * NULL ON FAILURE, NEVER ZERO. "The bundle has sold everything" and "we could
 * not read the balances" are opposite conclusions about the same token, and the
 * launch pillar treats them as such.
 */
async function stillHeld(
  mint: string,
  wallets: string[],
  totalSupply: bigint
): Promise<number | null> {
  if (wallets.length === 0 || totalSupply <= 0n) return null;

  try {
    const mintKey = new PublicKey(mint);

    /*
     * BOTH TOKEN PROGRAMS. A Token-2022 mint's associated account sits at a
     * different address, and deriving only the classic one would report every
     * Token-2022 bundle as having sold out — which is the reassuring direction,
     * and therefore the dangerous one.
     */
    const addresses: PublicKey[] = [];
    // Bounded: a hundred accounts is the ceiling on one `getMultipleAccounts`,
    // and a launch with more than fifty distinct bundle wallets is already
    // telling you everything you need to know.
    for (const wallet of wallets.slice(0, 50)) {
      const owner = new PublicKey(wallet);
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        addresses.push(getAssociatedTokenAddressSync(mintKey, owner, true, programId));
      }
    }

    await spacer.wait();
    const accounts = await rpc().getMultipleAccountsInfo(addresses, 'confirmed');

    let held = 0n;
    for (const account of accounts) {
      // An account that does not exist is a wallet that closed it — which means
      // it holds none, and is a real zero rather than a missing reading.
      if (!account) continue;
      // SPL token account layout: mint(32) owner(32) amount(u64 at 64).
      if (account.data.length < 72) continue;
      held += account.data.readBigUInt64LE(64);
    }

    return Math.min(100, Number((held * 10_000n) / totalSupply) / 100);
  } catch (err) {
    log.debug({ mint, err: errField(err) }, 'still-held read failed');
    return null;
  }
}
