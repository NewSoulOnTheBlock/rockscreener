import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROCK_MINT } from '@rockscreener/shared';
import { ConfigSchema, type Config } from './schema.js';

/**
 * Config and environment, resolved once.
 *
 * THE SPLIT IS DELIBERATE. `configuration.json` holds every number a human
 * would want to argue about — thresholds, rates, ceilings — and is committed,
 * reviewable and diffable. The ENVIRONMENT holds only secrets and addresses.
 * Nothing that is a credential appears in the file, and nothing that is a
 * tuning decision appears in the environment, where it would be invisible to
 * everyone except whoever last deployed.
 */

const here = dirname(fileURLToPath(import.meta.url));

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  // dist/config/load.js -> dist/.. -> the package root, where the file is copied.
  const path = join(here, '..', '..', 'configuration.json');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Refuse to start. See the note on ConfigSchema for why this is not a warn.
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`configuration.json is invalid:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Everything that comes from the environment, named once. */
export const env = {
  get databaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set.');
    return url;
  },
  get redisUrl(): string | null {
    return process.env.REDIS_URL ?? null;
  },
  get port(): number {
    return Number(process.env.PORT ?? 4040);
  },
  get corsOrigins(): string[] {
    return (process.env.CORS_ORIGINS ?? 'http://localhost:3040')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  },

  /**
   * The RPC the indexer reads from, and the one the trader sends through.
   *
   * TWO ENDPOINTS, ON PURPOSE. Reading holder tables and mint accounts is
   * bulk work that will happily eat a rate limit; sending a swap is one
   * request that must not be queued behind four hundred of them. A deployment
   * with one endpoint sets both to the same value and accepts that.
   */
  get rpcUrl(): string {
    return process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  },
  get tradeRpcUrl(): string {
    return process.env.SOLANA_TRADE_RPC_URL ?? env.rpcUrl;
  },
  get heliusApiKey(): string | null {
    return process.env.HELIUS_API_KEY ?? null;
  },
  get jupiterApiKey(): string | null {
    return process.env.JUPITER_API_KEY ?? null;
  },

  /** The platform token. Overridable so staging can point at a test mint. */
  get rockMint(): string {
    return process.env.ROCK_MINT ?? ROCK_MINT;
  },

  get sessionSecret(): string {
    return process.env.SESSION_SECRET ?? '';
  },
  get telegramBotToken(): string | null {
    return process.env.TELEGRAM_LOGIN_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
  },
  /**
   * AES-256-GCM key for custodial wallets, hex, 32 bytes.
   *
   * It lives ONLY here. It is never written to the database, never logged and
   * never returned by any endpoint. Losing it loses every custodial wallet and
   * there is no recovery path, because a recoverable master key is simply a
   * second copy of it.
   */
  get walletMasterKey(): string | null {
    return process.env.WALLET_MASTER_KEY ?? null;
  },
  /** Fee taken on engine and manual fills, basis points. Zero disables it. */
  get feeBps(): number {
    return Number(process.env.PLATFORM_FEE_BPS ?? 0);
  },
  get feeWallet(): string | null {
    return process.env.PLATFORM_FEE_WALLET ?? null;
  },
  get logLevel(): string {
    return process.env.LOG_LEVEL ?? 'info';
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
};
