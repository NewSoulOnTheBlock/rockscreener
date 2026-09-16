import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { logger, type Logger } from '../infra/logger.js';

/**
 * RETENTION — the pass that keeps the index from becoming a landfill.
 *
 * TOKENS ARE DEMOTED, NOT DELETED. A token that stopped trading three days ago
 * becomes DORMANT: it keeps its row, its final numbers and its grade, and it
 * drops out of every expensive loop. Deleting it would break the creator
 * history — which is built entirely from our own rows and is the single most
 * predictive reading available — and it would let the same dead mint be
 * rediscovered and re-indexed from scratch tomorrow.
 *
 * SCORE HISTORY IS TRIMMED because it is the one table that grows without
 * bound. Calls are never trimmed: the record is the product, and a record that
 * quietly forgets its oldest calls is a record that improves with age.
 */
export class Retention {
  private readonly task: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig();

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'retention' });
    this.task = new IntervalTask('retention', 15 * 60_000, () => this.tick(), this.log);
  }

  start(): void {
    this.task.start(false);
  }
  stop(): void {
    this.task.stop();
  }

  private async tick(): Promise<void> {
    const cutoff = new Date(Date.now() - this.cfg.ingestion.dormantAfterHours * 3_600_000);

    const demoted = await prisma.token.updateMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        lastActivityAt: { lt: cutoff },
        /*
         * A TOKEN WITH A LIVE CALL ON IT IS NEVER DEMOTED, whatever its volume
         * looks like. The call tracker needs its price to keep moving, and a
         * demoted token stops being synced — which would freeze the call's
         * multiple at whatever it was when the market went quiet and quietly
         * corrupt the record.
         */
        calls: { none: { outcome: 'live' } },
      },
      data: { tier: 'DORMANT' },
    });

    const historyCutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
    const trimmed = await prisma.scoreHistory.deleteMany({ where: { at: { lt: historyCutoff } } });

    // Events are a debugging surface with a very long tail and no downstream
    // consumer past a few days.
    const eventCutoff = new Date(Date.now() - 14 * 24 * 3_600_000);
    const events = await prisma.autoEvent.deleteMany({ where: { at: { lt: eventCutoff } } });

    if (demoted.count || trimmed.count || events.count) {
      this.log.info(
        { demoted: demoted.count, history: trimmed.count, events: events.count },
        'retention pass'
      );
    }
  }
}
