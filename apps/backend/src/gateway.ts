import { closePrisma } from './clients/prisma.js';
import { loadConfig, env } from './config/load.js';
import { errField, logger } from './infra/logger.js';
import { createApp } from './api/app.js';
import { authEnabled } from './api/auth.js';
import { encryptionConfigured } from './trading/crypto.js';

/**
 * THE GATEWAY — the only process that answers HTTP.
 *
 * It reads and it never writes the index: the indexer, the scorer and the
 * trader own their tables, and keeping the request path out of that means a
 * traffic spike cannot slow down ingestion or delay an exit.
 *
 * IT REPORTS WHAT THIS DEPLOYMENT CANNOT DO, AT BOOT. A missing session secret
 * or master key is not a crash — the whole screener still serves — but an
 * operator should learn it from a startup line rather than from a user asking
 * why the Connect button does nothing.
 */
async function main(): Promise<void> {
  loadConfig();
  const app = createApp();

  if (!authEnabled()) {
    logger.warn('SESSION_SECRET is not set: sign-in is disabled and every account route answers 503.');
  }
  if (!encryptionConfigured()) {
    logger.warn(
      'WALLET_MASTER_KEY is not set: this deployment cannot hold trading wallets, so auto-trade is inert. Generate one with `openssl rand -hex 32`.'
    );
  }

  const server = app.listen(env.port, () => {
    logger.info({ port: env.port, cors: env.corsOrigins }, 'gateway listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // In-flight requests are allowed to finish: killing them would answer a
    // trade request with a socket reset, and the client cannot tell that from
    // a trade that failed.
    server.close(() => void closePrisma().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: errField(err) }, 'gateway failed to start');
  process.exit(1);
});
