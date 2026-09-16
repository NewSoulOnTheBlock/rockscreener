import type { CreatorHistory, Finding, LaunchAnalysis, SellCheck } from '@rockscreener/shared';

/**
 * The five pillars, as PURE FUNCTIONS over already-gathered facts.
 *
 * NOTHING IN THIS FILE READS A DATABASE, AN RPC OR A CLOCK. That is what makes
 * the grade reviewable: every number below can be argued with in a test that
 * states its inputs, and a weight change can be justified by re-running the
 * same inputs rather than by watching production for a week. Gathering is
 * `gather.ts`; this file only decides what the facts MEAN.
 *
 * EVERY PILLAR RETURNS null WHEN IT HAS NO INPUTS. Not zero, not fifty. A
 * scorer that quietly substitutes a neutral 50 for "we do not know" produces
 * confident-looking numbers for tokens nobody has checked — which is exactly
 * what made the product this replaces useless: it graded everything, so its
 * grade meant nothing.
 *
 * THE SCALE IS 0..100 AND 100 IS UNREACHABLE IN PRACTICE. Each pillar starts
 * well below its ceiling and is pushed up only by POSITIVE findings, so a high
 * score requires facts rather than the absence of bad ones. A token nobody has
 * found anything wrong with is not the same as a good token, and a scorer that
 * starts at 100 and subtracts says it is.
 */

export interface PillarResult {
  score: number | null;
  findings: Finding[];
}

const NONE: PillarResult = { score: null, findings: [] };

