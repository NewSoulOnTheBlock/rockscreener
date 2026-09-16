import {
  ROCK_WEIGHTS,
  rockTier,
  type CreatorHistory,
  type Finding,
  type LaunchAnalysis,
  type RockPillars,
  type RockScore,
  type SellCheck,
} from '@rockscreener/shared';
import {
  boundScore as bound,
  scoreDistribution,
  scoreLaunch,
  scoreLiquidity,
  scoreMomentum,
  scorePresence,
  scoreSafety,
  type DistributionInput,
  type LiquidityInput,
  type MomentumInput,
  type PresenceInput,
  type SafetyInput,
} from './pillars.js';

/**
 * Combining five pillars into one number, and refusing to when it would lie.
 *
 * TWO RULES DO ALL THE WORK HERE.
 *
 * THE WEIGHTED SUM IS OVER THE PILLARS THAT WERE MEASURED, renormalised to
 * their own weights. A token with no holder data scored on four pillars is
 * scored honestly on four pillars; the alternative — substituting a neutral
 * value for the missing one — invents a fact and buries it inside an average
 * where nobody can see it. `coverage` reports how much of the token the number
 * actually describes, and everything downstream respects it.
 *
 * A CRITICAL FINDING CLAMPS THE TOTAL rather than being averaged. This is the
 * rule that makes the grade usable: a token with locked liquidity, a fair
 * distribution, good momentum and a known launchpad whose FREEZE AUTHORITY is
 * still live would otherwise score in the sixties, because four fifths of it is
 * genuinely fine. Your account can still be frozen. A weighted average cannot
 * express "one of these disqualifies the rest", so the clamp does it explicitly
 * and the card says so.
 */

/** Ceilings a critical finding pulls the total down to, worst first. */
const CLAMPS: { code: string; at: number; reason: string }[] = [
  { code: 'no_exit', at: 5, reason: 'No route exists to sell a real position.' },
  { code: 'rugged', at: 5, reason: 'This token has already been pulled.' },
  { code: 'punitive_fee', at: 12, reason: 'The transfer fee is high enough to prevent selling.' },
  {
    code: 'freeze_authority',
    at: 18,
    reason: 'The freeze authority is live — your account can be frozen after you buy.',
  },
  { code: 'serial_rugger', at: 20, reason: 'This creator has pulled most of their previous launches.' },
  { code: 'lp_unlocked', at: 25, reason: 'The liquidity can be removed in one transaction.' },
  { code: 'mintable', at: 32, reason: 'Supply can still be minted at will.' },
  {
    code: 'funding_cluster',
    at: 40,
    reason: 'A quarter of supply or more sits behind one funding source.',
  },
  { code: 'bundled', at: 45, reason: 'Most of the supply was taken before anyone could react.' },
  { code: 'creator_bag', at: 45, reason: 'The creator holds a fifth of the supply or more.' },
  { code: 'creator_linked', at: 42, reason: 'Wallets the creator funded hold a fifth of the supply.' },
];

/**
 * Findings that clamp ONLY when they are also extreme.
 *
 * `bundled`, `funding_cluster` and `creator_bag` all fire at moderate levels
 * too, where they are worth points rather than a ceiling — so the clamp checks
 * the SEVERITY the pillar assigned rather than the bare presence of the code.
 * Without this a 16%-bundled token would be capped at 45 alongside a
 * 60%-bundled one, and the grade would stop distinguishing them at exactly the
 * range where the distinction matters most.
 */
function clampApplies(f: Finding): boolean {
  return f.severity === 'critical';
}

export interface ScoreRequest {
  mint: string;
  safety: SafetyInput | null;
  liquidity: LiquidityInput | null;
  distribution: DistributionInput | null;
  momentum: MomentumInput | null;
  launch: LaunchAnalysis;
  creator: CreatorHistory | null;
  sell: SellCheck;
  presence: PresenceInput | null;
  previousScore: number | null;
}

