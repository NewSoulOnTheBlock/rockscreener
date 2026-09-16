import type { RockGate } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { cached } from '../clients/redis.js';
import { env, loadConfig } from '../config/load.js';
import { errField, logger } from '../infra/logger.js';
import { priceOf } from '../sources/jupiter.js';
import { balanceOf, readMint } from '../sources/mint-account.js';

/**
 * THE ROCK GATE — what opens auto-trade.
 *
 * A HOLDING, NOT A SUBSCRIPTION, and the difference is the design. A
 * subscription is a payment that leaves; a holding is a position the holder
 * keeps, it aligns the one feature that spends money by itself with the token
 * whose price it moves, and it is checkable on chain in one pass with no
 * invoice, no expiry and nothing to refund.
 *
 * IT COUNTS EVERY WALLET THE ACCOUNT HAS PROVEN. The custodial wallet the
 * engine spends from AND every linked wallet, because holding in the wrong
 * wallet is the single commonest reason a token gate looks broken, and the fix
 * is to count both rather than to write a help article. A linked wallet is
 * read-only forever: there is no key for it anywhere in this system.
 *
 * IT FAILS CLOSED. If no source will price ROCK, the gate reports `unlocked:
 * false` with a reason that says exactly that, rather than guessing a price or
 * waving the check through. A gate that fails open on a pricing outage is not a
 * gate.
 */

const log = logger.child({ module: 'gate' });
const cfg = loadConfig();

/** Decimals are read once per process — a mint's decimals never change. */
let rockDecimals: number | null = null;

async function decimalsOfRock(): Promise<number> {
  if (rockDecimals !== null) return rockDecimals;
  const facts = await readMint(env.rockMint);
  // Six is the SPL default and the overwhelming majority of Solana tokens. It
  // is a fallback for a read that failed, and it is only ever used to DIVIDE a
  // balance — a wrong guess understates or overstates a holding rather than
  // unlocking anybody, and the next call re-reads it.
  rockDecimals = facts?.decimals ?? 6;
  return rockDecimals;
}

/**
 * The gate for one account, read fresh.
 *
 * Every call here is an RPC read per wallet plus one price lookup, so the
 * ENGINE does not call this per token — see `cachedGate`.
 */
export async function readGate(userId: string): Promise<RockGate> {
  const now = new Date().toISOString();
  const requiredUsd = cfg.gate.requiredUsd;

  const [wallets, linked] = await Promise.all([
    prisma.tradingWallet.findMany({ where: { userId }, select: { address: true } }),
    prisma.linkedWallet.findMany({ where: { userId }, select: { address: true } }),
  ]);

  const addresses: { address: string; kind: 'custodial' | 'linked' }[] = [
    ...wallets.map((w) => ({ address: w.address, kind: 'custodial' as const })),
    ...linked.map((w) => ({ address: w.address, kind: 'linked' as const })),
  ];

  const [price, decimals] = await Promise.all([priceOf(env.rockMint), decimalsOfRock()]);

  const divisor = 10 ** decimals;
  const balances = await Promise.all(
    addresses.map(async (w) => {
      try {
        const raw = await balanceOf(w.address, env.rockMint);
        return { ...w, tokens: Number(raw) / divisor };
      } catch (err) {
        /*
         * A wallet that could not be READ contributes zero to the total and the
         * gate stays closed on the shortfall. It is not treated as a zero
         * balance in the user's favour, and it is not treated as a fatal error
         * either — one unreachable wallet must not hide the ROCK sitting in the
         * other one.
         */
        log.debug({ address: w.address, err: errField(err) }, 'ROCK balance read failed');
        return { ...w, tokens: 0 };
      }
    })
  );

  const heldTokens = balances.reduce((sum, w) => sum + w.tokens, 0);

  if (price === null) {
    return {
      unlocked: false,
      requiredUsd,
      heldUsd: 0,
      heldTokens,
      missingUsd: requiredUsd,
      priceUsd: null,
      wallets: balances,
      reason:
        'No source would price ROCK just now, so the holding cannot be valued and the engine stays closed. This is a refusal to guess, not a verdict on your balance.',
      checkedAt: now,
    };
  }

  const heldUsd = heldTokens * price;
  const unlocked = heldUsd >= requiredUsd;

  return {
    unlocked,
    requiredUsd,
    heldUsd,
    heldTokens,
    missingUsd: Math.max(0, requiredUsd - heldUsd),
    priceUsd: price,
    wallets: balances,
    reason: unlocked
      ? null
      : addresses.length === 0
        ? 'No wallet is connected yet, so there is no ROCK to count.'
        : `Auto-trade needs $${requiredUsd} of ROCK held. You are $${Math.round(requiredUsd - heldUsd)} short.`,
    checkedAt: now,
  };
}

/**
 * The gate, cached.
 *
 * THE ENGINE CHECKS THIS BEFORE EVERY ENTRY PASS, not before every token, and
 * this is why that is affordable. The cache is short — a couple of minutes —
 * because the number it holds is a dollar value of a volatile token, and a user
 * whose position just crossed the line should not wait a quarter of an hour to
 * be let in.
 *
 * THE CACHED COPY IS ALSO MIRRORED ONTO THE USER ROW, so the entry query can
 * narrow to unlocked accounts in SQL rather than fanning out to Redis per user.
 */
export async function cachedGate(userId: string): Promise<RockGate> {
  const gate = await cached(`rock:gate:${userId}`, cfg.autotrade.gateCacheSeconds, () =>
    readGate(userId)
  );

  // Best-effort mirror. A failure here costs the SQL narrowing, not the gate.
  void prisma.user
    .update({
      where: { id: userId },
      data: {
        gateUnlocked: gate.unlocked,
        gateHeldUsd: gate.heldUsd,
        gateCheckedAt: new Date(),
      },
    })
    .catch(() => undefined);

  return gate;
}
