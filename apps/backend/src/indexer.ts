import { closePrisma } from './clients/prisma.js';
import { loadConfig } from './config/load.js';
import { errField, logger } from './infra/logger.js';
import { Discovery } from './workers/discovery.js';
import { CurveSync } from './workers/curve-sync.js';
import { MarketSync } from './workers/market-sync.js';
import { MetadataSync } from './workers/metadata-sync.js';
import { SecuritySync } from './workers/security-sync.js';
import { TraderCount } from './workers/trader-count.js';
import { Retention } from './workers/retention.js';

/**
 * THE INDEXER — everything that writes facts about tokens.
 *
 * SEVEN WORKERS ON SEVEN CLOCKS, in one process on purpose. They all contend for
 * the same external rate limits, and splitting them across processes would mean
 * four independent spacers cheerfully issuing four times the requests a single
 * ceiling allows. Sharing a process is what makes the rate limiting real.
 *
 * NONE OF THEM GRADE ANYTHING. Scoring is a separate process reading the same
 * rows, so a slow source cannot delay a grade and a slow grade cannot delay
 * ingestion.
 */
async function main(): Promise<void> {
  loadConfig();

  const workers = [
    new Discovery(),
    new MarketSync(),
    new MetadataSync(),
    new CurveSync(),
    new SecuritySync(),
    new TraderCount(),
    new Retention(),
  ];
  for (const worker of workers) worker.start();
  logger.info('indexer started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'stopping indexer');
    for (const worker of workers) worker.stop();
    await closePrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: errField(err) }, 'indexer failed to start');
  process.exit(1);
});
