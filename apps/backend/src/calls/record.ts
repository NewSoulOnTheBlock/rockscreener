import { CALL_WORKED_MULTIPLE, type CallRecord, type CallTier } from '@rockscreener/shared';
import { prisma } from '../clients/prisma.js';

/**
 * THE TRACK RECORD — the number that decides whether any of this is worth
 * reading.
 *
 * PUBLISHED WHOLE, INCLUDING THE LOSSES. Every call in the window is counted
 * the same way: the ones that ran, the ones that went nowhere and the ones that
 * went to zero. There is no filter here for outcome, no minimum multiple, and
 * no quiet exclusion of calls that are still open — an open call that is down
 * 60% counts exactly as much as a closed one that did 4x.
 *
 * MEDIANS, NEVER MEANS. One 400x carries a mean and says nothing at all about
 * what the typical call did. The median PEAK and the median CURRENT are both
 * published because the gap between them is the honest measure of a feed like
 * this: a product that shows only its peaks is showing the best moment of every
 * call it ever made.
 */
export async function callRecord(
  windowHours: number,
  tier: CallTier | 'all' = 'all'
): Promise<CallRecord> {
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const calls = await prisma.call.findMany({
    where: {
      calledAt: { gte: since },
      ...(tier === 'all' ? {} : { tier }),
    },
    select: {
      entryPriceUsd: true,
      peakPriceUsd: true,
      lastPriceUsd: true,
      troughPriceUsd: true,
      outcome: true,
    },
  });

  if (calls.length === 0) {
    return {
      tier,
      windowHours,
      calls: 0,
      successCount: 0,
      hit2xPct: 0,
      hit5xPct: 0,
      drawdown50Pct: 0,
      /*
       * NULL, NOT 1. A median of nothing is not "one times"; printing 1.00x on
       * an empty window is a fabricated number of exactly the kind the rest of
       * this system refuses.
       */
      medianPeakMultiple: null,
      medianCurrentMultiple: null,
      ruggedCount: 0,
    };
  }

  const peaks: number[] = [];
  const currents: number[] = [];
  let worked = 0;
  let hit2x = 0;
  let hit5x = 0;
  let fell50 = 0;
  let rugged = 0;

  for (const call of calls) {
    const entry = call.entryPriceUsd;
    if (!(entry > 0)) continue;

    const peak = call.peakPriceUsd / entry;
    const current = call.lastPriceUsd / entry;
    /*
     * The drawdown is measured from the TROUGH, not from the current price. A
     * call that fell 80% and came back is a call that fell 80%, and a reader
     * deciding whether they could have held it needs to know that rather than
     * where it happens to be now.
     */
    const trough = call.troughPriceUsd / entry;

    peaks.push(peak);
    currents.push(current);

    /*
     * WORKED is measured against the PEAK, so a call that reached the line and
     * came back still counts — the same rule `hit2xPct` follows, and for the
     * same reason: the claim was "this was worth buying at that moment", and
     * whether somebody sold into the move is not a property of the call.
     */
    if (peak >= CALL_WORKED_MULTIPLE) worked += 1;
    if (peak >= 2) hit2x += 1;
    if (peak >= 5) hit5x += 1;
    if (trough <= 0.5) fell50 += 1;
    if (call.outcome === 'rugged') rugged += 1;
  }

  const total = calls.length;
  return {
    tier,
    windowHours,
    calls: total,
    successCount: worked,
    hit2xPct: Math.round((hit2x / total) * 100),
    hit5xPct: Math.round((hit5x / total) * 100),
    drawdown50Pct: Math.round((fell50 / total) * 100),
    medianPeakMultiple: median(peaks),
    medianCurrentMultiple: median(currents),
    ruggedCount: rugged,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 100) / 100;
}