function bound(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Linear interpolation between two anchors, clamped OUTSIDE them.
 *
 * Used instead of thresholds wherever a metric is continuous. A hard cut at 25%
 * bundled makes 24.9% and 25.1% different products; in reality they are the
 * same token, and a scorer that disagrees teaches people to game the edge
 * rather than to read the number.
 *
 * IT CLAMPS THE POSITION, NOT THE RESULT. The output here is a DELTA and is
 * frequently negative — running it through a 0..100 bound would silently zero
 * the whole bad half of every penalty ramp, and the pillar would stop
 * distinguishing a 25% bundle from a 5% one at exactly the range where it
 * matters most. The caller bounds the pillar once, at the end.
 */
function ramp(value: number, goodAt: number, badAt: number, goodScore: number, badScore: number): number {
  if (goodAt === badAt) return value <= goodAt ? goodScore : badScore;
  const t = Math.max(0, Math.min(1, (value - goodAt) / (badAt - goodAt)));
  return goodScore + (badScore - goodScore) * t;
}

function finding(
  code: string,
  pillar: Finding['pillar'],
  severity: Finding['severity'],
  message: string,
  delta: number
): Finding {
  return { code, pillar, severity, message, delta: Math.round(delta * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Safety — what the mint permits, and whether anybody can get out
// ---------------------------------------------------------------------------

export interface SafetyInput {
  /** NULL = the mint account has never been read. */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  metadataMutable: boolean | null;
  /** Token-2022 transfer fee, basis points. NULL when unread; 0 IS a reading. */
  transferFeeBps: number | null;
  sell: SellCheck;
  /** RugCheck's own `rugged` flag. */
  rugged: boolean | null;
  /** Risk entries at `danger`/`error` level, by name. */
  criticalRisks: string[];
  launchpad: string;
}

/**
 * Transfer fees above this are a toll booth rather than a fee. Ten percent is
 * already punitive; past twenty the token exists to take the money.
 */
const PUNITIVE_FEE_BPS = 2_000;

export function scoreSafety(input: SafetyInput): PillarResult {
  const findings: Finding[] = [];
  /*
   * THE BASE AND EVERY BONUS BELOW WERE RECALIBRATED AGAINST LIVE DATA, and the
   * measurement is the argument.
   *
   * At the first calibration a clean token reached 98: base 38, plus 26 for the
   * sell check and 34 for revoked authorities, no fee, frozen metadata and a
   * known launchpad. Half the index — 1,939 of 3,989 scored tokens — sat at 95
   * or above, and a pillar carrying 28% of the grade was at its ceiling for
   * every second token. It had stopped discriminating.
   *
   * The cause is that those 34 points are very nearly FREE ON THIS CHAIN.
   * pump.fun revokes both authorities by construction, charges no transfer fee,
   * and is a known launchpad — so essentially every token in the index collects
   * all of them, and a fact true of 99% of a population separates nothing.
   *
   * So the free facts are worth a token of their value and THE SELL CHECK
   * CARRIES THE PILLAR. It is the one reading that is genuinely expensive to
   * obtain, genuinely varies, and genuinely decides whether somebody gets their
   * money back. A clean-but-unchecked token now scores 47; the same token with
   * a confirmed exit scores 77. That thirty-point gap is the pillar's whole
   * job.
   */
  let score = 28;
  let measured = false;
  /**
   * Set when the token has been shown to be unsellable or already pulled.
   *
   * It SHORT-CIRCUITS the pillar rather than subtracting from it: a honeypot
   * with revoked authorities, no fee and a known launchpad would otherwise
   * collect +30 of bonuses on top of its zero and land in the thirties — a
   * score that invites somebody to weigh it against other things. There is
   * nothing to weigh.
   */
  let disqualified = false;

  // --- can it be sold? ----------------------------------------------------
  if (input.sell.ok === true) {
    measured = true;
    // The differentiator, and weighted like one.
    score += 30;
    findings.push(
      finding(
        'sell_confirmed',
        'safety',
        'good',
        input.sell.via === 'observed_sells'
          ? 'Unrelated wallets have actually sold this in the last few hours.'
          : 'A real-size exit routes against the live market.',
        -26
      )
    );
    /*
     * A ROUTE THAT EXISTS BUT COSTS EVERYTHING IS NOT AN EXIT. This is the
     * Solana-shaped version of a sell tax: nothing in the contract forbids
     * selling, and the pool is so thin that a real position is worth a
     * fraction of its mark on the way out.
     */
    if (input.sell.impactPct !== null && input.sell.impactPct > 10) {
      const penalty = ramp(input.sell.impactPct, 10, 40, 5, 28);
      score -= penalty;
      findings.push(
        finding(
          'thin_exit',
          'safety',
          input.sell.impactPct > 25 ? 'high' : 'medium',
          `A real-size exit would move the price ${input.sell.impactPct.toFixed(1)}% against you.`,
          penalty
        )
      );
    }
  } else if (input.sell.ok === false) {
    measured = true;
    disqualified = true;
    findings.push(
      finding(
        'no_exit',
        'safety',
        'critical',
        'No route exists to sell a real position back into SOL. Nobody is getting out.',
        100
      )
    );
  } else {
    findings.push(
      finding(
        'sell_unchecked',
        'safety',
        'medium',
        'The sell check has not run yet, so nothing confirms this can be sold.',
        0
      )
    );
  }

  if (input.rugged === true) {
    measured = true;
    disqualified = true;
    findings.push(
      finding('rugged', 'safety', 'critical', 'This token has already been pulled.', 100)
    );
  }

  // --- what the mint permits ----------------------------------------------
  /*
   * THE FREEZE AUTHORITY IS THE SOLANA-NATIVE HONEYPOT and it is weighted
   * accordingly. There is no equivalent on an EVM chain: the buy succeeds, the
   * balance arrives, every simulation passes — and then the holder's token
   * account is frozen and the position is gone. A sell check cannot catch it,
   * because at the moment of checking the token genuinely is sellable.
   */
  /*
   * The revocations below are still worth POINTS rather than nothing, because
   * their ABSENCE is catastrophic — a live freeze authority is a 40-point
   * penalty and a clamp. What changed is the reward for having them, which on
   * this chain is the default state rather than an achievement.
   */
  if (input.freezeAuthorityRevoked === false) {
    measured = true;
    score -= 40;
    findings.push(
      finding(
        'freeze_authority',
        'safety',
        'critical',
        'The freeze authority is still live — your token account can be frozen after you buy.',
        40
      )
    );
  } else if (input.freezeAuthorityRevoked === true) {
    measured = true;
    score += 5;
    findings.push(
      finding('freeze_revoked', 'safety', 'good', 'The freeze authority is revoked.', -5)
    );
  }

  if (input.mintAuthorityRevoked === false) {
    measured = true;
    score -= 32;
    findings.push(
      finding(
        'mintable',
        'safety',
        'critical',
        'Supply can still be minted. Everything you hold can be diluted at will.',
        32
      )
    );
  } else if (input.mintAuthorityRevoked === true) {
    measured = true;
    score += 5;
    findings.push(finding('supply_fixed', 'safety', 'good', 'Supply is fixed — the mint authority is revoked.', -5));
  }

  if (input.transferFeeBps !== null) {
    measured = true;
    if (input.transferFeeBps >= PUNITIVE_FEE_BPS) {
      score -= 45;
      findings.push(
        finding(
          'punitive_fee',
          'safety',
          'critical',
          `A ${(input.transferFeeBps / 100).toFixed(1)}% transfer fee is charged on every move — high enough that taking it is the point.`,
          45
        )
      );
    } else if (input.transferFeeBps > 0) {
      const penalty = ramp(input.transferFeeBps, 0, PUNITIVE_FEE_BPS, 0, 30);
      score -= penalty;
      findings.push(
        finding(
          'transfer_fee',
          'safety',
          input.transferFeeBps >= 300 ? 'high' : 'medium',
          `A ${(input.transferFeeBps / 100).toFixed(2)}% fee is taken on every transfer, including your exit.`,
          penalty
        )
      );
    } else {
      score += 2;
    }
  }

  /*
   * MUTABLE METADATA IS A SMALL PENALTY, NOT A CRITICAL ONE, and the size is
   * the argument. It cannot take anybody's money: the supply, the authorities
   * and the liquidity are all unaffected. What it permits is a token renaming
   * itself into something else after people have bought it, which is a real
   * pattern and a modest one.
   */
  if (input.metadataMutable === true) {
    measured = true;
    score -= 6;
    findings.push(
      finding(
        'metadata_mutable',
        'safety',
        'low',
        'The name, symbol and artwork can still be changed by whoever holds the update authority.',
        6
      )
    );
  } else if (input.metadataMutable === false) {
    measured = true;
    score += 2;
  }

  /*
   * A KNOWN LAUNCHPAD IS A REAL SAFETY FACT ON THIS CHAIN. pump.fun and its
   * peers deploy a FIXED mint configuration: no mint authority, no freeze
   * authority, no transfer hook, and a curve whose code is the same for every
   * token on it. A token provably out of that factory has had its entire
   * contract surface decided by code that can be read.
   *
   * It is a bonus rather than a pass: the template guarantees the mint and
   * guarantees nothing at all about who holds the supply. Those are the other
   * four pillars, and they are why this one cannot carry a token on its own.
   */
  if (input.launchpad !== 'unknown' && input.launchpad !== '') {
    measured = true;
    score += 5;
    findings.push(
      finding(
        'known_launchpad',
        'safety',
        'good',
        `Launched through ${input.launchpad}, whose mint configuration is fixed and public.`,
        -5
      )
    );
  }

  for (const risk of input.criticalRisks.slice(0, 3)) {
    measured = true;
    score -= 10;
    findings.push(finding(`risk_${slug(risk)}`, 'safety', 'high', risk, 10));
  }

  if (!measured) return NONE;
  return { score: disqualified ? 0 : bound(score), findings };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
}

// ---------------------------------------------------------------------------
// Liquidity — whether the exit exists
// ---------------------------------------------------------------------------

export interface LiquidityInput {
  liquidityUsd: number;
  marketCapUsd: number;
  /** Share of the LP locked or burnt, 0..100. NULL when unread. */
  lpLockedPct: number | null;
  marketCount: number;
  /** Still on a bonding curve, where liquidity means something different. */
  bonding: boolean;
  /** NULL when the curve account has not been read. See below. */
  progressBps: number | null;
}

export function scoreLiquidity(input: LiquidityInput): PillarResult {
  const findings: Finding[] = [];

  /*
   * A TOKEN ON A CURVE HAS NO LP TO LOCK AND NO DEPTH TO MEASURE — the curve IS
   * the liquidity, and its only meaningful reading is how far it has filled.
   * Scoring it on the pool metrics below would mark every bonding token as
   * having no liquidity, which is true of the pool and false of the token.
   */
  if (input.bonding) {
    /*
     * A CURVE NOBODY HAS READ IS AN UNMEASURED PILLAR, not a curve at zero.
     *
     * Progress is the ONLY liquidity reading a bonding token has, so without it
     * there is nothing here to score — and scoring it as 0% would put every
     * freshly discovered token at the bottom of the liquidity pillar on the
     * strength of a reading that was never taken.
     */
    if (input.progressBps === null) return NONE;

    const progress = input.progressBps / 100;
    findings.push(
      finding(
        'on_curve',
        'liquidity',
        progress > 50 ? 'good' : 'low',
        `Still on the bonding curve, ${progress.toFixed(0)}% of the way to graduating.`,
        0
      )
    );

    /*
     * PROGRESS IS MOST OF IT, AND DEPTH IS THE REST.
     *
     * The curve's own SOL reserve is now read out of the curve account, so a
     * bonding token finally has a real exit size rather than only a percentage.
     * They are not the same reading: progress says how close it is to
     * graduating, the reserve says what a sell can actually be filled against
     * today. A curve 30% of the way with eight SOL in it and one 30% of the way
     * with one SOL in it are different trades.
     *
     * Depth is capped at a third of the pillar because on a curve it is
     * DERIVED from progress rather than independent of it, and double-counting
     * one fact is how a pillar comes to look more informative than it is.
     */
    const base = ramp(progress, 100, 0, 58, 20);
    const depth = input.liquidityUsd > 0 ? ramp(input.liquidityUsd, 15_000, 500, 18, 0) : 0;
    return { score: bound(base + depth), findings };
  }

  /*
   * A MEASURED ZERO IS A READING, AND A DAMNING ONE.
   *
   * This function is only called when the market sync actually got a pair back
   * (see `gather.ts`), so a zero here means "there is a pool and it is empty",
   * not "nobody looked". Returning null for it — which an earlier version did —
   * renormalised the worst pillar out of the average and made dead tokens score
   * HIGHER than thin ones. A token with a pool and no liquidity in it is the
   * clearest possible statement that there is no exit.
   */
  if (input.liquidityUsd <= 0) {
    findings.push(
      finding(
        'no_liquidity',
        'liquidity',
        'critical',
        'The pool is empty. There is nothing on the other side of a sell.',
        100
      )
    );
    return { score: 0, findings };
  }

  let score = 38;

  // Depth in dollars. $50k is a market; $2k is four trades from nothing.
  const depth = ramp(input.liquidityUsd, 50_000, 2_000, 34, 0);
  score += depth;
  if (input.liquidityUsd < 8_000) {
    findings.push(
      finding(
        'thin_liquidity',
        'liquidity',
        input.liquidityUsd < 3_000 ? 'high' : 'medium',
        `Only $${Math.round(input.liquidityUsd).toLocaleString('en-US')} of liquidity — a single exit moves the price.`,
        34 - depth
      )
    );
  }

  /*
   * LIQUIDITY AGAINST VALUATION — the ratio that actually predicts what happens
   * when people want out. A $2M token with $20k behind it is a 1% ratio: the
   * first person to sell 2% of the supply finds there is nothing there. Ten
   * percent is healthy for a launch.
   */
  if (input.marketCapUsd > 0) {
    const ratio = (input.liquidityUsd / input.marketCapUsd) * 100;
    const ratioScore = ramp(ratio, 10, 1, 22, 0);
    score += ratioScore;
    if (ratio < 3) {
      findings.push(
        finding(
          'liquidity_ratio',
          'liquidity',
          'high',
          `Liquidity is ${ratio.toFixed(1)}% of the valuation being asked — the exit is far smaller than the price implies.`,
          22 - ratioScore
        )
      );
    }
  }

  if (input.lpLockedPct === null) {
    score -= 8;
    findings.push(
      finding('lp_unknown', 'liquidity', 'medium', 'Nothing establishes whether the liquidity is locked.', 8)
    );
  } else if (input.lpLockedPct >= 95) {
    score += 16;
    findings.push(
      finding(
        'lp_secured',
        'liquidity',
        'good',
        'The liquidity is locked or burnt — it cannot be pulled.',
        -16
      )
    );
  } else if (input.lpLockedPct >= 50) {
    score += 6;
    findings.push(
      finding(
        'lp_partial',
        'liquidity',
        'medium',
        `Only ${input.lpLockedPct.toFixed(0)}% of the liquidity is locked; the rest can be removed.`,
        6
      )
    );
  } else {
    score -= 28;
    findings.push(
      finding(
        'lp_unlocked',
        'liquidity',
        'critical',
        'The liquidity is neither locked nor burnt. Whoever holds it can remove it in one transaction.',
        28
      )
    );
  }

  if (input.marketCount > 1) score += 4;

  return { score: bound(score), findings };
}

// ---------------------------------------------------------------------------
// Distribution — who holds it
// ---------------------------------------------------------------------------

export interface DistributionInput {
  /** Top ten REAL holders: AMM vaults, lockers and burn already excluded. */
  top10Pct: number | null;
  creatorPct: number | null;
  holderCount: number | null;
}

/**
 * Below this many holders, CONCENTRATION IS NOT A READING.
 *
 * A token with three holders has a trivially low top-ten share, because there
 * is nothing to concentrate — and an earlier version of this function scored
 * exactly that case at 97/100 and called it beautifully distributed. It is not
 * a well-distributed token; it is a token nobody holds.
 *
 * So below the floor the pillar is scored on HOLDER COUNT ALONE, which is the
 * only thing that means anything at that size, and neither the concentration
 * nor the creator's share is credited. Twenty-five is where the top ten stop
 * being most of the holders there are.
 */
const MIN_HOLDERS_FOR_CONCENTRATION = 25;

export function scoreDistribution(input: DistributionInput): PillarResult {
  if (input.top10Pct === null && input.holderCount === null) return NONE;

  const findings: Finding[] = [];
  /*
   * RECALIBRATED FOR THE SAME REASON AS SAFETY. The first calibration summed to
   * 117 before clipping, so 1,035 of 3,989 scored tokens sat at 95 or above and
   * the pillar spent most of its range against a ceiling.
   *
   * HOLDER COUNT IS NOW THE LARGEST COMPONENT, which is the right emphasis: a
   * low top-ten share is cheap to arrange by splitting a bag across wallets,
   * and two thousand genuine holders is the single hardest thing on this list
   * to fake.
   */
  let score = 20;

  /*
   * A token too small for concentration to mean anything is scored on its
   * holder count and nothing else. It still produces a real number — three
   * holders IS a fact about distribution — it simply refuses to award the
   * points that a low top-ten share would otherwise earn.
   */
  const tooFewToRead =
    input.holderCount !== null && input.holderCount < MIN_HOLDERS_FOR_CONCENTRATION;

  if (tooFewToRead) {
    const holders = ramp(input.holderCount!, MIN_HOLDERS_FOR_CONCENTRATION, 1, 28, 0);
    findings.push(
      finding(
        'too_few_to_read',
        'distribution',
        input.holderCount! < 10 ? 'high' : 'medium',
        `Only ${input.holderCount} holders — too few for concentration to mean anything yet.`,
        28 - holders
      )
    );
    return { score: bound(score + holders), findings };
  }

  /*
   * TOP-TEN CONCENTRATION, WITH THE POOLS ALREADY OUT. The exclusion matters
   * more than the thresholds: an AMM vault holds most of a freshly graduated
   * token's supply by construction, and counting it made every healthy launch
   * read as maximally concentrated.
   */
  if (input.top10Pct !== null) {
    /*
     * FULL CREDIT BELOW TEN PERCENT, not twenty.
     *
     * The anchors matter more than the ceiling here. At `goodAt: 20` almost
     * every healthy launch collected the entire 34 points, so the component
     * gave the same answer for an 18% top ten and an 8% one — and the pillar
     * ran out of range before it reached the tokens worth separating.
     */
    const conc = ramp(input.top10Pct, 10, 70, 34, 0);
    score += conc;
    if (input.top10Pct > 45) {
      findings.push(
        finding(
          'concentrated',
          'distribution',
          input.top10Pct > 65 ? 'high' : 'medium',
          `The top ten wallets hold ${input.top10Pct.toFixed(0)}% of supply.`,
          34 - conc
        )
      );
    }
  }

  if (input.creatorPct !== null) {
    // Full credit at zero. A creator holding 0.9% and one holding nothing were
    // scoring identically.
    const dev = ramp(input.creatorPct, 0, 20, 16, 0);
    score += dev;
    if (input.creatorPct >= 10) {
      findings.push(
        finding(
          'creator_bag',
          'distribution',
          input.creatorPct >= 20 ? 'critical' : 'high',
          `The creator still holds ${input.creatorPct.toFixed(1)}% of supply.`,
          16 - dev
        )
      );
    } else if (input.creatorPct <= 0.5) {
      score += 4;
      findings.push(
        finding('creator_clean', 'distribution', 'good', 'The creator holds effectively none of the supply.', -4)
      );
    }
  }

  /*
   * Holder count on a LOG SCALE, because the difference between 20 and 200
   * holders is enormous and the difference between 2,000 and 2,200 is noise.
   */
  if (input.holderCount !== null) {
    /*
     * Full credit at ~3,000 holders rather than ~1,600. This is the component
     * the pillar now leans on hardest, so it is the one that must keep
     * resolving at the top of the range: four hundred holders is a healthy
     * launch and four thousand is a different kind of token.
     */
    const holders = ramp(Math.log10(Math.max(1, input.holderCount)), 3.5, 1, 26, 0);
    score += holders;
    if (input.holderCount < 50) {
      findings.push(
        finding(
          'few_holders',
          'distribution',
          'medium',
          `Only ${input.holderCount} holders so far.`,
          26 - holders
        )
      );
    }
  }

  return { score: bound(score), findings };
}

// ---------------------------------------------------------------------------
// Launch — what was taken before anybody could react
// ---------------------------------------------------------------------------

export function scoreLaunch(launch: LaunchAnalysis, creator: CreatorHistory | null): PillarResult {
  /*
   * A CLUSTER READING ALONE IS ENOUGH TO SCORE THIS PILLAR, even where the
   * first-slot analysis never ran. RugCheck's insider graph is available for
   * most tokens and a deployment without a transaction-history key has nothing
   * else here — refusing to score on it would throw away the single most
   * valuable reading available on this chain.
   */
  if (!launch.analyzed && launch.clusteredPct === null && creator === null) return NONE;

  const findings: Finding[] = [];
  let score = 58;

  /*
   * THE BUNDLE. Ten percent taken in the first traded slot is a normal
   * competitive launch. Forty percent is not a launch anybody else was invited
   * to — and because the holder table reports those wallets as forty separate
   * healthy holders, this is the only place it shows up at all.
   */
  if (launch.bundledPct !== null) {
    const b = ramp(launch.bundledPct, 5, 40, 24, -26);
    score += b;
    if (launch.bundledPct >= 15) {
      findings.push(
        finding(
          'bundled',
          'launch',
          launch.bundledPct >= 35 ? 'critical' : launch.bundledPct >= 25 ? 'high' : 'medium',
          `${launch.bundledPct.toFixed(1)}% of supply was taken in the first traded slot${
            launch.bundleWallets ? ` by ${launch.bundleWallets} wallets` : ''
          }.`,
          24 - b
        )
      );
    } else if (launch.bundledPct < 5) {
      findings.push(
        finding('clean_open', 'launch', 'good', 'Nothing unusual happened in the first traded slot.', -b)
      );
    }
  }

  /*
   * THE FUNDING CLUSTER, AND WHY IT OUTWEIGHS THE BUNDLE IT OVERLAPS.
   *
   * Splitting a bag across twelve wallets defeats every holder metric there is
   * and costs a fraction of a cent per wallet. What it cannot hide is that all
   * twelve were funded from the same place. The bundle is WHAT happened; the
   * cluster is WHO it happened for, and the cluster survives the wallets being
   * split up.
   */
  if (launch.clusteredPct !== null && launch.clusteredPct > 0) {
    const c = ramp(launch.clusteredPct, 5, 35, 0, -32);
    score += c;
    if (launch.clusteredPct >= 10) {
      findings.push(
        finding(
          'funding_cluster',
          'launch',
          launch.clusteredPct >= 25 ? 'critical' : 'high',
          `${launch.clusteredPct.toFixed(1)}% of supply sits in ${launch.clusters ?? 0} wallet cluster(s) sharing one funding source.`,
          -c
        )
      );
    }
  } else if (launch.clusteredPct === 0) {
    // A graph that RAN and found nothing is a real positive, and it is one of
    // the few available on a token an hour old.
    score += 8;
    findings.push(
      finding('no_clusters', 'launch', 'good', 'No wallets holding this share a funding source.', -8)
    );
  }

  if (launch.creatorLinkedPct !== null && launch.creatorLinkedPct >= 5) {
    const d = ramp(launch.creatorLinkedPct, 5, 30, 0, -24);
    score += d;
    findings.push(
      finding(
        'creator_linked',
        'launch',
        launch.creatorLinkedPct >= 20 ? 'critical' : 'high',
        `Wallets the creator funded hold ${launch.creatorLinkedPct.toFixed(1)}% of supply.`,
        -d
      )
    );
  }

  /*
   * SNIPERS, WEIGHTED FAR BELOW THE BUNDLE. A fast buyer is not an insider —
   * a large share of everyone who has ever bought a pump.fun launch arrived
   * inside the first fifteen seconds, and treating that cohort as a red flag
   * would mean flagging most of the chain. It moves the score only when it is
   * extreme.
   */
  if (launch.sniperPct !== null && launch.sniperPct > 25) {
    const s = ramp(launch.sniperPct, 25, 65, 0, -12);
    score += s;
    findings.push(
      finding(
        'sniped',
        'launch',
        'medium',
        `${launch.sniperPct.toFixed(0)}% of supply was taken in the first fifteen seconds.`,
        -s
      )
    );
  }

  /*
   * WHAT THE BUNDLE DID NEXT. Both answers are bad and they are bad in
   * different ways, so neither is allowed to read as reassuring: still holding
   * is an overhang aimed at whoever buys next; already sold means it was aimed
   * at whoever bought first, and the pattern is confirmed rather than suspected.
   */
  if (launch.bundledPct !== null && launch.bundledPct >= 10 && launch.stillHeldPct !== null) {
    const dumped = launch.bundledPct - launch.stillHeldPct;
    if (dumped >= launch.bundledPct * 0.6) {
      score -= 10;
      findings.push(
        finding(
          'bundle_dumped',
          'launch',
          'high',
          `The first-slot wallets have already sold ${dumped.toFixed(1)}% of supply into the market.`,
          10
        )
      );
    } else if (launch.stillHeldPct >= 15) {
      score -= 8;
      findings.push(
        finding(
          'bundle_overhang',
          'launch',
          'high',
          `The first-slot wallets are still sitting on ${launch.stillHeldPct.toFixed(1)}% of supply.`,
          8
        )
      );
    }
  }

  // The creator's record. Null means a first launch, which is no signal at all.
  if (creator?.reputation === 'serial_rugger') {
    score -= 42;
    findings.push(
      finding(
        'serial_rugger',
        'launch',
        'critical',
        `This creator has launched ${creator.tokensLaunched} tokens and pulled ${creator.rugged} of them.`,
        42
      )
    );
  } else if (creator?.reputation === 'suspect') {
    score -= 18;
    findings.push(
      finding(
        'creator_suspect',
        'launch',
        'high',
        `${creator.rugged} of this creator's ${creator.tokensLaunched} previous launches ended badly.`,
        18
      )
    );
  } else if (creator?.reputation === 'trusted') {
    score += 14;
    findings.push(
      finding(
        'creator_trusted',
        'launch',
        'good',
        `${creator.survived} of this creator's ${creator.tokensLaunched} launches are still trading.`,
        -14
      )
    );
  }

  return { score: bound(score), findings };
}

// ---------------------------------------------------------------------------
// Momentum — whether it is alive
// ---------------------------------------------------------------------------

export interface MomentumInput {
  ageSeconds: number;
  buys24h: number;
  sells24h: number;
  /** Distinct wallets. NULL when nothing has computed it. */
  traders24h: number | null;
  volume24hUsd: number;
  liquidityUsd: number;
  allTimeHighUsd: number | null;
  priceUsd: number;

  /*
   * THE SHORT WINDOWS, AND THEY ARE THE POINT OF THE REWRITE.
   *
   * This pillar used to read nothing but 24-hour totals, which cannot answer
   * the only question that decides an entry: WHERE IN ITS OWN ARC IS THIS
   * TOKEN RIGHT NOW. "It was busy today" is a fact about a move that has
   * already happened, and a call fired on it is a call fired after the move —
   * which is exactly what the record showed. Forty-one of the first
   * seventy-nine calls never traded above their entry price, not even briefly.
   *
   * These columns were being fetched, stored and displayed the whole time. The
   * scorer simply never read them.
   */
  volume5mUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
}

/** Below this a token has not traded enough for any of it to mean anything. */
const MIN_TRADES = 12;

export function scoreMomentum(input: MomentumInput): PillarResult {
  const trades = input.buys24h + input.sells24h;
  if (trades < MIN_TRADES) return NONE;

  const findings: Finding[] = [];
  let score = 30;

  /*
   * DISTINCT TRADERS RATHER THAN TRANSACTION COUNT, where we have them — one
   * wallet trading against itself produces any transaction count you like for
   * the price of a few thousand lamports, and producing two hundred distinct
   * counterparties costs two hundred funded wallets.
   *
   * Where the distinct count has NOT been computed, the transaction count is
   * used at a LOWER ceiling rather than at the same one. Substituting the weak
   * measure at full weight would let the cheap-to-fake number earn what the
   * expensive one is worth.
   */
  if (input.traders24h !== null) {
    const traders = ramp(Math.log10(Math.max(1, input.traders24h)), 2.4, 0.7, 26, 0);
    score += traders;
    if (input.traders24h < 15) {
      findings.push(
        finding(
          'few_traders',
          'momentum',
          'medium',
          `Only ${input.traders24h} distinct wallets traded today.`,
          26 - traders
        )
      );
    }
  } else {
    score += ramp(Math.log10(Math.max(1, trades)), 3, 1.1, 15, 0);
  }

  /*
   * TURNOVER, WITH A CEILING THAT BITES BOTH WAYS. Volume against the depth
   * behind it says people are actually trading this rather than looking at it —
   * up to a point. Thirty times the pool in a day is not thirty times the
   * interest, it is a small number of wallets passing the same tokens back and
   * forth, which is the cheapest possible thing to manufacture.
   */
  if (input.liquidityUsd > 0) {
    const turnover = input.volume24hUsd / input.liquidityUsd;
    score += ramp(turnover, 3, 0.1, 16, 0);
    if (turnover > 25) {
      const penalty = ramp(turnover, 25, 120, 0, 14);
      score -= penalty;
      findings.push(
        finding(
          'churn',
          'momentum',
          'medium',
          `Today's volume is ${turnover.toFixed(0)}x the pool behind it — that is churn, not depth.`,
          penalty
        )
      );
    }
  }

  /*
   * SELL PRESSURE. A buy share far below half is distribution in progress —
   * the shape a launch takes while the people who were early get out.
   */
  if (trades >= 40) {
    const buyShare = input.buys24h / trades;
    if (buyShare < 0.35) {
      score -= 12;
      findings.push(
        finding(
          'sell_pressure',
          'momentum',
          'medium',
          `${Math.round((1 - buyShare) * 100)}% of today's trades were sells.`,
          12
        )
      );
    } else if (buyShare > 0.6) {
      score += 8;
    }
  }

  score += acceleration(input, findings);
  score += extension(input, findings);

  /*
   * DRAWDOWN FROM THE PEAK — a different question from the 24h change and a
   * more useful one for a token that has been alive for a day. Down 85% from
   * its high is a token whose story already happened.
   */
  if (input.allTimeHighUsd !== null && input.allTimeHighUsd > 0 && input.priceUsd > 0) {
    const drawdown = (1 - input.priceUsd / input.allTimeHighUsd) * 100;
    if (drawdown > 70) {
      const penalty = ramp(drawdown, 70, 95, 5, 20);
      score -= penalty;
      findings.push(
        finding(
          'far_below_peak',
          'momentum',
          'medium',
          `Down ${drawdown.toFixed(0)}% from its all-time high.`,
          penalty
        )
      );
    }
  }

  /*
   * SURVIVAL. A token still trading after a day has cleared the window in which
   * most of them stop — worth a few points on its own, capped low, because
   * surviving is a floor rather than an achievement.
   */
  score += ramp(Math.min(input.ageSeconds / 3_600, 72), 0, 72, 0, 6);

  return { score: bound(score), findings };
}

/**
 * IS INTEREST BUILDING OR FADING — the last hour against the five before it.
 *
 * A 24-hour volume total cannot tell those apart: a token that did all of its
 * business this morning and a token doing all of it right now report the same
 * number, and they are opposite trades. The comparison is made on RATES rather
 * than on totals so the windows do not have to be the same length.
 *
 * THE OLDER WINDOW IS DERIVED BY SUBTRACTION, and it can come out negative or
 * zero when the feed's buckets disagree with each other for a moment. That is a
 * reading we do not have rather than a collapse to zero, so it returns nothing.
 */
function acceleration(input: MomentumInput, findings: Finding[]): number {
  const earlierVolume = input.volume6hUsd - input.volume1hUsd;
  if (!(earlierVolume > 0) || !(input.volume1hUsd > 0)) return 0;

  const earlierRate = earlierVolume / 5;
  const ratio = input.volume1hUsd / earlierRate;

  if (ratio >= 1) {
    // Capped low deliberately. Interest building is a reason to look, not a
    // reason to buy — the extension term below decides whether the price has
    // already taken the news.
    return ramp(ratio, 3, 1, 14, 0);
  }

  const penalty = ramp(ratio, 1, 0.15, 0, 12);
  if (penalty > 6) {
    findings.push(
      finding(
        'fading',
        'momentum',
        'medium',
        `Trading in the last hour is running at ${Math.round(ratio * 100)}% of the rate before it.`,
        penalty
      )
    );
  }
  return -penalty;
}

/**
 * HOW MUCH OF THE MOVE HAS ALREADY HAPPENED — the term this pillar was missing,
 * and the reason the calls were bad.
 *
 * Every other reading here is a fact about the TOKEN. This one is a fact about
 * the PRICE YOU WOULD PAY, and it is the only one that distinguishes a good
 * token from a good entry. A screener with no such term recommends most loudly
 * exactly when a token has just gone vertical, because every other signal it
 * reads — volume, turnover, buy share, traders — peaks at the same moment. That
 * is buying the last candle of somebody else's exit, and it is what the first
 * seventy-nine calls did: half of them never traded above their entry.
 *
 * A CALM HOUR SCORES BEST. Not a falling one, not a vertical one: the shape
 * where something is being accumulated and the price has not yet been marked up
 * for it.
 */
function extension(input: MomentumInput, findings: Finding[]): number {
  let score = 0;
  const hour = input.priceChange1h;

  if (hour > 30) {
    /*
     * Ramped rather than stepped, because there is no threshold at which a
     * move "has happened" — a token up 60% in an hour is a slightly worse entry
     * than one up 50%, all the way out to the vertical case.
     *
     * THE SHAPE IS MEASURED. Replaying 18,362 entries over the tokens that
     * clear the quality gates, the median return one hour after entry was 0.998
     * for a calm preceding hour, 0.886 after one up 80-150%, 0.783 after
     * 150-400%, and 0.528 after a vertical one. The first draft ramped from 40%
     * out to 400%, which put a seven-point penalty on the 150-400% band — a
     * band where the median entry loses a fifth of its money. The ramp now
     * saturates at 200%, where the damage does.
     */
    const penalty = ramp(hour, 30, 200, 0, 26);
    score -= penalty;
    findings.push(
      finding(
        'already_ran',
        'momentum',
        hour > 200 ? 'high' : 'medium',
        `Up ${Math.round(hour)}% in the last hour — most of this move is already priced.`,
        penalty
      )
    );
  } else if (hour >= -8) {
    // The accumulation shape: flat to slightly up. Small, because it is the
    // ABSENCE of a reason to refuse rather than a reason on its own.
    score += 6;
  }

  /*
   * A SPIKE IN THE LAST FIVE MINUTES is the single worst instant to enter and
   * is scored SEPARATELY from the hour, because the two are not the same shape:
   * a token that climbed steadily all hour and a token flat for fifty-five
   * minutes and then vertical report a similar 1h number and are opposite
   * trades. This is the one the engine would otherwise walk straight into,
   * since a spike is what pushes a token over the grade threshold in the first
   * place.
   */
  if (input.priceChange5m > 10) {
    /*
     * THE PILLAR STARTS PENALISING EARLIER THAN THE CALL GATE REFUSES, on
     * purpose. Two backtest windows disagreed about the 10-25% band (medians
     * 0.902 and 0.997) and agreed about 25-60% (0.893 and 0.839, with about
     * half of those entries down a fifth an hour later). A score is a
     * continuous opinion and can carry a mild penalty through a noisy band; a
     * call is a published claim and should only be refused where the evidence
     * is consistent. So the ramp begins at 10 and the gate's veto sits at 25.
     */
    const penalty = ramp(input.priceChange5m, 10, 60, 0, 16);
    score -= penalty;
    findings.push(
      finding(
        'spiking',
        'momentum',
        'high',
        `Up ${Math.round(input.priceChange5m)}% in the last five minutes. Whatever this is, it is mid-candle.`,
        penalty
      )
    );
  }

  /*
   * THE SIX-HOUR CONTEXT decides whether a calm hour is a base or a slide. Down
   * heavily over six hours with a flat hour is a token bleeding out between
   * sellers, not one being accumulated.
   */
  if (input.priceChange6h < -55) {
    const penalty = ramp(input.priceChange6h, -55, -90, 0, 10);
    score -= penalty;
    findings.push(
      finding(
        'bleeding',
        'momentum',
        'medium',
        `Down ${Math.abs(Math.round(input.priceChange6h))}% over six hours.`,
        penalty
      )
    );
  }

  return score;
}

// ---------------------------------------------------------------------------
// Presence — what was PAID for, reported and barely scored
// ---------------------------------------------------------------------------

export interface PresenceInput {
  /** NULL when DexScreener has never been asked — the normal state early on. */
  paid: boolean | null;
  paidTypes: string[];
  boosts: number;
  liquidityUsd: number;
}

/** The most this can move a finished score, in either direction. */
export const PRESENCE_CAP = 5;

/**
 * NOT A SIXTH PILLAR. It carries no weight, is applied to the finished number
 * and is bounded at five points, because "somebody spent money on visibility"
 * is not a property of a token — and a screener that scored it would end up
 * ranking whoever is advertising hardest.
 *
 * NULL RETURNS EXACTLY ZERO AND NO FINDINGS. A token nobody has checked must
 * not be penalised for the absence of a profile that may well exist.
 */
export function scorePresence(input: PresenceInput | null): { delta: number; findings: Finding[] } {
  if (!input || input.paid === null) return { delta: 0, findings: [] };

  const findings: Finding[] = [];
  let delta = 0;
  const has = (t: string): boolean => input.paidTypes.includes(t);

  /*
   * A FILLED PROFILE: money plus EFFORT, and the effort is the informative
   * half. The payment is small enough that a determined scam will make it; what
   * it cannot fake as cheaply is a description somebody wrote and links to
   * places they can be found. Weak positive evidence, scored as weak.
   */
  if (has('tokenProfile')) {
    delta += 3;
    findings.push(
      finding('dex_profile', 'momentum', 'good', 'Somebody paid for a DexScreener profile and filled it in.', -3)
    );
  }

  /*
   * A COMMUNITY TAKEOVER is the one order type that is a FACT rather than a
   * purchase, and it is a fact about the creator: it is approved when the
   * original team is GONE. That the community picked it up afterwards is real
   * and is why the penalty is small — but the abandonment happened, and it is
   * not neutral.
   */
  if (has('communityTakeover')) {
    delta -= 1.5;
    findings.push(
      finding(
        'dex_cto',
        'momentum',
        'medium',
        'The original creator is gone: this listing was taken over by its community.',
        1.5
      )
    );
  }

  /*
   * ADVERTS SCORE NOTHING. A trending-bar advert is a marketing budget or an
   * exit being funded and there is no way to tell which from the purchase. It
   * is reported as a fact and contributes zero.
   */
  if (has('tokenAd') || has('trendingBarAd')) {
    findings.push(
      finding(
        'dex_ad',
        'momentum',
        'low',
        'Advertising has been bought for this token. That is a purchase, not a property.',
        0
      )
    );
  }

  /*
   * BOOSTS AGAINST DEPTH. A boost sends people to a pool; buying a lot of them
   * for a pool that cannot absorb the arrivals is the shape of a pump — the
   * attention is real and the exit for the people it brings is not.
   */
  if (input.boosts >= 30 && input.liquidityUsd > 0 && input.liquidityUsd < 5_000) {
    delta -= 3;
    findings.push(
      finding(
        'boosts_over_depth',
        'momentum',
        'high',
        `${input.boosts} boosts bought against $${Math.round(input.liquidityUsd)} of liquidity.`,
        3
      )
    );
  }

  return { delta: Math.max(-PRESENCE_CAP, Math.min(PRESENCE_CAP, delta)), findings };
}

export { bound as boundScore, ramp as rampScore };
