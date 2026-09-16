import type { AutoEvent, AutoPosition, Call, Token } from '@prisma/client';
import type {
  AutoPosition as AutoPositionView,
  AutoTradeEvent,
  Call as CallView,
  CallSummary,
  HolderRow,
  RockPillars,
  RockScore,
  RockScoreSummary,
  RockTier,
  TokenDetail,
  TokenSummary,
} from '@rockscreener/shared';
import { explorerToken } from '@rockscreener/shared';
import { buildLaunchAnalysis, buildSellCheck } from '../score/gather.js';

/**
 * Rows to the wire contract.
 *
 * THIS IS THE LAST PLACE A NULL COULD BE LOST, and every conversion below is
 * written to preserve it. The temptation at a serialisation boundary is always
 * `?? 0` — it makes the types line up and it silently turns "nobody measured
 * this" into "measured, and it was zero" at the one point where nobody would
 * think to look for it.
 *
 * The exception is deliberate and narrow: fields this system MAINTAINS ITSELF
 * (volume buckets, transaction counts) default to zero, because there a zero
 * genuinely is the reading.
 */

export function tokenSummary(t: Token, call?: Call | null): TokenSummary {
  return {
    mint: t.mint,
    launchpad: t.launchpad as TokenSummary['launchpad'],
    tier: t.tier as TokenSummary['tier'],
    status: t.status as TokenSummary['status'],

    name: t.name,
    symbol: t.symbol,
    nameState: t.nameState as TokenSummary['nameState'],
    imageUrl: t.imageUrl,
    creator: t.creator ?? '',

    launchTime: t.launchTime.toISOString(),
    lastActivityAt: t.lastActivityAt?.toISOString() ?? null,
    migratedAt: t.migratedAt?.toISOString() ?? null,
    progressBps: t.progressBps,

    /*
     * NULL SURVIVES TO THE CLIENT. This is the boundary where `?? 0` is most
     * tempting and most damaging: it makes the types line up and turns "this
     * token has no market yet" into "this token is worth nothing", at the one
     * point nobody thinks to look. The formatter renders an em dash for each.
     */
    priceUsd: t.priceUsd,
    priceSol: t.priceSol,
    marketCapUsd: t.marketCapUsd,
    liquidityUsd: t.liquidityUsd,
    fdvUsd: t.fdvUsd,

    volume5mUsd: t.volume5mUsd,
    volume1hUsd: t.volume1hUsd,
    volume6hUsd: t.volume6hUsd,
    volume24hUsd: t.volume24hUsd,

    priceChange5m: t.priceChange5m,
    priceChange1h: t.priceChange1h,
    priceChange6h: t.priceChange6h,
    priceChange24h: t.priceChange24h,

    txns24h: t.txns24h,
    buys24h: t.buys24h,
    sells24h: t.sells24h,
    // Null, not zero: "nobody counted the distinct wallets" and "one wallet
    // traded it" are opposite facts, and the momentum pillar reads them
    // differently.
    traders24h: t.traders24h,

    holderCount: t.holderCount,
    top10Pct: t.top10Pct,
    creatorPct: t.creatorPct,

    risk: riskOf(t),
    riskWarnings: Array.isArray(t.findings)
      ? (t.findings as { severity?: string }[]).filter(
          (f) => f.severity === 'critical' || f.severity === 'high'
        ).length
      : 0,

    rock: scoreSummary(t),
    call: call ? callSummary(call) : null,

    hasSocials: Boolean(t.websiteUrl || t.twitterUrl || t.telegramUrl),
    dexPaid: t.dexPaid,
    dexPaidTypes: t.dexPaidTypes as TokenSummary['dexPaidTypes'],
    boosts: t.boosts,

    dexId: t.dexId,
    poolAddress: t.poolAddress,
  };
}

export function tokenDetail(t: Token, call?: Call | null): TokenDetail {
  return {
    ...tokenSummary(t, call),
    description: t.description,
    websiteUrl: t.websiteUrl,
    twitterUrl: t.twitterUrl,
    telegramUrl: t.telegramUrl,

    decimals: t.decimals,
    totalSupply: t.totalSupply ?? '0',

    // Zero IS a reading for a classic SPL mint and a lie for a mint nobody has
    // read — so the null is preserved right up to the client, which draws a
    // dashed chip for it.
    transferFeeBps: t.transferFeeBps ?? 0,
    mintAuthority: null,
    freezeAuthority: null,
    mintAuthorityRevoked: t.mintAuthorityRevoked,
    freezeAuthorityRevoked: t.freezeAuthorityRevoked,
    metadataMutable: t.metadataMutable,

    lpLockedPct: t.lpLockedPct,
    lpLockedUsd: t.lpLockedUsd,
    marketCount: t.marketCount,

    allTimeHighUsd: t.allTimeHighUsd,
    allTimeHighAt: t.allTimeHighAt?.toISOString() ?? null,

    launchTx: null,
    explorerUrl: explorerToken(t.mint),
  };
}

export function scoreSummary(t: Token): RockScoreSummary | null {
  if (t.score === null || t.tier_ === null || t.coverage === null || t.scoredAt === null) {
    return null;
  }
  return {
    score: t.score,
    tier: t.tier_ as RockTier,
    coverage: t.coverage,
    topWarning: t.topWarning,
    bundledPct: t.bundledPct,
    clusteredPct: t.clusteredPct,
    sellOk: t.sellOk,
    computedAt: t.scoredAt.toISOString(),
  };
}

