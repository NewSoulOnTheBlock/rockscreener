import { CALL_THRESHOLD, type CallTier } from '@rockscreener/shared';
import type { CallsConfig } from '../config/schema.js';

/**
 * EVERY GATE A CALL HAS TO CLEAR, as one pure function.
 *
 * This is the definition of the only claim this product makes, so it is
 * deliberately not a private method buried in an engine that needs a database
 * to run. It takes facts and returns either `null` — meaning fire — or the
 * reason it refused, as a sentence.
 *
 * THE REASONS ARE WRITTEN OUT EVEN THOUGH NO SCREEN SHOWS THEM. A gate whose
 * rationale is a bare boolean is a gate nobody can argue with six months later,
 * and every threshold here is somebody deciding what to buy.
 */
export interface CallCandidate {
  symbol: string;
  score: number | null;
  coverage: number | null;
  /** Set when a critical finding capped the grade. */
  clamped: unknown | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  holderCount: number | null;
  ageSeconds: number;
  launchAnalyzed: boolean;
  /** RugCheck's insider-graph reading, which alone satisfies the launch gate. */
  clusteredPct: number | null;
  sellOk: boolean | null;
  rugged: boolean | null;

  /*
   * THE TIMING FACTS. Everything above is about the token; these are about the
   * MOMENT, which is what separates a call from a grade — and they were missing
   * entirely from the first version of this gate.
   */
  priceChange5m: number | null;
  priceChange1h: number | null;
  volume1hUsd: number | null;
}