export function computeScore(req: ScoreRequest): RockScore {
  const safety = req.safety ? scoreSafety(req.safety) : { score: null, findings: [] };
  const liquidity = req.liquidity ? scoreLiquidity(req.liquidity) : { score: null, findings: [] };
  const distribution = req.distribution
    ? scoreDistribution(req.distribution)
    : { score: null, findings: [] };
  const launch = scoreLaunch(req.launch, req.creator);
  const momentum = req.momentum ? scoreMomentum(req.momentum) : { score: null, findings: [] };
  const presence = scorePresence(req.presence);

  const pillars: RockPillars = {
    safety: safety.score,
    liquidity: liquidity.score,
    distribution: distribution.score,
    launch: launch.score,
    momentum: momentum.score,
  };

  const findings = [
    ...safety.findings,
    ...launch.findings,
    ...liquidity.findings,
    ...distribution.findings,
    ...momentum.findings,
    ...presence.findings,
  ].sort(bySeverity);

  // Weighted over what was measured, renormalised to those weights alone.
  let weighted = 0;
  let weightUsed = 0;
  let weightTotal = 0;
  for (const key of Object.keys(ROCK_WEIGHTS) as (keyof RockPillars)[]) {
    const w = ROCK_WEIGHTS[key];
    weightTotal += w;
    const value = pillars[key];
    if (value === null) continue;
    weighted += value * w;
    weightUsed += w;
  }

  /*
   * THE PRESENCE ADJUSTMENT LANDS HERE: after the weighting, before the clamps.
   *
   * After the weighting, because it is not a pillar and must not be
   * renormalised as though a token nobody had checked were missing a reading.
   *
   * Before the clamps, because a clamp is a ceiling on a token with something
   * critically wrong with it, and three points for a filled profile must not be
   * able to lift a frozen-authority token back over that ceiling.
   *
   * COVERAGE IS DELIBERATELY UNAFFECTED. Coverage answers "how much of this
   * token could be measured", over the five pillars. Letting a DexScreener
   * lookup raise it would mean a token with no safety and no launch reading
   * reporting itself as better established because somebody bought a profile.
   */
  const raw = weightUsed > 0 ? bound(weighted / weightUsed + presence.delta) : 0;
  const coverage = weightTotal > 0 ? (weightUsed / weightTotal) * 100 : 0;

  // The lowest applicable ceiling wins: two critical findings do not cancel out.
  let clamped: RockScore['clamped'] = null;
  let score = raw;
  for (const rule of CLAMPS) {
    const hit = findings.find((f) => f.code === rule.code && clampApplies(f));
    if (hit && score > rule.at) {
      score = rule.at;
      clamped = { at: rule.at, reason: rule.reason };
    }
  }

  const rounded = Math.round(score * 10) / 10;
  return {
    mint: req.mint,
    score: rounded,
    tier: rockTier(rounded),
    pillars,
    coverage: Math.round(coverage),
    clamped,
    findings,
    launch: req.launch,
    creator: req.creator,
    sell: req.sell,
    computedAt: new Date().toISOString(),
    previousScore: req.previousScore,
  };
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  good: 4,
};

/**
 * Worst first, and the positives LAST rather than interleaved.
 *
 * The card renders this list in order and truncates it, so the ordering decides
 * what a person actually sees in the two lines they read. A layout that mixed
 * "supply is fixed" in among the warnings would spend one of those lines on
 * reassurance.
 */
function bySeverity(a: Finding, b: Finding): number {
  const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return d !== 0 ? d : Math.abs(b.delta) - Math.abs(a.delta);
}

/** The single line a screener row shows. Null when nothing is wrong. */
export function topWarning(findings: Finding[]): string | null {
  return findings.find((f) => f.severity !== 'good' && f.severity !== 'low')?.message ?? null;
}

/**
 * A creator's record, from what this index has actually seen.
 *
 * THE THRESHOLDS ARE DELIBERATELY CONSERVATIVE AND A FIRST LAUNCH RETURNS
 * `reputation: null`. One launch is not a record in either direction, and a
 * system that called a first-time creator "neutral" would be making a claim it
 * has no evidence for — which matters, because `blockCreatorReputation` is a
 * gate somebody's money passes through.
 */
export function creatorReputation(
  tokensLaunched: number,
  rugged: number,
  survived: number
): CreatorHistory['reputation'] {
  if (tokensLaunched < 2) return null;

  const ruggedShare = rugged / tokensLaunched;
  if (tokensLaunched >= 3 && ruggedShare >= 0.6) return 'serial_rugger';
  if (ruggedShare >= 0.34) return 'suspect';

  /*
   * THE TOKEN FACTORY, and it took live data to notice the gap.
   *
   * `rugged` is deliberately narrow — a token that reached a real valuation and
   * then lost its liquidity — so a creator whose launches never go anywhere at
   * all rugs nothing by that definition. One address in this index has launched
   * eighty-one tokens with a single rug and not one survivor, and it read as
   * "neutral", which is a verdict nobody would agree with.
   *
   * Eight launches with NOTHING still trading with depth behind it is not a
   * track record of bad luck, it is a description of the business. It is
   * `suspect` rather than `serial_rugger` because the stronger label should
   * stay reserved for demonstrably pulling liquidity out of tokens people were
   * actually in.
   */
  if (tokensLaunched >= 8 && survived === 0) return 'suspect';

  if (tokensLaunched >= 3 && survived / tokensLaunched >= 0.5) return 'trusted';
  return 'neutral';
}
