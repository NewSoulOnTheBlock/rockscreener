import type { RockPillars, TokenSummary } from '@rockscreener/shared';

/**
 * The five strata a FEED CARD can honestly draw.
 *
 * A screener row carries the score summary, not the full breakdown — sending
 * five pillars per row would roughly double a page of sixty. So the card draws
 * a SILHOUETTE derived from the facts the summary actually has, and every
 * stratum it cannot derive stays `null` and is drawn as a void.
 *
 * THE TEMPTATION THIS FUNCTION EXISTS TO REFUSE is filling the gaps with the
 * overall score. It would make every card look complete and it would be a lie
 * in exactly the direction the product is built against: a token whose holder
 * table has never been read would show a confident distribution layer. The
 * drawer fetches the real five; until then the card admits what it does not
 * have.
 */
export function silhouettePillars(token: TokenSummary): RockPillars {
  const rock = token.rock;
  if (!rock) {
    return { safety: null, launch: null, liquidity: null, distribution: null, momentum: null };
  }

  return {
    // The sell check is the load-bearing half of safety on this chain, so an
    // unchecked sell leaves the stratum empty rather than optimistic.
    safety: rock.sellOk === null ? null : rock.sellOk ? rock.score : Math.min(rock.score, 12),

    // Inverted: a clean launch is a full layer. Null when the analysis has not
    // run, which is not the same as a launch with nothing found.
    launch: rock.bundledPct === null ? null : clamp(100 - rock.bundledPct * 2.2),

    /*
     * Depth against a $50k reference — the point at which a pool is a market
     * rather than four trades from nothing.
     *
     * NULL when the token has no pool at all, and ZERO when it has one that is
     * empty. The core sample draws those differently on purpose: a void means
     * nobody has looked, and an empty stratum means somebody looked and there
     * was nothing there.
     */
    liquidity:
      token.liquidityUsd === null ? null : clamp((token.liquidityUsd / 50_000) * 100),

    distribution: token.top10Pct === null ? null : clamp(100 - token.top10Pct * 1.3),

    // Below twenty trades there is nothing to read, and a buy/sell split
    // computed over six transactions is noise wearing a percentage sign.
    momentum:
      token.txns24h >= 20 ? clamp((token.buys24h / Math.max(1, token.txns24h)) * 140) : null,
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}
