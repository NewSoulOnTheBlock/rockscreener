import type { Token } from '@prisma/client';
import type { CreatorHistory, LaunchAnalysis, SellCheck } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';
import type { ScoreRequest } from './score.js';
import { creatorReputation } from './score.js';
import type {
  DistributionInput,
  LiquidityInput,
  MomentumInput,
  PresenceInput,
  SafetyInput,
} from './pillars.js';

/**
 * Turning a stored row into the inputs the pure scorer takes.
 *
 * THIS IS WHERE NULL IS DECIDED, and it is the only place in the scoring path
 * that touches a database. A pillar's input is built only when there is
 * something real to build it from; otherwise it is `null` and the pillar goes
 * unmeasured. The temptation this file exists to refuse is filling a gap with a
 * default — `top10Pct ?? 50`, `transferFeeBps ?? 0` — each of which would turn
 * an absent reading into a confident one somewhere no reviewer would ever look.
 *
 * `transferFeeBps` is the instructive case. Zero is a REAL reading for a
 * classic SPL mint and a lie for a mint nobody has read, so it is carried
 * through as `number | null` all the way from the RPC call rather than being
 * coalesced anywhere on the way.
 */

export function buildSellCheck(token: Token): SellCheck {
  return {
    ok: token.sellOk,
    via: (token.sellVia as SellCheck['via']) ?? null,
    impactPct: token.sellImpactPct,
    effectiveTaxBps: token.sellTaxBps,
    checkedAt: token.sellCheckedAt?.toISOString() ?? null,
  };
}

export function buildLaunchAnalysis(token: Token): LaunchAnalysis {
  return {
    /*
     * `analyzed` is TRUE when the first-slot pass ran OR the insider graph
     * answered — those are two different readings of the same question and
     * either of them makes the pillar scoreable. A deployment with no
     * transaction-history key still gets the cluster reading, which is the more
     * predictive of the two.
     */
    analyzed: token.launchAnalyzed || token.clusteredPct !== null,
    bundledPct: token.bundledPct,
    bundleWallets: token.bundleWallets,
    sniperPct: token.sniperPct,
    sniperWallets: token.sniperWallets,
    clusteredPct: token.clusteredPct,
    clusters: token.clusters,
    stillHeldPct: token.stillHeldPct,
    creatorPct: token.creatorPct,
    creatorLinkedPct: token.creatorLinkedPct,
    bundleSlot: token.bundleSlot === null ? null : Number(token.bundleSlot),
    launchSlot: token.launchSlot === null ? null : Number(token.launchSlot),
  };
}

/**
 * What this index has seen a creator do, before this token.
 *
 * COUNTED FROM OUR OWN ROWS AND NOTHING ELSE. There is no third party that will
 * tell you a Solana creator's history, so the record is only ever as long as
 * this deployment has been running — which is stated rather than hidden: a
 * creator with one launch returns `reputation: null`, and the UI prints "a
 * first launch is not a signal in either direction".
 */
export async function creatorHistory(creator: string | null): Promise<CreatorHistory | null> {
  if (!creator) return null;

  const rows = await prisma.token.findMany({
    where: { creator },
    select: { mint: true, marketCapUsd: true, liquidityUsd: true, tier: true },
    take: 200,
  });
  if (rows.length === 0) return null;

  /*
   * "RUGGED" HERE IS A MEASUREMENT, NOT A LABEL WE APPLY TO A PERSON: a token
   * that reached a real market cap and now has almost no liquidity left. The
   * floor of $30k is what keeps a creator's twenty dead experiments — tokens
   * that never traded at all — from reading as twenty rug pulls.
   */
  const meaningful = rows.filter((r) => (r.marketCapUsd ?? 0) > 30_000);
  const rugged = meaningful.filter((r) => (r.liquidityUsd ?? 0) < 1_500).length;
  const survived = meaningful.filter((r) => (r.liquidityUsd ?? 0) >= 15_000).length;

  return {
    address: creator,
    tokensLaunched: rows.length,
    rugged,
    survived,
    reputation: creatorReputation(rows.length, rugged, survived),
  };
}

