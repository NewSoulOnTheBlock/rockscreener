import { MIN_COVERAGE_FOR_VERDICT, type EntryRules, type RockTier } from '@rockscreener/shared';

/**
 * Whether a token passes a user's entry rules — and if not, WHICH rule refused
 * it and in what words.
 *
 * THE REFUSAL IS THE PRODUCT, not a side effect of it. "Why didn't it buy that
 * one" is the first question anybody asks of an automated buyer, and an engine
 * that cannot answer it is one they switch off after a day. So every gate
 * returns the rule's own path (`entry.maxBundledPct`) and a sentence carrying
 * BOTH numbers, and the engine records it as a `skipped` event whether or not
 * anyone is watching.
 *
 * PURE, AND THAT IS WHAT MAKES IT DEFENSIBLE. No database, no clock, no chain.
 * Every rule here is somebody's money, and a rule that can only be verified by
 * running the engine against production is a rule nobody can check.
 *
 * ORDER IS CHEAPEST-FIRST. The gates that need nothing but the token row run
 * before the ones that need the grade, so the common rejection is also the
 * cheapest one.
 */

export interface EntryCandidate {
  mint: string;
  symbol: string;
  launchpad: string;
  /** Null when the scorer has not produced a number yet. */
  score: number | null;
  tier: RockTier | null;
  coverage: number | null;
  liquidityUsd: number;
  marketCapUsd: number;
  ageSeconds: number;
  holderCount: number | null;
  traders24h: number | null;
  top10Pct: number | null;
  bundledPct: number | null;
  clusteredPct: number | null;
  creatorPct: number | null;
  creatorLinkedPct: number | null;
  /** Share of the LP locked or burnt, 0..100. Null when unread. */
  lpLockedPct: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  transferFeeBps: number | null;
  /** The sell check's verdict. Null is NOT a pass. */
  sellOk: boolean | null;
  sellImpactPct: number | null;
  creator: string | null;
  creatorReputation: string | null;
  /** Seconds since this user last closed a position in this token, or null. */
  secondsSinceLastExit: number | null;
}

export type EntryDecision = { ok: true } | { ok: false; rule: string; message: string };

function no(rule: string, message: string): EntryDecision {
  return { ok: false, rule, message };
}

export function evaluateEntry(t: EntryCandidate, r: EntryRules): EntryDecision {
  // --- the grade, which is the premise of the whole engine -----------------
  if (t.score === null || t.tier === null) {
    return no('entry.minScore', `${t.symbol} has not been scored yet.`);
  }

  /*
   * A PROVISIONAL SCORE IS NOT A LOW SCORE, and it must not be treated as one.
   * It means too little of the token could be measured to say anything — which
   * is the state of every token in its first minutes, exactly when an automated
   * buyer would most like to act. Refusing here is the difference between an
   * engine that buys on evidence and one that buys on being early.
   */
  if ((t.coverage ?? 0) < MIN_COVERAGE_FOR_VERDICT) {
    return no(
      'entry.coverage',
      `${t.symbol}'s grade is provisional — only ${Math.round(t.coverage ?? 0)}% of it could be measured.`
    );
  }
  if (t.score < r.minScore) {
    return no('entry.minScore', `Grade ${t.score} is below your floor of ${r.minScore}.`);
  }
  if (r.allowedTiers.length > 0 && !r.allowedTiers.includes(t.tier)) {
    return no('entry.allowedTiers', `Tier "${t.tier}" is not one you buy.`);
  }
  if (r.allowedLaunchpads.length > 0 && !r.allowedLaunchpads.includes(t.launchpad)) {
    return no('entry.allowedLaunchpads', `${t.launchpad} is not one of your launchpads.`);
  }

  // --- the shape of the market ---------------------------------------------
  if (r.minLiquidityUsd !== null && t.liquidityUsd < r.minLiquidityUsd) {
    return no(
      'entry.minLiquidityUsd',
      `Liquidity is $${Math.round(t.liquidityUsd).toLocaleString('en-US')}, below your $${r.minLiquidityUsd.toLocaleString('en-US')}.`
    );
  }
  if (r.minMarketCapUsd !== null && t.marketCapUsd < r.minMarketCapUsd) {
    return no(
      'entry.minMarketCapUsd',
      `Market cap $${Math.round(t.marketCapUsd).toLocaleString('en-US')} is below your floor.`
    );
  }
  if (r.maxMarketCapUsd !== null && t.marketCapUsd > r.maxMarketCapUsd) {
    return no(
      'entry.maxMarketCapUsd',
      `Market cap $${Math.round(t.marketCapUsd).toLocaleString('en-US')} is above your ceiling.`
    );
  }
  if (r.minAgeSeconds !== null && t.ageSeconds < r.minAgeSeconds) {
    return no('entry.minAgeSeconds', `Only ${Math.round(t.ageSeconds)}s old; you wait ${r.minAgeSeconds}s.`);
  }
  if (r.maxAgeSeconds !== null && t.ageSeconds > r.maxAgeSeconds) {
    return no(
      'entry.maxAgeSeconds',
      `Older than the ${Math.round(r.maxAgeSeconds / 3600)}h you buy within.`
    );
  }

  /*
   * HOLDER AND TRADER COUNTS SKIP ON NULL, and that is the opposite of the rule
   * below — deliberately. A null here belongs to OUR pipeline being behind: the
   * holder sync has not run yet, and the token is not misrepresenting itself.
   * A null in the launch analysis is a fact about the TOKEN that nobody has
   * established, and buying it is betting on which way it falls.
   */
  if (r.minHolders !== null && t.holderCount !== null && t.holderCount < r.minHolders) {
    return no('entry.minHolders', `${t.holderCount} holders, below your ${r.minHolders}.`);
  }
  if (r.minUniqueTraders !== null && t.traders24h !== null && t.traders24h < r.minUniqueTraders) {
    return no(
      'entry.minUniqueTraders',
      `${t.traders24h} distinct wallets traded it, below your ${r.minUniqueTraders}.`
    );
  }

  // --- the launch-analysis gates. NULL FAILS THESE. -------------------------
  const gate = (
    rule: string,
    limit: number | null,
    value: number | null,
    label: string
  ): EntryDecision | null => {
    if (limit === null) return null;
    if (value === null) return no(rule, `${label} could not be established for ${t.symbol}.`);
    if (value > limit) return no(rule, `${label} is ${value.toFixed(1)}%, above your ${limit}%.`);
    return null;
  };

  const launchGate =
    gate('entry.maxBundledPct', r.maxBundledPct, t.bundledPct, 'Supply taken in the first traded slot') ??
    gate('entry.maxClusteredPct', r.maxClusteredPct, t.clusteredPct, 'Supply behind one funding source') ??
    gate(
      'entry.maxCreatorPct',
      r.maxCreatorPct,
      // The creator's own bag PLUS the wallets they funded, because splitting
      // the two is the entire technique this number exists to defeat.
      t.creatorPct === null ? null : t.creatorPct + (t.creatorLinkedPct ?? 0),
      'Supply held by the creator and wallets they funded'
    ) ??
    gate('entry.maxTop10Pct', r.maxTop10Pct, t.top10Pct, 'Top-ten holder concentration');

  if (launchGate) return launchGate;

  return mintGates(t, r) ?? creatorGates(t, r) ?? { ok: true };
}

