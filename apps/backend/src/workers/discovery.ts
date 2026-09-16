import { prisma } from '../clients/prisma.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { fetchLatestProfiles } from '../sources/dexscreener.js';
import { PumpPortal, type Discovered } from '../sources/pumpportal.js';
import { normalizeUri } from '../sources/token-metadata.js';

/**
 * DISCOVERY — getting mints into the table, as cheaply as possible.
 *
 * A NEW MINT IS A SEEDED ROW AND NOTHING ELSE. No security read, no holder
 * sync, no grade. Tens of thousands of mints are created a day and the
 * overwhelming majority never trade twice; running the full pipeline on all of
 * them is precisely what makes an indexer fall over, and publishing a grade for
 * them is what made the product this replaces meaningless.
 *
 * A MIGRATION IS PROMOTED IMMEDIATELY. A token that graduated has ~85 SOL of
 * demand behind it, a real pool instead of a curve, and every reading the grade
 * depends on becomes available at once. That is the event worth spending on.
 */
export class Discovery {
  private readonly stream = new PumpPortal();
  private readonly profileTask: IntervalTask;
  private readonly log: Logger;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'discovery' });
    /*
     * The profile poll is a SECOND, INDEPENDENT source, and it exists because
     * the socket is not a guarantee. It also catches tokens that were launched
     * before this deployment existed, which a live stream by definition never
     * will.
     */
    this.profileTask = new IntervalTask('discovery-profiles', 60_000, () => this.pollProfiles(), this.log);
  }

  start(): void {
    this.stream.on('token', (t: Discovered) => {
      void this.ingest(t).catch((err) =>
        this.log.debug({ mint: t.mint, err: errField(err) }, 'ingest failed')
      );
    });
    this.stream.start();
    this.profileTask.start(false);
  }

  stop(): void {
    this.stream.stop();
    this.profileTask.stop();
  }

  private async ingest(t: Discovered): Promise<void> {
    const graduated = t.kind === 'migration';

    await prisma.token.upsert({
      where: { mint: t.mint },
      create: {
        mint: t.mint,
        name: t.name ?? '',
        symbol: t.symbol ?? '',
        nameState: t.symbol ? 'named' : 'pending',
        creator: t.creator,
        launchpad: t.launchpad,
        // Taken from the stream so the picture can be fetched immediately,
        // without the metadata worker first paying for an account read.
        ...(t.uri ? { metadataUri: normalizeUri(t.uri) } : {}),
        launchTime: new Date(),
        tier: graduated ? 'ACTIVE' : 'SEEDED',
        status: graduated ? 'MIGRATED' : 'BONDING',
        ...(graduated ? { migratedAt: new Date(), poolAddress: t.poolAddress } : {}),
      },
      update: graduated
        ? {
            /*
             * A MIGRATION IS THE ONLY DISCOVERY EVENT THAT UPGRADES AN EXISTING
             * ROW. A repeated `newToken` for a mint we already carry must not
             * reset its tier — that would demote a token the activation pass
             * has already promoted, back to SEEDED, and stop it being graded.
             */
            status: 'MIGRATED',
            migratedAt: new Date(),
            progressBps: 0,
            tier: 'ACTIVE',
            ...(t.poolAddress ? { poolAddress: t.poolAddress } : {}),
          }
        : {},
    });
  }

  private async pollProfiles(): Promise<void> {
    const mints = await fetchLatestProfiles();
    for (const mint of mints.slice(0, 30)) {
      try {
        await prisma.token.upsert({
          where: { mint },
          create: {
            mint,
            launchTime: new Date(),
            tier: 'SEEDED',
            status: 'MIGRATED',
            launchpad: 'unknown',
          },
          // Seen already. Nothing here is newer than what the market sync has.
          update: {},
        });
      } catch (err) {
        this.log.debug({ mint, err: errField(err) }, 'profile upsert failed');
      }
    }
  }
}
