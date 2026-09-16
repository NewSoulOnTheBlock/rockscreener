import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { TradingWallet as WalletRow } from '@prisma/client';
import { LAMPORTS_PER_SOL, type TradingWallet } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { rpc, PublicKey } from '../clients/solana.js';
import { env } from '../config/load.js';
import { AppError } from '../infra/errors.js';
import { errField, logger } from '../infra/logger.js';
import { balanceOf } from '../sources/mint-account.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Custodial wallets.
 *
 * ONE PLACE A PRIVATE KEY IS EVER MATERIALISED — `keypairFor` — and it is not
 * exported to anything but the executor. Everything else in the codebase works
 * with an address and a wallet id, which is what keeps the number of places a
 * key could leak to exactly one.
 *
 * THE KEY IS NEVER RETURNED BY AN ENDPOINT. `toView` below is the only shape a
 * wallet leaves this module in, and it has no key field to forget to strip.
 */

const log = logger.child({ module: 'wallets' });

export async function createWallet(userId: string, label?: string): Promise<TradingWallet> {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  // bs58 of the 64-byte secret key: the format every Solana wallet imports.
  const secret = bs58.encode(keypair.secretKey);

  const existing = await prisma.tradingWallet.count({ where: { userId } });

  const row = await prisma.tradingWallet.create({
    data: {
      userId,
      address,
      label: label ?? 'Engine wallet',
      encryptedKey: encryptSecret(secret),
      isDefault: existing === 0,
    },
  });

  log.info({ userId, address }, 'trading wallet created');
  return toView(row, '0', 0);
}

/**
 * The wallet the engine spends from.
 *
 * `walletId` on the settings row wins; the default wallet is the fallback. A
 * user who deleted the wallet their settings point at gets a clear refusal
 * rather than a silent switch to a different wallet — spending from a wallet
 * somebody did not choose is the worst possible recovery from this.
 */
export async function resolveWallet(userId: string, walletId: string | null): Promise<WalletRow> {
  const row = walletId
    ? await prisma.tradingWallet.findFirst({ where: { id: walletId, userId } })
    : await prisma.tradingWallet.findFirst({ where: { userId, isDefault: true } });

  if (!row) {
    throw AppError.badRequest('No trading wallet is selected, so nothing can be bought.');
  }
  return row;
}

/**
 * The keypair. THE ONLY FUNCTION IN THIS CODEBASE THAT PRODUCES ONE.
 *
 * Not cached. A cached keypair is a private key sitting in a long-lived map for
 * the lifetime of the process, reachable from a heap dump taken hours after the
 * trade it was needed for; decryption is a few microseconds and happens once
 * per fill.
 */
export function keypairFor(row: WalletRow): Keypair {
  const secret = decryptSecret(row.encryptedKey);
  return Keypair.fromSecretKey(bs58.decode(secret));
}

export async function listWallets(userId: string): Promise<TradingWallet[]> {
  const rows = await prisma.tradingWallet.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  return Promise.all(
    rows.map(async (row) => {
      let lamports = '0';
      let rock = 0;
      try {
        const [balance, rockRaw] = await Promise.all([
          rpc().getBalance(new PublicKey(row.address)),
          balanceOf(row.address, env.rockMint),
        ]);
        lamports = String(balance);
        // Six decimals as the fallback; see the note in gate.ts. A balance this
        // is only used to DISPLAY, never to unlock anything.
        rock = Number(rockRaw) / 10 ** 6;
      } catch (err) {
        // A balance that could not be read shows as zero on the page rather
        // than failing the whole wallet list.
        log.debug({ address: row.address, err: errField(err) }, 'balance read failed');
      }
      return toView(row, lamports, rock);
    })
  );
}

function toView(row: WalletRow, lamports: string, rockTokens: number): TradingWallet {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    solLamports: lamports,
    rockTokens,
    isDefault: row.isDefault,
    /*
     * FALSE, AND IT IS A REAL POLICY RATHER THAN A MISSING FEATURE.
     *
     * An export endpoint is a single request that turns the master key's entire
     * blast radius into a plaintext key in a browser's memory, a proxy log and
     * whatever the user pastes it into. The page says so plainly instead: fund
     * this wallet with what you intend the engine to risk and no more.
     */
    exportable: false,
    createdAt: row.createdAt.toISOString(),
  };
}

export { LAMPORTS_PER_SOL };