export async function gather(token: Token): Promise<ScoreRequest> {
  const sell = buildSellCheck(token);
  const launch = buildLaunchAnalysis(token);
  const creator = await creatorHistory(token.creator);

  /*
   * The safety pillar is scoreable as soon as ANY of its inputs exists. The
   * mint account is the cheap one and is usually first; the sell check and the
   * RugCheck report arrive later, and each one raises coverage as it lands.
   */
  const hasSafetyInput =
    token.mintReadAt !== null || token.securityReadAt !== null || token.sellCheckedAt !== null;

  const safety: SafetyInput | null = hasSafetyInput
    ? {
        mintAuthorityRevoked: token.mintAuthorityRevoked,
        freezeAuthorityRevoked: token.freezeAuthorityRevoked,
        metadataMutable: token.metadataMutable,
        transferFeeBps: token.transferFeeBps,
        sell,
        rugged: token.rugged,
        criticalRisks: criticalRisks(token.risks),
        launchpad: token.launchpad,
      }
    : null;

  /*
   * Built ONLY when the market sync actually got a pair back, or the token is
   * still on a curve. That distinction is what lets `scoreLiquidity` treat a
   * zero as the damning reading it is rather than as a gap — see the note there.
   */
  const liquidity: LiquidityInput | null =
    token.liquidityUsd !== null || token.status === 'BONDING'
      ? {
          liquidityUsd: token.liquidityUsd ?? 0,
          marketCapUsd: token.marketCapUsd ?? 0,
          lpLockedPct: token.lpLockedPct,
          marketCount: token.marketCount,
          bonding: token.status === 'BONDING',
          progressBps: token.progressBps,
        }
      : null;

  const distribution: DistributionInput | null =
    token.securityReadAt !== null
      ? {
          top10Pct: token.top10Pct,
          creatorPct: token.creatorPct,
          holderCount: token.holderCount,
        }
      : null;

  const momentum: MomentumInput | null =
    token.txns24h > 0
      ? {
          ageSeconds: Math.max(0, (Date.now() - token.launchTime.getTime()) / 1000),
          buys24h: token.buys24h,
          sells24h: token.sells24h,
          traders24h: token.traders24h,
          volume24hUsd: token.volume24hUsd,
          liquidityUsd: token.liquidityUsd ?? 0,
          allTimeHighUsd: token.allTimeHighUsd,
          priceUsd: token.priceUsd ?? 0,
          // Maintained by this system on every market pass, so a zero here IS
          // the reading — "nothing traded in that window" — rather than a gap.
          volume5mUsd: token.volume5mUsd,
          volume1hUsd: token.volume1hUsd,
          volume6hUsd: token.volume6hUsd,
          priceChange5m: token.priceChange5m,
          priceChange1h: token.priceChange1h,
          priceChange6h: token.priceChange6h,
        }
      : null;

  const presence: PresenceInput | null =
    token.dexCheckedAt !== null
      ? {
          paid: token.dexPaid,
          paidTypes: token.dexPaidTypes,
          boosts: token.boosts,
          liquidityUsd: token.liquidityUsd ?? 0,
        }
      : null;

  return {
    mint: token.mint,
    safety,
    liquidity,
    distribution,
    momentum,
    launch,
    creator,
    sell,
    presence,
    previousScore: token.score,
  };
}

/**
 * The risks worth surfacing, in RugCheck's own words.
 *
 * Only `danger` and `error`. Their `info` and `warn` levels include things like
 * "low amount of LP providers" on tokens that are three minutes old, and
 * putting those on a card would mean every young token carries a red finding
 * for being young.
 */
function criticalRisks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { name?: string; level?: string }[])
    .filter((r) => r.level === 'danger' || r.level === 'error')
    .map((r) => r.name ?? '')
    .filter((n): n is string => n.length > 0);
}