export function callRefusal(t: CallCandidate, tier: CallTier, cfg: CallsConfig): string | null {
  if (t.score === null || t.coverage === null) return 'not scored';

  if (t.score < CALL_THRESHOLD[tier]) return `score ${t.score} below ${CALL_THRESHOLD[tier]}`;

  /*
   * COVERAGE, and it is the gate that does the most work. A 91 computed from
   * two of five pillars is not a better token than a measured 74 — it is a
   * token nobody has finished reading — and calling it would mean the feed's
   * best-looking entries were systematically its least-examined ones.
   */
  if (t.coverage < cfg.minCoverage) return `coverage ${t.coverage}% too low`;

  /*
   * A CLAMPED SCORE IS NEVER CALLED, whatever the number says. The clamp exists
   * because one critical finding disqualifies four good pillars, so a token
   * that was capped and still cleared a threshold has something critically
   * wrong with it by definition.
   */
  if (t.clamped !== null && t.clamped !== undefined) return 'a critical finding capped the grade';

  if ((t.liquidityUsd ?? 0) < cfg.minLiquidityUsd) return 'not enough liquidity';

  /*
   * THE CEILING, AND IT IS THE POINT OF THE PRODUCT.
   *
   * A grade is a statement about quality at any size; a CALL is a statement
   * that something is worth buying NOW. Those come apart at the top of the
   * market: a major token with seven hundred thousand holders and twenty
   * million dollars of liquidity grades superbly and is not a call anybody can
   * act on, because the move it would be a call about happened months ago.
   * Without this, the engine called a $1.67bn token on its first live run.
   *
   * There is deliberately NO MAXIMUM AGE beside it. A three-week-old token that
   * finally clears the grade is exactly the call worth making — that is a
   * sleeper waking up, and it is a different event from a large token sitting
   * there being large.
   */
  if ((t.marketCapUsd ?? 0) > cfg.maxMarketCapUsd) {
    return `market cap $${Math.round(t.marketCapUsd ?? 0).toLocaleString('en-US')} is past the ceiling`;
  }

  /*
   * REAL HOLDERS. The distribution pillar already refuses to credit
   * concentration below a floor, but a call is a louder claim than a grade and
   * deserves its own explicit gate: a token twelve wallets hold is not
   * something to tell people to buy, whatever the other four pillars say.
   *
   * A NULL holder count does NOT fail this. There it is our holder sync being
   * behind rather than the token being empty, and the coverage gate above
   * already refuses a token whose distribution went unread.
   */
  if (t.holderCount !== null && t.holderCount < cfg.minHolders) {
    return `only ${t.holderCount} holders`;
  }

  if (t.ageSeconds < cfg.minAgeSeconds) return 'too new';

  /*
   * THE LAUNCH WINDOW MUST BE CLOSED AND ACTUALLY ANALYSED. Calling a token
   * whose bundle reading has not run is calling one that could be 2% bundled or
   * 60% — and those are a different product. The insider graph satisfies it on
   * its own, because it answers the same question by a different route and is
   * the more predictive of the two.
   */
  if (cfg.requireLaunchAnalyzed && !t.launchAnalyzed && t.clusteredPct === null) {
    return 'the launch has not been analysed';
  }

  /*
   * A CONFIRMED SELL, AND NULL FAILS THIS. "Nobody has checked whether this can
   * be sold" is the ordinary state of a young token, and calling one is how a
   * feed recommends the single trade it exists to avoid.
   */
  if (cfg.requireSellConfirmed && t.sellOk !== true) {
    return t.sellOk === false ? 'it cannot be sold' : 'the sell check has not confirmed it';
  }

  if (t.rugged === true) return 'already pulled';

  /*
   * ============================ THE TIMING GATES ===========================
   *
   * These exist because of a measured failure, not a theory. Of the first
   * seventy-nine calls, FORTY-ONE never traded above their entry price — not
   * by a cent, not for a second. The median peak across the whole record was
   * 1.00x. A feed does not produce that by picking bad tokens; it produces it
   * by picking good tokens at the wrong instant.
   *
   * And the mechanism is structural rather than bad luck. Every reading that
   * pushes a token over the grade threshold — volume, turnover, buy share,
   * distinct traders — peaks at the same moment the price does. So the instant
   * a token crosses into `buy` is, on average, the top of its move. A gate made
   * only of quality thresholds fires exactly then, every time.
   *
   * The score having its own extension term is NOT enough on its own: the score
   * is an average over five pillars and a strong token can carry a bad entry
   * across the line. A call is a single claim about a single moment, so the
   * moment gets its own veto.
   *
   * NULL PASSES EVERY GATE BELOW. These are all fields this system maintains
   * itself on the market pass, so a null means the row has not been priced yet
   * — and the coverage gate above has already refused anything unread. Failing
   * closed here would silently make the whole feed conditional on the market
   * sync's round-robin position.
   */

  if (t.priceChange5m !== null && t.priceChange5m > cfg.maxPriceChange5m) {
    return `up ${Math.round(t.priceChange5m)}% in five minutes — this is mid-candle`;
  }

  /*
   * THE HOUR. A token up 400% in an hour may well be a fine token; it is not a
   * fine ENTRY, because the thing a call would be a call about has happened.
   * The ceiling is deliberately generous — this is not trying to catch every
   * late entry, only to refuse the ones that are unambiguously late.
   */
  if (t.priceChange1h !== null && t.priceChange1h > cfg.maxPriceChange1h) {
    return `up ${Math.round(t.priceChange1h)}% in the last hour — the move is already priced`;
  }

  /*
   * AND THE OPPOSITE FAILURE: a token that qualified on yesterday's numbers and
   * is not trading now. The 24h volume gate cannot see this — a token can do
   * everything in one morning burst and read as busy all day. Calling one means
   * publishing a claim about something nobody is buying, and the exit is thin
   * in both directions.
   */
  if (t.volume1hUsd !== null && t.volume1hUsd < cfg.minVolume1hUsd) {
    return `only $${Math.round(t.volume1hUsd).toLocaleString('en-US')} traded in the last hour`;
  }

  return null;
}

/**
 * The strongest tier a score currently clears.
 *
 * `watch` IS RECORDED AS A BAND BUT NEVER FIRED AS A CALL. It exists in the
 * wire contract because the bands are shared with the grade, but a "watch" is
 * not a claim that something is worth buying, and publishing it alongside real
 * calls would treble the feed with entries the record would then have to count.
 * A feed is judged on what it told people to buy.
 */
export function tierFor(score: number): CallTier | null {
  if (score >= CALL_THRESHOLD.strong_buy) return 'strong_buy';
  if (score >= CALL_THRESHOLD.buy) return 'buy';
  return null;
}