function mintGates(t: EntryCandidate, r: EntryRules): EntryDecision | null {
  /*
   * THE FREEZE AUTHORITY IS THE ONE THAT CANNOT BE SIMULATED AWAY. Every check
   * passes, the buy fills, the balance arrives — and then the account is frozen.
   * `!== true` rather than `=== false`: an unread mint account is not a revoked
   * one.
   */
  if (r.requireFreezeRevoked && t.freezeAuthorityRevoked !== true) {
    return no(
      'entry.requireFreezeRevoked',
      t.freezeAuthorityRevoked === false
        ? 'The freeze authority is still live.'
        : 'Nothing has confirmed the freeze authority is revoked.'
    );
  }
  if (r.requireMintRevoked && t.mintAuthorityRevoked !== true) {
    return no(
      'entry.requireMintRevoked',
      t.mintAuthorityRevoked === false
        ? 'Supply can still be minted.'
        : 'Nothing has confirmed the mint authority is revoked.'
    );
  }
  if (r.requireLpSecured && (t.lpLockedPct === null || t.lpLockedPct < 90)) {
    return no(
      'entry.requireLpSecured',
      t.lpLockedPct === null
        ? 'Nothing establishes whether the liquidity is locked.'
        : `Only ${t.lpLockedPct.toFixed(0)}% of the liquidity is locked or burnt.`
    );
  }
  if (r.maxTransferFeeBps !== null) {
    if (t.transferFeeBps === null) {
      return no('entry.maxTransferFeeBps', 'The transfer fee has not been read for this token.');
    }
    if (t.transferFeeBps > r.maxTransferFeeBps) {
      return no(
        'entry.maxTransferFeeBps',
        `A ${(t.transferFeeBps / 100).toFixed(2)}% transfer fee is above your limit.`
      );
    }
  }

  /*
   * THE RULE THAT MATTERS MOST. It refuses not only a token that FAILED the
   * sell check but one the check could not answer for — which, minutes after a
   * launch, is the common case. Treating "we could not check" as a pass is
   * precisely how an automated buyer walks into the one trade it exists to
   * avoid.
   */
  if (r.requireSellConfirmed && t.sellOk !== true) {
    return no(
      'entry.requireSellConfirmed',
      t.sellOk === false
        ? 'No route exists to sell a real position.'
        : 'Nothing has confirmed this token can be sold yet.'
    );
  }
  if (
    r.maxSellImpactPct !== null &&
    t.sellImpactPct !== null &&
    t.sellImpactPct > r.maxSellImpactPct
  ) {
    return no(
      'entry.maxSellImpactPct',
      `A real-size exit would cost ${t.sellImpactPct.toFixed(1)}%, above your ${r.maxSellImpactPct}%.`
    );
  }
  return null;
}

function creatorGates(t: EntryCandidate, r: EntryRules): EntryDecision | null {
  if (
    t.creatorReputation !== null &&
    (r.blockCreatorReputation as string[]).includes(t.creatorReputation)
  ) {
    return no('entry.blockCreatorReputation', `The creator's record reads "${t.creatorReputation}".`);
  }
  if (t.creator !== null && r.blockedCreators.includes(t.creator)) {
    return no('entry.blockedCreators', 'You have blocked this creator.');
  }
  if (t.secondsSinceLastExit !== null && t.secondsSinceLastExit < r.reentryCooldownSeconds) {
    return no(
      'entry.reentryCooldownSeconds',
      `You exited this token ${Math.round(t.secondsSinceLastExit / 60)}m ago; your cooldown is ${Math.round(r.reentryCooldownSeconds / 60)}m.`
    );
  }
  return null;
}