export function fullScore(t: Token): RockScore | null {
  if (t.score === null || t.tier_ === null || t.coverage === null || t.scoredAt === null) {
    return null;
  }
  return {
    mint: t.mint,
    score: t.score,
    tier: t.tier_ as RockTier,
    pillars: (t.pillars as unknown as RockPillars) ?? {
      safety: null,
      launch: null,
      liquidity: null,
      distribution: null,
      momentum: null,
    },
    coverage: t.coverage,
    clamped: (t.clamped as RockScore['clamped']) ?? null,
    findings: (t.findings as unknown as RockScore['findings']) ?? [],
    launch: buildLaunchAnalysis(t),
    // The creator's record is a separate query and is not worth one per row;
    // the detail route fills it in.
    creator: null,
    sell: buildSellCheck(t),
    computedAt: t.scoredAt.toISOString(),
    previousScore: t.prevScore,
  };
}

export function holders(t: Token): HolderRow[] {
  return Array.isArray(t.holders) ? (t.holders as unknown as HolderRow[]) : [];
}

export function callView(c: Call): CallView {
  return {
    id: c.id,
    mint: c.mint,
    symbol: '',
    name: '',
    imageUrl: null,
    tier: c.tier as CallView['tier'],
    score: c.score,
    coverage: c.coverage,
    headline: c.headline,
    calledAt: c.calledAt.toISOString(),
    entryPriceUsd: c.entryPriceUsd,
    entryMarketCapUsd: c.entryMarketCapUsd,
    entryLiquidityUsd: c.entryLiquidityUsd,
    peakPriceUsd: c.peakPriceUsd,
    peakMarketCapUsd: c.peakMarketCapUsd,
    peakAt: c.peakAt?.toISOString() ?? null,
    peakMultiple: ratio(c.peakPriceUsd, c.entryPriceUsd),
    lastPriceUsd: c.lastPriceUsd,
    lastMarketCapUsd: c.lastMarketCapUsd,
    currentMultiple: ratio(c.lastPriceUsd, c.entryPriceUsd),
    /*
     * Measured from the TROUGH rather than from the current price: a call that
     * fell 80% and came back is a call that fell 80%, and somebody deciding
     * whether they could have held it needs that number, not where it happens
     * to be now.
     */
    maxDrawdownPct: Math.round((ratio(c.troughPriceUsd, c.entryPriceUsd) - 1) * 100),
    outcome: c.outcome as CallView['outcome'],
    closedAt: c.closedAt?.toISOString() ?? null,
    closeReason: c.closeReason,
    spark: c.spark,
  };
}

export function callWithToken(c: Call & { token: Token }): CallView {
  return { ...callView(c), symbol: c.token.symbol, name: c.token.name, imageUrl: c.token.imageUrl };
}

export function callSummary(c: Call): CallSummary {
  return {
    tier: c.tier as CallSummary['tier'],
    calledAt: c.calledAt.toISOString(),
    // All three caps travel together, and none of them is derived from the
    // token row: the token's current market cap is what it is worth now, which
    // for a CLOSED call is a different number from the one the call last saw.
    entryMarketCapUsd: c.entryMarketCapUsd,
    peakMarketCapUsd: c.peakMarketCapUsd,
    lastMarketCapUsd: c.lastMarketCapUsd,
    peakMultiple: ratio(c.peakPriceUsd, c.entryPriceUsd),
    currentMultiple: ratio(c.lastPriceUsd, c.entryPriceUsd),
    outcome: c.outcome as CallSummary['outcome'],
  };
}

export function positionView(p: AutoPosition & { token: Token }): AutoPositionView {
  const spent = Number(p.spentLamports);
  const received = Number(p.receivedLamports);
  const held = Number(p.amount) / 10 ** p.decimals;
  /*
   * UNREALISED PLUS REALISED, and the unrealised leg is priced through the SOL
   * mark rather than the dollar one — the whole column is denominated in SOL,
   * and mixing the two would make a position's PnL move when SOL did.
   */
  const markLamports = held * (p.token.priceSol ?? 0) * 1_000_000_000;
  const pnl = received + markLamports - spent;

  return {
    id: p.id,
    mint: p.mint,
    symbol: p.token.symbol,
    imageUrl: p.token.imageUrl,
    status: p.status as AutoPositionView['status'],
    spentLamports: p.spentLamports,
    receivedLamports: p.receivedLamports,
    amount: p.amount,
    decimals: p.decimals,
    entryPriceUsd: p.entryPriceUsd,
    highPriceUsd: p.highPriceUsd,
    lastPriceUsd: p.lastPriceUsd,
    pnlLamports: String(Math.round(pnl)),
    pnlPct: spent > 0 ? ((received + markLamports) / spent - 1) * 100 : 0,
    entryScore: p.entryScore,
    filledSteps: p.filledSteps,
    openedAt: p.openedAt.toISOString(),
    closedAt: p.closedAt?.toISOString() ?? null,
    closeReason: p.closeReason,
  };
}

export function eventView(e: AutoEvent): AutoTradeEvent {
  return {
    id: e.id.toString(),
    at: e.at.toISOString(),
    kind: e.kind as AutoTradeEvent['kind'],
    mint: e.mint,
    symbol: e.symbol,
    rule: e.rule,
    message: e.message,
    signature: e.signature,
  };
}

/** A ratio that never returns Infinity or NaN. */
function ratio(a: number, b: number): number {
  if (!(b > 0)) return 1;
  return Math.round((a / b) * 10_000) / 10_000;
}

/**
 * The row's risk chip.
 *
 * `unknown` IS A REAL LEVEL and is the honest answer for anything unscored.
 * Defaulting an unscored token to `safe` would put a green chip on a token
 * nobody has looked at, which is the worst available lie here.
 */
function riskOf(t: Token): TokenSummary['risk'] {
  if (t.score === null) return 'unknown';
  if (t.clamped !== null || t.score < 32) return 'danger';
  if (t.score < 60) return 'warning';
  return 'safe';
}
