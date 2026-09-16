/**
 * The Rock Score — one number a person can act on, and the five readings
 * behind it.
 *
 * THE NUMBER IS NOT THE PRODUCT. The pillars are. "71" tells a trader nothing
 * they can decide with; "liquidity is locked and distribution is fine, but
 * wallets sharing a funder hold 31% of supply" tells them exactly what they are
 * being offered. So every score that leaves this system carries its components
 * and the specific findings that moved them.
 *
 * EVERY PILLAR IS TRI-STATE AT THE SOURCE. A reading we could not take is
 * `null`, never zero and never the safe value. This is the single rule the
 * product this replaces broke everywhere: it gave every token it had ever seen
 * a confident-looking number, which meant the number said nothing and the list
 * was a database with a sort order. `coverage` below reports how much of a
 * token could actually be measured, and a low-coverage score is shown as
 * provisional rather than as a verdict — and is never auto-traded.
 */

/** The five readings. Each is 0..100 on its own axis, higher is better. */
export interface RockPillars {
  /**
   * What the mint itself permits. Mint authority, freeze authority, a
   * Token-2022 transfer fee or transfer hook, mutable metadata, and the
   * routing check that says whether a real balance can actually be sold back
   * into SOL.
   */
  safety: number | null;
  /**
   * Whether the exit exists. Pool depth in dollars, depth against the
   * valuation being asked for, how much of the LP is locked or burnt, and how
   * many markets the token actually trades in.
   */
  liquidity: number | null;
  /**
   * Who holds it, with AMM vaults, lockers and the burn address excluded —
   * because the biggest balance in almost every Solana token belongs to its own
   * pool, and counting it makes every healthy launch read as a whale's bag.
   */
  distribution: number | null;
  /**
   * How much of the supply was taken before anybody could react, and by whom.
   * Bundles in the launch slot, snipers in the first fifteen seconds, and the
   * wallets behind them that share a funder. Inverted: a clean launch scores
   * high.
   */
  launch: number | null;
  /**
   * Whether it is alive, AND WHERE IN ITS OWN MOVE IT IS.
   *
   * Distinct traders rather than transaction count, the buy/sell balance,
   * turnover against the depth behind it (penalised when the turnover is churn
   * rather than depth), whether the last hour is running faster or slower than
   * the five before it, the drawdown from its own high — and how much of the
   * move has ALREADY HAPPENED, which is the only reading in this whole score
   * that is about the price you would pay rather than about the token.
   */
  momentum: number | null;
}

/**
 * Pillar weights, in the order they matter for not losing money.
 *
 * Safety and launch still lead, because they are the two that take the WHOLE
 * position rather than part of it: a freeze authority and a 40%-bundled launch
 * both end at zero however good the chart looked.
 *
 * BUT THEY LEAD BY LESS THAN THEY USED TO, AND THE REASON IS MEASURED. Across
 * six thousand graded tokens the standard deviations were: distribution 25.2,
 * liquidity 17.1, safety 13.9, launch 10.0, momentum 6.8. A pillar can only
 * rank tokens in proportion to its weight TIMES its spread, and safety and
 * launch were carrying 52% of the weight while barely varying — safety sat at
 * its 77 ceiling for more than half the set, because revoking a mint authority
 * is free and every launchpad does it, and launch sat at 66 for almost all of
 * it, because without a Helius key there is no bundle reading to move it.
 *
 * Half the score was a constant. What that produced was a top-of-table where
 * every token scored 79 to 82 and the ranking came down to whichever had the
 * deepest pool — a big-token finder wearing a gem finder's badge.
 *
 * So safety and launch are treated as what they actually are here: DISQUALIFIERS,
 * whose real work is done by the clamps in `score.ts`, not by their weight. The
 * weight moves to the three pillars that discriminate — and especially to
 * momentum, which after its rewrite is the only pillar that reads WHERE IN ITS
 * OWN ARC a token is, and is therefore the only one that can tell a good token
 * from a good entry.
 */
export const ROCK_WEIGHTS: Record<keyof RockPillars, number> = {
  safety: 0.22,
  launch: 0.18,
  liquidity: 0.2,
  distribution: 0.2,
  momentum: 0.2,
};

