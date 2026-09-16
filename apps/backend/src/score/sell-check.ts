import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { probeSell } from '../sources/jupiter.js';

/**
 * THE SELL CHECK — can a real position actually get out?
 *
 * TWO SOURCES, IN ORDER, AND THE ORDER IS THE ARGUMENT.
 *
 * WHAT ALREADY HAPPENED beats what would happen. If unrelated wallets have sold
 * this token in the last few hours, that is a RECORD rather than a simulation
 * and nothing can fake it. DexScreener's 24h sell count is the cheap form of
 * that evidence and it is already on the row.
 *
 * WHAT WOULD HAPPEN is the fallback, for a token too new to have any. A
 * real-size exit is quoted against the live aggregator and judged on two
 * things: whether it routes AT ALL, and what it costs. A route that exists and
 * returns four percent of the money is a honeypot with extra steps, so the
 * impact is carried through to the grade rather than being collapsed into a
 * boolean.
 *
 * NEITHER ANSWERING LEAVES `sellOk` NULL, WHICH IS NOT A PASS. That null is the
 * single most consequential one in the system: it keeps the token below the
 * call threshold and makes auto-trade refuse it outright.
 */
export class SellChecker {
  private readonly task: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig().sellCheck;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'sell-check' });
    this.task = new IntervalTask('sell-check', 4_000, () => this.tick(), this.log);
  }

  start(): void {
    this.task.start(true);
  }
  stop(): void {
    this.task.stop();
  }

  private async tick(): Promise<void> {
    const recheck = new Date(Date.now() - this.cfg.recheckMinutes * 60_000);

    const tokens = await prisma.token.findMany({
      where: {
        tier: { in: ['ACTIVE', 'GRADUATED'] },
        priceUsd: { gt: 0 },
        OR: [{ sellCheckedAt: null }, { sellCheckedAt: { lt: recheck } }],
      },
      orderBy: [{ sellCheckedAt: { sort: 'asc', nulls: 'first' } }],
      select: {
        mint: true,
        decimals: true,
        priceUsd: true,
        sells24h: true,
        liquidityUsd: true,
        // Carried so `write` can tell a changed verdict from a re-confirmed one.
        sellOk: true,
      },
      take: 8,
    });

    for (const token of tokens) {
      try {
        await this.check(token);
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'sell check failed');
      }
    }
  }

  /**
   * Writing a verdict, and forcing a re-grade when it CHANGED.
   *
   * `scoredAt: null` puts the token at the front of the scorer's queue on its
   * very next pass. Without it a token whose sell check has just flipped to
   * `false` keeps its old grade for the full rescore window — up to a minute
   * and a half of a screen showing 76/100 for a token nothing can be sold out
   * of. The calls engine reads the live column and so was never fooled, but the
   * number a person is looking at was.
   */
  private async write(
    mint: string,
    previous: boolean | null,
    data: {
      sellOk: boolean | null;
      sellVia: string | null;
      sellImpactPct: number | null;
      sellTaxBps: number | null;
    }
  ): Promise<void> {
    const changed = previous !== data.sellOk;
    await prisma.token.update({
      where: { mint },
      data: { ...data, sellCheckedAt: new Date(), ...(changed ? { scoredAt: null } : {}) },
    });
  }

  private async check(token: {
    mint: string;
    decimals: number;
    priceUsd: number | null;
    sells24h: number;
    liquidityUsd: number | null;
    sellOk: boolean | null;
  }): Promise<void> {
    /*
     * OBSERVED SELLS FIRST.
     *
     * The threshold is a COUNT of sells rather than of distinct sellers,
     * because the aggregate feed does not break sellers out — and the number is
     * set well above one for exactly that reason: a single sell could be the
     * creator's own wallet, which a honeypot routinely permits. Dozens of sells
     * in a day is a market that people are demonstrably leaving.
     */
    if (token.sells24h >= this.cfg.minDistinctSellers * 4) {
      await this.write(token.mint, token.sellOk, {
        sellOk: true,
        sellVia: 'observed_sells',
        // No impact figure: this evidence says selling HAPPENS, not what a
        // particular size would cost. Inventing a number here would be exactly
        // the kind of confident filler the rest of this refuses.
        sellImpactPct: null,
        sellTaxBps: null,
      });
      return;
    }

    const probe = await probeSell(
      token.mint,
      token.decimals,
      token.priceUsd ?? 0,
      // The probe is capped at a share of the pool: quoting a $250 exit against
      // $900 of liquidity measures the pool's size, not the token's sellability,
      // and would mark every small-but-honest launch unsellable.
      Math.min(this.cfg.probeUsd, Math.max(25, (token.liquidityUsd ?? 0) * 0.05))
    );

    if (probe.kind === 'unavailable') {
      // We learned nothing. The row is NOT touched — writing `checkedAt` here
      // would mark the token as checked and leave `sellOk` null for the full
      // recheck window, which reads as a completed check that found nothing.
      return;
    }

    if (probe.kind === 'no_route') {
      await this.write(token.mint, token.sellOk, {
        sellOk: false,
        sellVia: 'route_quote',
        sellImpactPct: null,
        sellTaxBps: null,
      });
      this.log.info({ mint: token.mint }, 'no sell route — token cannot be exited at size');
      return;
    }

    /*
     * A ROUTE THAT COSTS MORE THAN THE CEILING IS NOT AN EXIT.
     *
     * `maxImpactPct` is the line, and crossing it records `sellOk: false` with
     * the impact attached rather than a pass with a caveat — because everything
     * downstream treats `true` as "this can be sold", and a 60% haircut is not
     * a sale, it is a donation.
     */
    const ok = probe.impactPct <= this.cfg.maxImpactPct;
    await this.write(token.mint, token.sellOk, {
      sellOk: ok,
      sellVia: 'route_quote',
      sellImpactPct: probe.impactPct,
      sellTaxBps: probe.effectiveTaxBps,
    });
  }
}
