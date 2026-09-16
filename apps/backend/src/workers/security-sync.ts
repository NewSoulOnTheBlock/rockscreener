import type { Prisma } from '@prisma/client';
import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { fetchReport } from '../sources/rugcheck.js';
import { readMintBatch } from '../sources/mint-account.js';
import { analyzeLaunch, launchAnalysisAvailable } from '../sources/launch-analysis.js';

/**
 * THE SECURITY PASS — everything the grade needs that a price feed cannot give.
 *
 * THREE READS, AT THREE DIFFERENT COSTS, ON THREE DIFFERENT CLOCKS.
 *
 *   the mint account   one RPC call, and it answers the two questions that can
 *                      take a whole position: can more supply be printed, and
 *                      can your account be frozen. Cheap enough to do for
 *                      everything active, and the AUTHORITY where it and a
 *                      third-party report disagree.
 *
 *   the RugCheck report  the holder table with pools already labelled, the LP
 *                      lock, and the insider graph — the funding-cluster
 *                      reading that is the Solana form of the thing this
 *                      product exists to measure. Metered, so it is a trickle.
 *
 *   the launch analysis  paginating a mint's history back to its first trade.
 *                      Expensive, optional, and where it is unavailable the
 *                      readings stay NULL rather than being guessed.
 *
 * NOTHING HERE WRITES A DEFAULT. Every field is written only when the read that
 * produces it succeeded, so a source being down lowers `coverage` instead of
 * quietly filling the grade with zeros.
 */