/**
 * Score bands. The label is what the card shows; the number is the floor.
 *
 * THE TOP BAND IS SET FROM THE DISTRIBUTION, NOT FROM A ROUND NUMBER. Measured
 * over six thousand graded tokens: the median is 48, the 90th percentile 62,
 * the 99.5th 75, and the highest score in the whole index 81. The old floor of
 * 82 was therefore UNREACHABLE — `Diamond` and the `strong_buy` call that
 * shares its number could never fire, which is a worse failure than a band that
 * is too generous, because nothing in the product says so.
 *
 * 76 is the top 0.4% — about twenty-five tokens out of six thousand at any
 * moment. Rare enough that the label still means something, reachable enough
 * that it means something at all.
 *
 * The lower bands are deliberately UNCHANGED. `Solid` at 68 is the top 3% and
 * `Rough` at 50 is roughly the median, and both still describe what they did
 * before the reweighting; moving them would have relabelled thousands of tokens
 * whose facts had not changed.
 */
export const ROCK_TIERS = [
  { tier: 'diamond', min: 76, label: 'Diamond' },
  { tier: 'solid', min: 68, label: 'Solid' },
  { tier: 'rough', min: 50, label: 'Rough' },
  { tier: 'brittle', min: 32, label: 'Brittle' },
  { tier: 'dust', min: 0, label: 'Dust' },
] as const;

export type RockTier = (typeof ROCK_TIERS)[number]['tier'];

export function rockTier(score: number): RockTier {
  for (const band of ROCK_TIERS) {
    if (score >= band.min) return band.tier;
  }
  return 'dust';
}

export function rockTierLabel(tier: RockTier): string {
  return ROCK_TIERS.find((b) => b.tier === tier)?.label ?? 'Unknown';
}

/**
 * Something specific that was found, in the words the card will use.
 *
 * Severity is separate from the pillar score because the two answer different
 * questions. The score says how much this moved the number; the severity says
 * whether a person should stop reading and close the tab. A `critical` finding
 * CLAMPS the total (see `RockScore.clamped`) rather than being averaged away by
 * four pillars that happen to look fine.
 */
export interface Finding {
  /** Stable identifier, e.g. `freeze_authority`. Never shown to a user. */
  code: string;
  pillar: keyof RockPillars;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'good';
  /** One sentence, plain language, already fit to be rendered as-is. */
  message: string;
  /** Points this finding removed from (or, when negative, added to) its pillar. */
  delta: number;
}

/**
 * What the launch analysis found — the reading this product exists for.
 *
 * Splitting a bag across twelve wallets defeats top-10 concentration, creator
 * percentage, holder count and every other distribution metric there is, and on
 * Solana it costs a fraction of a cent per wallet. What it cannot hide is that
 * all twelve were funded from the same place, and that every one of them bought
 * in the same slot.
 */
export interface LaunchAnalysis {
  /** Whether the analysis ran at all. False means every field below is null. */
  analyzed: boolean;
  /** Supply bought in the token's first traded SLOT, percent of total supply. */
  bundledPct: number | null;
  /** Distinct wallets that bought in that slot. */
  bundleWallets: number | null;
  /**
   * Supply taken within `LAUNCH_WINDOW_SECONDS`, percent of total.
   *
   * Wider than the bundle and a far weaker signal: a fast buyer is not
   * necessarily an insider, which is why the two are measured and scored
   * separately rather than summed into one scary number.
   */
  sniperPct: number | null;
  sniperWallets: number | null;
  /**
   * Supply held by wallets that share a funding source with each other or with
   * the creator, percent of total. The STRONGEST of the three — it is the one
   * that survives the wallets being split up, and on Solana it is the one
   * RugCheck's insider-graph already answers for tokens it has indexed.
   */
  clusteredPct: number | null;
  /** How many distinct funding clusters were identified. */
  clusters: number | null;
  /**
   * How much of what was bundled is STILL held, percent of total supply.
   *
   * Both directions are information and the UI must not collapse them. Still
   * held is an overhang aimed at whoever buys next. Already sold means it was
   * aimed at whoever bought first — the pattern is confirmed, and the only
   * remaining question is whether they do it again with the proceeds.
   */
  stillHeldPct: number | null;
  /** The creator's own current holding, percent of total supply. */
  creatorPct: number | null;
  /** Wallets the creator funded that hold supply now, percent of total. */
  creatorLinkedPct: number | null;
  /** The slot the bundle was measured in — the FIRST slot the token traded in. */
  bundleSlot: number | null;
  launchSlot: number | null;
}

/**
 * How long after a launch a buy still counts as part of the launch.
 *
 * FIFTEEN SECONDS. Solana produces a slot every ~400ms, so a block count would
 * be meaningless across the pauses this chain actually has; a wall-clock window
 * is the only definition that survives a congested minute. Fifteen seconds is
 * the widest window that still names a minority of buyers on a typical
 * pump.fun launch rather than a third of everybody who ever bought.
 */
