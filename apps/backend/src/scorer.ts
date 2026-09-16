import { closePrisma } from './clients/prisma.js';
import { loadConfig } from './config/load.js';
import { errField, logger } from './infra/logger.js';
import { CallsEngine } from './calls/engine.js';
import { Scorer } from './score/worker.js';
import { SellChecker } from './score/sell-check.js';

/**
 * THE SCORER — the grade, the sell check, and the calls.
 *
 * THESE THREE BELONG TOGETHER BECAUSE THEY ARE ONE PIPELINE. The sell check
 * writes a fact, the scorer turns facts into a grade, and the calls engine
 * turns a grade at a moment into a claim. Splitting them across processes would
 * add two scheduling delays to the path between "this token became sellable"
 * and "we said to buy it", which is the path the whole product is timed on.
 *
 * MULTIPLE REPLICAS ARE SAFE HERE. Everything is an idempotent upsert keyed by
 * mint, and the calls engine's one-per-token-per-tier rule is a unique index
 * rather than a read-then-write — so two scorers racing the same token produce
 * the same row, not two.
 */
async function main(): Promise<void> {
  loadConfig();

  const workers = [new SellChecker(), new Scorer(), new CallsEngine()];
  for (const worker of workers) worker.start();
  logger.info('scorer started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'stopping scorer');
    for (const worker of workers) worker.stop();
    await closePrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: errField(err) }, 'scorer failed to start');
  process.exit(1);
});
