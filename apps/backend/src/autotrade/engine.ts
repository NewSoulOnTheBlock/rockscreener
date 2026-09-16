import type { AutoSettings, Prisma } from '@prisma/client';
import { LAMPORTS_PER_SOL } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import { loadConfig } from '../config/load.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { notifyDisarmed, notifyFill } from '../notify/telegram.js';
import { tradeRpc } from '../clients/solana.js';
import { balanceOf } from '../sources/mint-account.js';
import { Executor, UnconfirmedTrade } from '../trading/executor.js';
import { resolveWallet } from '../trading/wallets.js';
import { evaluateEntry, type EntryCandidate } from './entry.js';
import { evaluateExit, retiredSteps, type PositionState } from './exit.js';
import { cachedGate } from './gate.js';
import { creatorHistory } from '../score/gather.js';
import { readRules, type AutoTradeRules } from './rules.js';

/**
 * THE EXECUTION ENGINE.
 *
 * IT DECIDES NOTHING ABOUT WHAT A TOKEN IS WORTH. The grade comes from the
 * scorer, the price from the indexer, the claim from the calls engine and the
 * thresholds from the user. This file's entire job is to apply one to the
 * others on a clock and write down what it did — which is why the interesting
 * logic lives in `entry.ts` and `exit.ts` as pure functions and this file is
 * plumbing.
 *
 * WHAT IT BUYS IS WHAT THE PRODUCT CALLED. It does not run its own selection,
 * and it must not: a second definition of "worth buying" living beside the one
 * in `calls/engine.ts` would be two opinions disagreeing on the same screen,
 * and the user's rules would be competing with the product rather than
 * filtering it. A call is made, it is visible in the feed with its entry price,
 * and the engine acts on it — so "why didn't it buy that one" has a good
 * answer, because the call is on the screen and the refusal names a number the
 * user themselves set.
 *
 * TWO LOOPS AT DIFFERENT RATES, and the asymmetry is the point. A missed entry
 * costs an opportunity; a missed exit costs the position. So exits run at twice
 * the frequency, they run even when entries are globally disabled, and if the
 * process is struggling it is entries that get starved.
 *
 * EVERY DECISION IS RECORDED, INCLUDING THE DECISION TO DO NOTHING.
 */

interface ArmedUser {
  userId: string;
  walletId: string | null;
  rules: AutoTradeRules;
  settings: AutoSettings;
}

