import { closePrisma } from './clients/prisma.js';
import { acquireLock, releaseLock, renewLock } from './clients/redis.js';
import { sleep } from './infra/interval.js';
import { loadConfig } from './config/load.js';
import { errField, logger } from './infra/logger.js';
import { AutoTradeEngine } from './autotrade/engine.js';
import { encryptionConfigured } from './trading/crypto.js';

/**
 * THE TRADER — and there must be EXACTLY ONE of it.
 *
 * It holds custodial keys and broadcasts transactions. Two replicas would race
 * to sell the same position: the first sale succeeds, the second fails against
 * a balance that is already gone, and the position row ends up describing
 * neither. The lock below is what enforces that — and where there is no Redis,
 * a single-process deployment IS the single writer, so it starts.
 *
 * THERE IS NO LEADER ELECTION and adding one would misrepresent what this
 * process is. It is not a horizontally scalable service; it is one hand on one
 * set of keys.
 *
 * IT REFUSES TO START WITHOUT A MASTER KEY, cleanly and with one line saying
 * why. Starting an engine that cannot decrypt the wallet it is meant to spend
 * from would mean discovering the misconfiguration at the moment of the first
 * fill.
 */
const LOCK_KEY = 'rock:trader:leader';
const LOCK_TTL_MS = 30_000;

async function main(): Promise<void> {
  loadConfig();

  if (!encryptionConfigured()) {
    logger.error(
      'WALLET_MASTER_KEY is not set, so no trading wallet can be decrypted and nothing can be traded. Generate one with `openssl rand -hex 32`. Exiting.'
    );
    process.exit(0);
  }

  /*
   * WAITING OUT A PREDECESSOR IS NOT THE SAME AS LOSING TO A RIVAL.
   *
   * On a restart the outgoing process's lock is still held until its TTL
   * lapses, so a trader that exited immediately would be restarted by its
   * supervisor, exit again, and crash-loop for the whole window — which under
   * `restart: unless-stopped` looks exactly like a broken deployment.
   *
   * So it waits slightly longer than one full TTL before concluding that the
   * holder is a genuinely live rival rather than a corpse. Exceeding that, it
   * exits QUIETLY with status 0: a second trader is a configuration mistake,
   * not a crash, and it must not be restarted into a fight over the same keys.
   */
  const deadline = Date.now() + LOCK_TTL_MS + 5_000;
  let held = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!held) {
    logger.warn('another trader holds the lock — waiting for it to lapse before giving up');
    while (!held && Date.now() < deadline) {
      await sleep(2_000);
      held = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
    }
  }
  if (!held) {
    logger.error(
      'Another trader process is alive and holding the lock. Exactly one may run — see the note at the top of trader.ts. Exiting.'
    );
    process.exit(0);
  }

  // Renewed at a third of the TTL: a process that pauses long enough to lose
  // the lock has also paused long enough that it should not be trading.
  const renewal = setInterval(() => void renewLock(LOCK_KEY, LOCK_TTL_MS), LOCK_TTL_MS / 3);

  const engine = new AutoTradeEngine();
  engine.start();
  logger.info('trader started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'stopping trader');
    clearInterval(renewal);
    engine.stop();
    /*
     * THE LOCK IS RELEASED ON THE WAY OUT, so a replacement starts immediately
     * rather than waiting out a TTL for a process that is already gone. The
     * timeout above is the backstop for the case this path never runs — a kill
     * -9, an OOM — which is precisely when a TTL is the only thing that can
     * free it.
     */
    await releaseLock(LOCK_KEY);
    await closePrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: errField(err) }, 'trader failed to start');
  process.exit(1);
});