export class SecuritySync {
  private readonly mintTask: IntervalTask;
  private readonly reportTask: IntervalTask;
  private readonly launchTask: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig();

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'security-sync' });
    this.mintTask = new IntervalTask('mint-read', 2_000, () => this.readMints(), this.log);
    this.reportTask = new IntervalTask('rugcheck', 3_000, () => this.readReports(), this.log);
    this.launchTask = new IntervalTask('launch-analysis', 8_000, () => this.readLaunches(), this.log);
  }

  start(): void {
    this.mintTask.start(true);
    this.reportTask.start(false);
    if (launchAnalysisAvailable()) {
      this.launchTask.start(false);
    } else {
      /*
       * SAID OUT LOUD AT BOOT. A deployment without the key grades honestly on
       * four pillars — every token's launch reading stays null, coverage drops,
       * calls do not fire on unanalysed launches and auto-trade refuses them.
       * That is the designed behaviour, but an operator should know they are in
       * it rather than wonder why nothing is ever called.
       */
      this.log.warn(
        'HELIUS_API_KEY is not set: first-slot bundle analysis is unavailable. Launch readings will stay null, which lowers coverage and blocks calls on tokens whose launch was never analysed. The RugCheck insider graph still provides the funding-cluster reading.'
      );
    }
  }

  stop(): void {
    this.mintTask.stop();
    this.reportTask.stop();
    this.launchTask.stop();
  }

  /** The cheap read, for anything active that has never had one. */
  private async readMints(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { tier: { in: ['ACTIVE', 'GRADUATED'] }, mintReadAt: null },
      orderBy: { lastActivityAt: 'desc' },
      select: { mint: true },
      // One `getMultipleAccounts` either way — see `readMintBatch`.
      take: 100,
    });

    const batch = await readMintBatch(tokens.map((t) => t.mint));

    for (const { mint } of tokens) {
      try {
        const facts = batch.get(mint) ?? null;
        // A mint that could not be read is NOT marked as read. The next pass
        // tries again, and until then the safety pillar is short one input
        // rather than carrying a fabricated one.
        if (!facts) continue;

        await prisma.token.update({
          where: { mint },
          data: {
            decimals: facts.decimals,
            totalSupply: facts.supply,
            mintAuthorityRevoked: facts.mintAuthorityRevoked,
            freezeAuthorityRevoked: facts.freezeAuthorityRevoked,
            transferFeeBps: facts.transferFeeBps,
            mintReadAt: new Date(),
          },
        });
      } catch (err) {
        this.log.debug({ mint, err: errField(err) }, 'mint read failed');
      }
    }
  }

  private async readReports(): Promise<void> {
    const stale = new Date(Date.now() - this.cfg.sources.rugcheck.cacheMinutes * 60_000);

    const tokens = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        OR: [{ securityReadAt: null }, { securityReadAt: { lt: stale } }],
      },
      orderBy: [{ securityReadAt: { sort: 'asc', nulls: 'first' } }],
      select: { mint: true, imageUrl: true, launchpad: true },
      take: 4,
    });

    for (const token of tokens) {
      try {
        const report = await fetchReport(token.mint);
        // RugCheck has never indexed this mint — the ordinary answer for
        // something minutes old. Nothing is written, so the distribution pillar
        // stays unmeasured rather than becoming a guess.
        if (!report) continue;

        const data: Prisma.TokenUpdateInput = {
          rugcheckScore: report.rugcheckScore,
          top10Pct: report.top10Pct,
          creatorPct: report.creatorPct,
          holderCount: report.holderCount,
          holders: report.holders as unknown as Prisma.InputJsonValue,
          lpLockedPct: report.lpLockedPct,
          lpLockedUsd: report.lpLockedUsd,
          marketCount: report.marketCount,
          clusteredPct: report.insiderPct,
          clusters: report.insiderNetworks,
          rugged: report.rugged,
          risks: report.risks as unknown as Prisma.InputJsonValue,
          securityReadAt: new Date(),
          /*
           * THE MINT ACCOUNT READ WINS WHERE BOTH EXIST. These are only written
           * when the column is still null, so a direct chain read is never
           * overwritten by a third party's view of the same fact.
           */
          ...(report.metadataMutable !== null ? { metadataMutable: report.metadataMutable } : {}),
          ...(report.launchpad && token.launchpad === 'unknown'
            ? { launchpad: normalizeLaunchpad(report.launchpad) }
            : {}),
          ...(report.imageUrl && !token.imageUrl ? { imageUrl: report.imageUrl } : {}),
        };

        await prisma.token.update({ where: { mint: token.mint }, data });
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'security read failed');
      }
    }
  }

  /**
   * The launch analysis, for tokens that matter and have never had one.
   *
   * ORDERED BY LIQUIDITY rather than by age. This is the most expensive read in
   * the system and its whole purpose is to decide whether a token is worth
   * buying — so it is spent on the tokens somebody might actually buy, not on
   * the long tail of mints that will never clear a call threshold anyway.
   */
  private async readLaunches(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        launchAnalyzed: false,
        totalSupply: { not: null },
        liquidityUsd: { gte: this.cfg.calls.minLiquidityUsd },
      },
      orderBy: { liquidityUsd: 'desc' },
      select: { mint: true, decimals: true, totalSupply: true },
      take: 2,
    });

    for (const token of tokens) {
      try {
        const facts = await analyzeLaunch(
          token.mint,
          token.decimals,
          BigInt(token.totalSupply ?? '0')
        );
        if (!facts) {
          /*
           * The analysis ran and could not reach the launch — a token with too
           * long a history, or a gap in what the provider returned. `false` is
           * LEFT IN PLACE so it is retried, because unlike a source being down
           * this is a token-specific failure that a later pass may not repeat.
           */
          continue;
        }

        await prisma.token.update({
          where: { mint: token.mint },
          data: {
            launchAnalyzed: true,
            bundledPct: facts.bundledPct,
            bundleWallets: facts.bundleWallets,
            sniperPct: facts.sniperPct,
            sniperWallets: facts.sniperWallets,
            stillHeldPct: facts.stillHeldPct,
            creatorLinkedPct: facts.creatorLinkedPct,
            bundleSlot: BigInt(facts.bundleSlot),
            launchSlot: BigInt(facts.launchSlot),
            launchReadAt: new Date(),
          },
        });

        this.log.info(
          { mint: token.mint, bundledPct: facts.bundledPct.toFixed(1), wallets: facts.bundleWallets },
          'launch analysed'
        );
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'launch analysis failed');
      }
    }
  }
}

/**
 * One name per launchpad.
 *
 * The discovery stream calls it `pump`, RugCheck calls it `pump.fun`, and a
 * lowercase of each produced two different launchpads in the same column —
 * which shows up as two chips on a feed, splits a user's `allowedLaunchpads`
 * filter, and makes any grouping by launchpad quietly wrong.
 */
function normalizeLaunchpad(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  switch (name) {
    case 'pumpfun':
    case 'pump':
    case 'pumpswap':
      return 'pumpfun';
    case 'letsbonk':
    case 'bonk':
    case 'launchlab':
      return 'bonk';
    case 'raydium':
    case 'raydiumcpmm':
      return 'raydium';
    case 'meteora':
    case 'moonshot':
    case 'believe':
    case 'boop':
      return name;
    default:
      return name || 'unknown';
  }
}
