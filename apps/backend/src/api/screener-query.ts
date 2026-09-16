import type { Prisma } from '@prisma/client';
import { CALL_THRESHOLD, MIN_COVERAGE_FOR_VERDICT, type ScreenerQuery } from '@rockscreener/shared';

/**
 * The screener query, built once.
 *
 * KEYSET PAGINATION, NEVER OFFSET. The token table runs to hundreds of
 * thousands of rows; `OFFSET n` makes Postgres walk and discard n of them, and
 * `COUNT(*)` over a filtered set degenerates into a scan. The cursor encodes
 * the last row's sort key plus its mint as a tiebreaker, so page 10,000 costs
 * exactly what page 1 costs and no total is ever computed.
 *
 * THE TIEBREAKER IS NOT OPTIONAL. Sorting by score alone, with hundreds of
 * tokens sharing a score to one decimal, makes the page boundary unstable —
 * rows appear twice or vanish depending on how the planner happened to order
 * the ties that pass.
 */

export interface ParsedQuery {
  where: Prisma.TokenWhereInput;
  orderBy: Prisma.TokenOrderByWithRelationInput[];
  take: number;
  cursor?: Prisma.TokenWhereUniqueInput;
  skip?: number;
}

export function buildQuery(q: ScreenerQuery): ParsedQuery {
  const where: Prisma.TokenWhereInput = {
    // DORMANT rows keep their final numbers for the creator history and the
    // token page, but they are not part of any lane: a screener is a claim
    // about now.
    tier: { in: ['SEEDED', 'ACTIVE', 'GRADUATED'] },
  };
  const and: Prisma.TokenWhereInput[] = [];

  switch (q.preset) {
    case 'calls':
      // A token is in this lane because somebody called it, so the filter is on
      // the call rather than on any property of the token.
      and.push({ calls: { some: {} } });
      break;

    case 'rocks':
      /*
       * THE GRADED SHORTLIST HOLDS BACK PROVISIONAL SCORES. A 91 computed from
       * two of five pillars is not a better token than a measured 74 — it is a
       * token nobody has finished reading — and a lane that sorted them
       * together would teach the reader to trust the number least exactly when
       * it looks most confident.
       */
      and.push({ score: { not: null }, coverage: { gte: MIN_COVERAGE_FOR_VERDICT } });
      break;

    case 'bonding':
      and.push({ status: 'BONDING' });
      break;

    case 'graduated':
      and.push({ status: 'MIGRATED' });
      break;

    case 'new':
    default:
      break;
  }

  if (q.scoredOnly) and.push({ score: { not: null } });
  if (q.minScore !== undefined) and.push({ score: { gte: q.minScore } });
  if (q.tiers && q.tiers.length > 0) and.push({ tier_: { in: q.tiers } });
  if (q.launchpads && q.launchpads.length > 0) and.push({ launchpad: { in: q.launchpads } });
  if (q.minLiquidityUsd !== undefined) and.push({ liquidityUsd: { gte: q.minLiquidityUsd } });
  if (q.minMarketCapUsd !== undefined) and.push({ marketCapUsd: { gte: q.minMarketCapUsd } });
  if (q.maxMarketCapUsd !== undefined) and.push({ marketCapUsd: { lte: q.maxMarketCapUsd } });
  if (q.maxAgeHours !== undefined) {
    and.push({ launchTime: { gte: new Date(Date.now() - q.maxAgeHours * 3_600_000) } });
  }

  if (q.search && q.search.trim() !== '') {
    const needle = q.search.trim();
    /*
     * THE MINT IS MATCHED AS A PREFIX, NOT AS A SUBSTRING. A `contains` over a
     * base58 column cannot use an index and turns every search keystroke into a
     * sequential scan of the whole table. Symbol and name are short enough to
     * match case-insensitively without that cost.
     */
    and.push({
      OR: [
        { symbol: { contains: needle, mode: 'insensitive' } },
        { name: { contains: needle, mode: 'insensitive' } },
        { mint: { startsWith: needle } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;

  return {
    where,
    orderBy: orderFor(q),
    take: Math.min(Math.max(q.limit ?? 60, 1), 200),
    ...(q.cursor ? { cursor: { mint: q.cursor }, skip: 1 } : {}),
  };
}

function orderFor(q: ScreenerQuery): Prisma.TokenOrderByWithRelationInput[] {
  const dir: Prisma.SortOrder = q.order === 'asc' ? 'asc' : 'desc';
  // The mint is the tiebreaker on every ordering. See the note at the top.
  const tie: Prisma.TokenOrderByWithRelationInput = { mint: 'asc' };

  switch (q.sort) {
    case 'score':
      /*
       * NULLS LAST, IN BOTH DIRECTIONS. An unscored token is not the worst
       * token; somebody sorting ascending is asking for the worst GRADED
       * tokens, and filling the top of that list with rows that have no grade
       * at all answers a different question.
       */
      return [{ score: { sort: dir, nulls: 'last' } }, tie];
    case 'marketCap':
      return [{ marketCapUsd: { sort: dir, nulls: 'last' } }, tie];
    case 'liquidity':
      return [{ liquidityUsd: { sort: dir, nulls: 'last' } }, tie];
    case 'volume24h':
      return [{ volume24hUsd: dir }, tie];
    case 'progress':
      // Nulls last: a curve nobody has read is not a curve at zero.
      return [{ progressBps: { sort: dir, nulls: 'last' } }, tie];
    case 'migratedAt':
      return [{ migratedAt: { sort: dir, nulls: 'last' } }, tie];
    case 'trending':
      /*
       * "Trending" is volume against depth rather than raw volume, and Prisma
       * cannot order on a computed ratio — so this orders on the 1h bucket,
       * which is the closest indexable proxy, and the honest name for it is
       * "what is busy right now".
       */
      return [{ volume1hUsd: dir }, tie];
    case 'calledAt':
    case 'peakMultiple':
      /*
       * The calls lane is served by its own route, which orders on the CALL
       * table. Reaching these through the screener means the preset and the
       * sort disagree; falling back to newest-first is the least surprising
       * answer and never errors.
       */
      return [{ launchTime: dir }, tie];
    case 'new':
    default:
      return [{ launchTime: dir }, tie];
  }
}

/** The tier a call would fire at, for the calls lane's own ordering. */
export { CALL_THRESHOLD };