export const LAUNCH_WINDOW_SECONDS = 15;

/**
 * The creator's record, across every token this system has indexed.
 *
 * A first-time creator is not a signal in either direction, and this struct
 * says so with `reputation: null` rather than by inventing a verdict. A creator
 * on their ninth launch, seven of which lost 95% of their peak within an hour,
 * is the single most predictive fact available about the token in front of
 * you — more than any property of the mint itself.
 */
export interface CreatorHistory {
  address: string;
  tokensLaunched: number;
  /** Launches that lost most of their liquidity within an hour of peak. */
  rugged: number;
  /** Launches still trading above half their peak market cap. */
  survived: number;
  /** Null when this is their first launch — there is no record to summarise. */
  reputation: 'trusted' | 'neutral' | 'suspect' | 'serial_rugger' | null;
}

/**
 * Whether a real balance can actually be sold — Solana's honeypot answer.
 *
 * TWO SOURCES, IN ORDER, exactly like the chain-agnostic version of this idea.
 * WHAT ALREADY HAPPENED: three or more unrelated wallets having sold in the
 * last six hours is a record, not a simulation, and nothing can fake it.
 * WHAT WOULD HAPPEN: for a token too new to have any, a route is requested from
 * the aggregator for a real holder's real balance, and the answer is judged on
 * whether a route exists AND on what it costs — a route that exists but gives
 * back four percent of the money is a honeypot with extra steps.
 *
 * `ok: null` is NOT A PASS. It means neither source answered, which for a token
 * minutes old is the ordinary state, and auto-trade is built to refuse it.
 */
export interface SellCheck {
  ok: boolean | null;
  /** How the answer was reached. Null when there is no answer. */
  via: 'observed_sells' | 'route_quote' | null;
  /** Price impact the quoted route would take, percent. Null when unquoted. */
  impactPct: number | null;
  /** The effective round-trip loss the route implies, basis points. */
  effectiveTaxBps: number | null;
  /** ISO-8601 of the last attempt, or null if it has never run. */
  checkedAt: string | null;
}

/**
 * One token's score, as stored and as served.
 *
 * `computedAt` and `coverage` exist because a score is a statement about a
 * MOMENT. A token scored four seconds after launch has no distribution and no
 * momentum to read, and saying so is more useful than averaging the two pillars
 * we do have into a confident-looking 71.
 */
export interface RockScore {
  mint: string;
  /** 0..100, rounded to one decimal. */
  score: number;
  tier: RockTier;
  pillars: RockPillars;
  /**
   * Share of the pillars that could actually be measured, 0..100.
   *
   * Below `MIN_COVERAGE_FOR_VERDICT` the UI shows the score as provisional and
   * auto-trade refuses to act on it. This is what keeps a brand-new token from
   * being bought on the strength of the two facts that happened to be there.
   */
  coverage: number;
  /**
   * Set when a critical finding capped the total. Carries the cap that was
   * applied, so the card can explain why a token with four green pillars is
   * showing 15.
   */
  clamped: { at: number; reason: string } | null;
  findings: Finding[];
  launch: LaunchAnalysis;
  creator: CreatorHistory | null;
  sell: SellCheck;
  /** ISO-8601. */
  computedAt: string;
  /** Score at the previous computation, for the delta arrow. Null if first. */
  previousScore: number | null;
}

/** Below this, a score is provisional: shown with a caveat, never auto-traded. */
export const MIN_COVERAGE_FOR_VERDICT = 60;

/** The compact form the screener sends for every row. */
export interface RockScoreSummary {
  score: number;
  tier: RockTier;
  coverage: number;
  /** The single worst finding, for the row's warning chip. Null when clean. */
  topWarning: string | null;
  bundledPct: number | null;
  clusteredPct: number | null;
  /** Tri-state, and rendered as a dashed chip when null. */
  sellOk: boolean | null;
  computedAt: string;
}

/** Pillar labels, defined once so the API and three components agree. */
export const PILLAR_LABEL: Record<keyof RockPillars, string> = {
  safety: 'Safety',
  launch: 'Launch',
  liquidity: 'Liquidity',
  distribution: 'Distribution',
  momentum: 'Momentum',
};

export const PILLAR_ORDER: (keyof RockPillars)[] = [
  'safety',
  'launch',
  'liquidity',
  'distribution',
  'momentum',
];