export class AutoTradeEngine {
  private readonly entryTask: IntervalTask;
  private readonly exitTask: IntervalTask;
  private readonly reconcileTask: IntervalTask;
  private readonly log: Logger;
  private readonly cfg = loadConfig().autotrade;
  private readonly executor: Executor;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'autotrade' });
    this.executor = new Executor(this.log);
    this.entryTask = new IntervalTask('autotrade-entry', this.cfg.entryTickMs, () => this.entryTick(), this.log);
    this.exitTask = new IntervalTask('autotrade-exit', this.cfg.exitTickMs, () => this.exitTick(), this.log);
    /*
     * SLOW ON PURPOSE. Reconciliation is about trades whose fate is unknown,
     * and the commonest cause of "unknown" is a cluster that is busy — asking
     * it about the same signature every two seconds is the wrong response. Half
     * a minute is faster than any position needs and gentle enough that a
     * backlog of stuck rows does not become its own load.
     */
    this.reconcileTask = new IntervalTask('autotrade-reconcile', 30_000, () => this.reconcile(), this.log);
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.log.warn('auto-trade is disabled in configuration.json — settings are stored and nothing acts on them');
      return;
    }
    /*
     * EXITS START FIRST AND UNCONDITIONALLY. `allowEntries: false` is the kill
     * switch, and it stops BUYING while leaving every open position managed — a
     * switch that stopped the exit loop would strand users in whatever they
     * were holding when it was thrown, which is the opposite of a safety
     * control.
     */
    this.exitTask.start(true);
    /*
     * RECONCILE RUNS EVEN WITH ENTRIES DISABLED. The rows it settles were
     * opened before the switch was thrown, and money already committed has to
     * be accounted for whether or not the engine is allowed to commit more.
     */
    this.reconcileTask.start(true);
    if (this.cfg.allowEntries) this.entryTask.start(false);
    else this.log.warn('entries are disabled globally — open positions are still managed');
  }

  stop(): void {
    this.entryTask.stop();
    this.exitTask.stop();
    this.reconcileTask.stop();
  }

  // ------------------------------------------------------------------ entries

  private async entryTick(): Promise<void> {
    const users = await this.armedUsers();
    if (users.length === 0) return;

    const open = await prisma.autoPosition.count({ where: { status: { in: ['opening', 'open'] } } });
    if (open >= this.cfg.maxOpenPositionsGlobal) {
      this.log.warn({ open }, 'global open-position ceiling reached — no new entries this tick');
      return;
    }

    for (const user of users) {
      try {
        await this.considerFor(user);
      } catch (err) {
        this.log.error({ userId: user.userId, err: errField(err) }, 'entry pass failed');
      }
    }
  }

  private async armedUsers(): Promise<ArmedUser[]> {
    const rows = await prisma.autoSettings.findMany({ where: { enabled: true }, take: 500 });
    return rows.map((settings) => ({
      userId: settings.userId,
      walletId: settings.walletId,
      rules: readRules(settings.rules),
      settings,
    }));
  }

  private async considerFor(user: ArmedUser): Promise<void> {
    /*
     * THE GATE IS CHECKED BEFORE ANY CANDIDATE IS EVEN LOOKED AT — once per
     * user per tick, not once per token. It is cached for a couple of minutes,
     * so this costs one Redis read on the common path.
     */
    const gate = await cachedGate(user.userId);
    if (!gate.unlocked) {
      await this.record(user.userId, {
        kind: 'skipped',
        rule: 'gate.rock',
        message: gate.reason ?? 'The ROCK holding does not clear the line.',
      });
      return;
    }

    if (!user.walletId) {
      await this.record(user.userId, {
        kind: 'skipped',
        rule: 'walletId',
        message: 'No trading wallet is selected, so nothing can be bought.',
      });
      return;
    }

    const held = await prisma.autoPosition.findMany({
      where: { userId: user.userId, status: { in: ['opening', 'open'] } },
      select: { mint: true },
    });
    if (held.length >= user.rules.maxConcurrentPositions) return;

    const budget = await this.budget(user);
    if (!budget.ok) {
      await this.record(user.userId, { kind: 'skipped', rule: budget.rule, message: budget.message });
      return;
    }

    const candidates = await this.candidates(
      user,
      held.map((h) => h.mint)
    );

    for (const { candidate, callId } of candidates) {
      const decision = evaluateEntry(candidate, user.rules.entry);
      if (!decision.ok) {
        await this.record(user.userId, {
          kind: 'skipped',
          rule: decision.rule,
          message: decision.message,
          mint: candidate.mint,
          symbol: candidate.symbol,
        });
        continue;
      }
      await this.open(user, candidate, callId);
      // ONE ENTRY PER USER PER TICK: the budget just moved, so it is re-read
      // on the next pass rather than assumed.
      return;
    }
  }

  /**
   * The spending ceilings, all of which are REQUIRED and none of which has an
   * unlimited value.
   *
   * The rolling hour is reset here rather than by a scheduled job, because a
   * job that has to run for a cap to lapse is a cap that stays engaged when the
   * job dies.
   */
  private async budget(
    user: ArmedUser
  ): Promise<{ ok: true } | { ok: false; rule: string; message: string }> {
    const now = Date.now();
    const s = user.settings;

    if (now - s.hourStartedAt.getTime() >= 3_600_000) {
      await prisma.autoSettings.update({
        where: { userId: user.userId },
        data: { spentThisHour: '0', hourStartedAt: new Date() },
      });
      s.spentThisHour = '0';
    }
    if (now - s.dayStartedAt.getTime() >= 86_400_000) {
      await prisma.autoSettings.update({
        where: { userId: user.userId },
        data: { realizedToday: '0', dayStartedAt: new Date() },
      });
      s.realizedToday = '0';
    }

    const buy = BigInt(user.rules.buyAmountLamports);
    const spent = BigInt(s.spentThisHour);
    const hourly = BigInt(user.rules.maxSpendPerHourLamports);
    if (spent + buy > hourly) {
      return {
        ok: false,
        rule: 'maxSpendPerHourLamports',
        message: `You have spent ${sol(spent)} SOL this hour; another ${sol(buy)} would pass your ${sol(hourly)} ceiling.`,
      };
    }

    /*
     * THE DAILY LOSS CAP DISARMS THE ENGINE RATHER THAN PAUSING IT. The user
     * has to come back and look at what happened before it spends again — a cap
     * that silently resumes at midnight is a cap that loses the same money
     * every day.
     */
    const realized = BigInt(s.realizedToday);
    const cap = BigInt(user.rules.dailyLossCapLamports);
    if (realized < 0n && -realized >= cap) {
      await prisma.autoSettings.update({
        where: { userId: user.userId },
        data: {
          enabled: false,
          disarmedAt: new Date(),
          disarmedReason: `Realised ${sol(-realized)} SOL of losses today, at or past your ${sol(cap)} cap.`,
        },
      });
      const message = `Disarmed: ${sol(-realized)} SOL of realised losses today reached your ${sol(cap)} SOL cap. Open positions are still managed.`;
      await this.record(user.userId, {
        kind: 'disarmed',
        rule: 'dailyLossCapLamports',
        message,
      });
      // The one genuinely urgent message: the engine has stopped and will not
      // restart on its own.
      void notifyDisarmed(user.userId, message);
      return { ok: false, rule: 'dailyLossCapLamports', message: 'The daily loss cap disarmed the engine.' };
    }

    return { ok: true };
  }

  /**
   * Tokens worth looking at: THE FRESH CALLS.
   *
   * FIFTEEN MINUTES IS THE WHOLE WINDOW by default. A call is a statement about
   * a price at a moment, and acting on one from an hour ago is acting after the
   * move — a stale call is not a cheap one.
   *
   * The SQL applies only what is indexable and cheap. `evaluateEntry` owns every
   * rule a user can see in their settings, because a gate enforced only in SQL
   * is a gate that never produces a `skipped` event, and a rule with no
   * explanation is a rule people assume is broken.
   */
  private async candidates(
    user: ArmedUser,
    exclude: string[]
  ): Promise<{ candidate: EntryCandidate; callId: string }[]> {
    const fresh = new Date(Date.now() - this.cfg.callFreshnessSeconds * 1_000);

    const calls = await prisma.call.findMany({
      where: {
        outcome: 'live',
        calledAt: { gte: fresh },
        tier: { in: ['strong_buy', 'buy'] },
        mint: { notIn: exclude },
      },
      include: { token: true },
      orderBy: { calledAt: 'desc' },
      take: this.cfg.candidatesPerTick,
    });

    /*
     * CREATOR RECORDS, LOADED ONCE PER DISTINCT CREATOR.
     *
     * `blockCreatorReputation` is a gate somebody's money passes through, and
     * it was previously fed a hard-coded `null` — which meant the rule existed
     * in the settings form, in the schema and in the pure evaluator, and could
     * never fire. A gate that silently never fires is worse than no gate, since
     * the user believes they are protected by it.
     *
     * Deduplicated because a creator who has just launched four tokens will
     * appear four times in one tick's candidates, and the history query walks
     * every token they have ever launched.
     */
    const creators = [...new Set(calls.map((c) => c.token.creator).filter((c): c is string => c !== null))];
    const reputations = new Map<string, string | null>();
    await Promise.all(
      creators.map(async (address) => {
        const history = await creatorHistory(address).catch(() => null);
        reputations.set(address, history?.reputation ?? null);
      })
    );

    const out: { candidate: EntryCandidate; callId: string }[] = [];
    for (const call of calls) {
      const t = call.token;

      const lastExit = await prisma.autoPosition.findFirst({
        where: { userId: user.userId, mint: t.mint, closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      });

      out.push({
        callId: call.id,
        candidate: {
          mint: t.mint,
          symbol: t.symbol || t.mint.slice(0, 4),
          launchpad: t.launchpad,
          score: t.score,
          tier: (t.tier_ as EntryCandidate['tier']) ?? null,
          coverage: t.coverage,
          liquidityUsd: t.liquidityUsd ?? 0,
          marketCapUsd: t.marketCapUsd ?? 0,
          ageSeconds: (Date.now() - t.launchTime.getTime()) / 1_000,
          holderCount: t.holderCount,
          traders24h: t.traders24h,
          top10Pct: t.top10Pct,
          bundledPct: t.bundledPct,
          clusteredPct: t.clusteredPct,
          creatorPct: t.creatorPct,
          creatorLinkedPct: t.creatorLinkedPct,
          lpLockedPct: t.lpLockedPct,
          mintAuthorityRevoked: t.mintAuthorityRevoked,
          freezeAuthorityRevoked: t.freezeAuthorityRevoked,
          transferFeeBps: t.transferFeeBps,
          sellOk: t.sellOk,
          sellImpactPct: t.sellImpactPct,
          creator: t.creator,
          creatorReputation: t.creator ? (reputations.get(t.creator) ?? null) : null,
          secondsSinceLastExit: lastExit?.closedAt
            ? (Date.now() - lastExit.closedAt.getTime()) / 1_000
            : null,
        },
      });
    }
    return out;
  }

  private async open(user: ArmedUser, candidate: EntryCandidate, callId: string): Promise<void> {
    const wallet = await resolveWallet(user.userId, user.walletId);
    const token = await prisma.token.findUnique({ where: { mint: candidate.mint } });
    if (!token) return;

    /*
     * THE ROW IS WRITTEN BEFORE THE TRADE IS SENT, at `opening`. A crash
     * between the send and the write would otherwise leave tokens in a wallet
     * that no position row accounts for — money the exit loop does not know it
     * is responsible for. An `opening` row that never fills is visible and
     * fixable; an unrecorded bag is not.
     */
    const position = await prisma.autoPosition.create({
      data: {
        userId: user.userId,
        mint: candidate.mint,
        callId,
        status: 'opening',
        entryPriceUsd: token.priceUsd ?? 0,
        highPriceUsd: token.priceUsd ?? 0,
        lastPriceUsd: token.priceUsd ?? 0,
        entryScore: candidate.score ?? 0,
        entryLiquidityUsd: token.liquidityUsd ?? 0,
        decimals: token.decimals,
      },
    });

    try {
      const fill = await this.executor.buy(
        wallet,
        candidate.mint,
        BigInt(user.rules.buyAmountLamports),
        user.rules.slippageBps,
        BigInt(user.rules.maxPriorityFeeLamports),
        async (signature) => {
          await prisma.autoPosition.update({
            where: { id: position.id },
            data: { openSignature: signature, openSentAt: new Date() },
          });
        }
      );

      await prisma.$transaction([
        prisma.autoPosition.update({
          where: { id: position.id },
          data: {
            status: 'open',
            spentLamports: fill.lamports.toString(),
            amount: fill.tokens.toString(),
          },
        }),
        prisma.autoSettings.update({
          where: { userId: user.userId },
          data: {
            spentThisHour: (
              BigInt(user.settings.spentThisHour) + fill.lamports
            ).toString(),
          },
        }),
      ]);

      const message = `Bought ${sol(fill.lamports)} SOL of ${candidate.symbol} at a $${Math.round(candidate.marketCapUsd).toLocaleString('en-US')} market cap on a grade of ${candidate.score}.`;
      await this.record(user.userId, {
        kind: 'bought',
        mint: candidate.mint,
        symbol: candidate.symbol,
        message,
        signature: fill.signature,
      });
      // Fire and forget: a message that fails to send must not fail the fill it
      // was about, nor hold up the next entry pass.
      void notifyFill(user.userId, {
        kind: 'bought',
        symbol: candidate.symbol,
        mint: candidate.mint,
        sol: Number(fill.lamports) / LAMPORTS_PER_SOL,
        signature: fill.signature,
        rule: 'entry',
        reason: message,
      });
    } catch (err) {
      /*
       * AN UNCONFIRMED TRADE IS NOT A FAILED ONE, and the difference is real
       * money. A buy whose confirmation we did not see may well have landed;
       * writing it off as `failed` would leave tokens in the user's wallet that
       * no position row is responsible for selling — invisible to every exit
       * rule — and free the engine to buy the same token again with money it
       * has already spent. The row stays `opening` with its signature, and
       * `reconcile` settles it against the chain.
       */
      if (err instanceof UnconfirmedTrade) {
        await this.record(user.userId, {
          kind: 'failed',
          mint: candidate.mint,
          symbol: candidate.symbol,
          message: `The buy for ${candidate.symbol} was broadcast but not confirmed in time. It is being settled against the chain, not written off.`,
          signature: err.signature,
        });
        return;
      }

      await prisma.autoPosition.update({
        where: { id: position.id },
        data: { status: 'failed', closedAt: new Date(), closeReason: errField(err).message },
      });
      await this.record(user.userId, {
        kind: 'failed',
        mint: candidate.mint,
        symbol: candidate.symbol,
        message: `Could not buy ${candidate.symbol}: ${errField(err).message}`,
      });
    }
  }

  // -------------------------------------------------------------- reconcile

  /**
   * SETTLING WHAT THE ENGINE IS NOT SURE ABOUT.
   *
   * Two shapes of drift, and both are money:
   *
   * 1. A position stuck at `opening` — the buy was broadcast and its
   *    confirmation was never seen. It may be a bag sitting in a real wallet
   *    that no exit rule is watching. This asks the chain and either promotes
   *    it to `open` with the real fill or writes it off, and it is the reason
   *    an unconfirmed buy is never marked `failed` at the time.
   *
   * 2. A position at `open` that the wallet no longer holds — a sell that timed
   *    out and then landed. Without this the exit loop retries it on every pass
   *    forever, each attempt failing with "nothing left to sell" and writing
   *    another failure event about a position that closed successfully.
   *
   * IT NEVER GUESSES A NUMBER. Anything it cannot establish from the chain is
   * left exactly as it is for the next pass, because a wrong cost basis is
   * worse than a late one: it is the number every exit rule is measured from.
   */
  private async reconcile(): Promise<void> {
    /*
     * A GRACE PERIOD, because `opening` is also the normal state of a trade
     * that is still being confirmed right now. Reconciling those would race the
     * executor for the same row.
     */
    const settling = new Date(Date.now() - 90_000);

    const opening = await prisma.autoPosition.findMany({
      where: { status: 'opening', OR: [{ openSentAt: null }, { openSentAt: { lt: settling } }] },
      include: { token: true },
      take: 50,
    });

    for (const position of opening) {
      try {
        await this.settleOpening(position);
      } catch (err) {
        this.log.error({ position: position.id, err: errField(err) }, 'reconcile failed');
      }
    }

    await this.closeEmptied();
  }

  private async settleOpening(
    position: Prisma.AutoPositionGetPayload<{ include: { token: true } }>
  ): Promise<void> {
    /*
     * NO SIGNATURE MEANS NOTHING WAS EVER BROADCAST. The row was written before
     * the send — deliberately — so this is a quote that failed, a route that
     * vanished, or a crash before the transaction existed. Nothing was spent.
     */
    if (!position.openSignature) {
      await prisma.autoPosition.update({
        where: { id: position.id },
        data: {
          status: 'failed',
          closedAt: new Date(),
          closeReason: 'No transaction was ever broadcast for this entry.',
        },
      });
      return;
    }

    const settings = await prisma.autoSettings.findUnique({ where: { userId: position.userId } });
    if (!settings) return;
    const wallet = await resolveWallet(position.userId, settings.walletId).catch(() => null);
    if (!wallet) return;

    /*
     * THE WALLET IS THE ARBITER, NOT THE TRANSACTION LOOKUP. `getTransaction`
     * can answer "not found" for a signature that is merely old, or that this
     * node has pruned, and treating that as "it did not happen" is exactly the
     * mistake this pass exists to avoid. What the wallet HOLDS is not ambiguous.
     */
    const held = await balanceOf(wallet.address, position.mint).catch(() => null);
    if (held === null) return;

    if (held > 0n) {
      /*
       * ONE POSITION OWNS THE BAG. If an earlier position for the same mint is
       * already open, this balance is already accounted for and adopting it
       * here would have two rows selling the same tokens — the second one
       * failing, forever.
       */
      const alreadyTracked = await prisma.autoPosition.findFirst({
        where: { userId: position.userId, mint: position.mint, status: 'open' },
      });
      if (alreadyTracked) {
        await prisma.autoPosition.update({
          where: { id: position.id },
          data: {
            status: 'failed',
            closedAt: new Date(),
            closeReason: 'Another position already accounts for this balance.',
          },
        });
        return;
      }

      const spent = await this.spentOn(position.openSignature, wallet.address);
      await prisma.autoPosition.update({
        where: { id: position.id },
        data: {
          status: 'open',
          amount: held.toString(),
          // Null means the transaction could not be read. The size the user
          // committed is the honest fallback: it is what they authorised, and
          // it never flatters the position the way a zero would.
          ...(spent !== null ? { spentLamports: spent.toString() } : {}),
        },
      });
      await this.record(position.userId, {
        kind: 'bought',
        mint: position.mint,
        symbol: position.token.symbol,
        message: `Settled an unconfirmed buy of ${position.token.symbol} against the wallet. The position is open and being managed.`,
        signature: position.openSignature,
      });
      return;
    }

    /*
     * NOTHING IN THE WALLET, AND ENOUGH TIME HAS PASSED. A transaction that has
     * not landed within its blockhash window never will; a token balance of
     * zero after that window means the buy did not happen.
     */
    const sentAt = position.openSentAt?.getTime() ?? 0;
    if (Date.now() - sentAt < 10 * 60_000) return;

    await prisma.autoPosition.update({
      where: { id: position.id },
      data: {
        status: 'failed',
        closedAt: new Date(),
        closeReason: 'The buy never landed — the wallet holds none of this token.',
      },
    });
  }

  /** Positions the engine believes are open that the wallet no longer holds. */
  private async closeEmptied(): Promise<void> {
    const positions = await prisma.autoPosition.findMany({
      where: { status: 'open' },
      include: { token: true },
      take: 100,
    });

    for (const position of positions) {
      try {
        if (BigInt(position.amount) <= 0n) continue;
        const settings = await prisma.autoSettings.findUnique({
          where: { userId: position.userId },
        });
        if (!settings) continue;
        const wallet = await resolveWallet(position.userId, settings.walletId).catch(() => null);
        if (!wallet) continue;

        const held = await balanceOf(wallet.address, position.mint).catch(() => null);
        if (held === null || held > 0n) continue;

        await prisma.autoPosition.update({
          where: { id: position.id },
          data: {
            status: 'closed',
            amount: '0',
            closedAt: new Date(),
            closeReason:
              position.closeReason ??
              'The wallet holds none of this token — an exit that was not confirmed in time had in fact landed.',
          },
        });
        this.log.info({ position: position.id, mint: position.mint }, 'closed an emptied position');
      } catch (err) {
        this.log.debug({ position: position.id, err: errField(err) }, 'emptied check failed');
      }
    }
  }

  /** What one signature actually took out of the wallet, or null if unreadable. */
  private async spentOn(signature: string, owner: string): Promise<bigint | null> {
    const tx = await tradeRpc()
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      .catch(() => null);
    if (!tx?.meta) return null;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
    const index = keys.staticAccountKeys.findIndex((k) => k.toBase58() === owner);
    if (index < 0) return null;

    const delta =
      BigInt(tx.meta.preBalances[index] ?? 0) - BigInt(tx.meta.postBalances[index] ?? 0);
    return delta > 0n ? delta : null;
  }

  // -------------------------------------------------------------------- exits

  private async exitTick(): Promise<void> {
    const positions = await prisma.autoPosition.findMany({
      where: { status: 'open' },
      include: { token: true, call: true },
      take: 400,
    });

    for (const position of positions) {
      try {
        await this.manage(position);
      } catch (err) {
        this.log.error({ position: position.id, err: errField(err) }, 'exit pass failed');
      }
    }
  }

  private async manage(
    position: Prisma.AutoPositionGetPayload<{ include: { token: true; call: true } }>
  ): Promise<void> {
    const settings = await prisma.autoSettings.findUnique({ where: { userId: position.userId } });
    if (!settings) return;
    const rules = readRules(settings.rules);

    const token = position.token;
    const price = token.priceUsd ?? position.lastPriceUsd;
    const highPriceUsd = Math.max(position.highPriceUsd, price);

    /*
     * THE RUG SIGNAL IS COMPUTED HERE rather than read from a column, because
     * it is relative to THIS position: liquidity that has collapsed from where
     * it was when this user entered. Two users who entered the same token an
     * hour apart do not have the same rug.
     */
    const liquidity = token.liquidityUsd ?? 0;
    let rugSignal: string | null = null;
    if (token.sellOk === false) {
      rugSignal = 'The sell check stopped finding a route out of this token.';
    } else if (token.rugged === true) {
      rugSignal = 'The token has been pulled.';
    } else if (
      position.entryLiquidityUsd > 0 &&
      liquidity < position.entryLiquidityUsd * 0.2
    ) {
      rugSignal = `Liquidity fell ${Math.round((1 - liquidity / position.entryLiquidityUsd) * 100)}% from entry.`;
    }

    const callWithdrawn =
      position.call && position.call.outcome !== 'live'
        ? (position.call.closeReason ?? 'The call on this token was withdrawn.')
        : null;

    const amount = BigInt(position.amount);
    const state: PositionState = {
      symbol: token.symbol || token.mint.slice(0, 4),
      amount,
      entryPriceUsd: position.entryPriceUsd,
      highPriceUsd,
      lastPriceUsd: price,
      valueLamports: this.valueInLamports(position, price, token.priceSol),
      openedAtMs: position.openedAt.getTime(),
      filledSteps: position.filledSteps,
      currentScore: token.score,
      rugSignal,
      callWithdrawn,
    };

    const decision = evaluateExit(state, rules.exit, Date.now());

    // The mark is always written, whether or not anything is sold: the trailing
    // stop is only as good as the high-water mark behind it.
    await prisma.autoPosition.update({
      where: { id: position.id },
      data: { lastPriceUsd: price, highPriceUsd },
    });

    if (!decision.sell) return;

    const wallet = await resolveWallet(position.userId, settings.walletId);
    const selling = decision.pct >= 100 ? amount : (amount * BigInt(Math.round(decision.pct))) / 100n;

    try {
      await prisma.autoPosition.update({ where: { id: position.id }, data: { status: 'closing' } });

      const fill = await this.executor.sell(
        wallet,
        position.mint,
        selling,
        rules.slippageBps,
        BigInt(rules.maxPriorityFeeLamports)
      );

      const remaining = amount - fill.tokens;
      const received = BigInt(position.receivedLamports) + fill.lamports;
      const fullyClosed = remaining <= 0n || decision.pct >= 100;

      /*
       * REALISED PnL IS ONLY BOOKED WHEN THE POSITION IS FULLY CLOSED. Booking
       * it on a partial exit would count the SOL that came back from a
       * take-profit rung as profit while the cost basis of the remainder is
       * still outstanding — which makes the daily loss cap read a winning
       * ladder as a series of gains and then a large loss.
       */
      const realized = fullyClosed ? received - BigInt(position.spentLamports) : 0n;

      await prisma.$transaction([
        prisma.autoPosition.update({
          where: { id: position.id },
          data: {
            status: fullyClosed ? 'closed' : 'open',
            amount: (remaining > 0n ? remaining : 0n).toString(),
            receivedLamports: received.toString(),
            filledSteps:
              decision.step !== undefined
                ? retiredSteps(rules.exit, decision.step, position.filledSteps)
                : position.filledSteps,
            ...(fullyClosed ? { closedAt: new Date(), closeReason: decision.reason } : {}),
          },
        }),
        ...(realized !== 0n
          ? [
              prisma.autoSettings.update({
                where: { userId: position.userId },
                data: { realizedToday: (BigInt(settings.realizedToday) + realized).toString() },
              }),
            ]
          : []),
      ]);

      const message = `${decision.reason} Sold ${decision.pct}% for ${sol(fill.lamports)} SOL.`;
      await this.record(position.userId, {
        kind: 'sold',
        mint: position.mint,
        symbol: state.symbol,
        rule: decision.rule,
        message,
        signature: fill.signature,
      });
      void notifyFill(position.userId, {
        kind: 'sold',
        symbol: state.symbol,
        mint: position.mint,
        sol: Number(fill.lamports) / LAMPORTS_PER_SOL,
        signature: fill.signature,
        rule: decision.rule,
        reason: message,
      });
    } catch (err) {
      /*
       * A FAILED EXIT RETURNS THE POSITION TO `open`, deliberately. Leaving it
       * `closing` would exclude it from the next exit pass — a position that
       * failed to sell once would then never be tried again, which is the worst
       * possible outcome for a rule that fired because something was wrong.
       */
      await prisma.autoPosition.update({ where: { id: position.id }, data: { status: 'open' } });
      await this.record(position.userId, {
        kind: 'failed',
        mint: position.mint,
        symbol: state.symbol,
        rule: decision.rule,
        message: `Could not sell ${state.symbol}: ${errField(err).message}`,
      });
    }
  }

  /**
   * What the remaining position is worth, in lamports.
   *
   * Via the token's SOL price rather than via dollars, because the dust
   * threshold it feeds is denominated in lamports — comparing a dollar value
   * against a lamport ceiling would make the threshold move with the SOL price.
   */
  private valueInLamports(
    position: { amount: string; decimals: number },
    priceUsd: number,
    priceSol: number | null
  ): bigint {
    const tokens = Number(position.amount) / 10 ** position.decimals;
    const perToken = priceSol && priceSol > 0 ? priceSol : priceUsd > 0 ? priceUsd / 200 : 0;
    return BigInt(Math.max(0, Math.floor(tokens * perToken * LAMPORTS_PER_SOL)));
  }

  private async record(
    userId: string,
    event: {
      kind: 'considered' | 'skipped' | 'bought' | 'sold' | 'failed' | 'disarmed';
      mint?: string;
      symbol?: string;
      rule?: string;
      message: string;
      signature?: string;
    }
  ): Promise<void> {
    try {
      await prisma.autoEvent.create({
        data: {
          userId,
          kind: event.kind,
          mint: event.mint ?? null,
          symbol: event.symbol ?? null,
          rule: event.rule ?? null,
          message: event.message,
          signature: event.signature ?? null,
        },
      });
    } catch (err) {
      // The log is the feature, but it is not worth failing a trade over.
      this.log.debug({ userId, err: errField(err) }, 'could not write event');
    }
  }
}

function sol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}
