import { Router } from 'express';
import type { RockTier, ScreenerQuery } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { publicCache } from '../middleware/cache.js';
import { wrap } from '../middleware/error-handler.js';
import { buildQuery } from '../screener-query.js';
import { tokenSummary } from '../serialize.js';

/**
 * The screener.
 *
 * ONE QUERY PER REQUEST, and the calls are included through the relation rather
 * than fetched per row — sixty rows with a per-row call lookup is sixty-one
 * queries, which is the classic way a list endpoint that felt fine at ten rows
 * falls over at a hundred.
 */
export function screenerRouter(): Router {
  const router = Router();

  router.get(
    '/screener',
    publicCache(5),
    wrap(async (req, res) => {
      const q = parse(req.query);
      const { where, orderBy, take, cursor, skip } = buildQuery(q);

      const rows = await prisma.token.findMany({
        where,
        orderBy,
        // One more than asked for, so the cursor is known WITHOUT a count — the
        // extra row is dropped and its existence is the only thing needed to
        // decide whether there is a next page.
        take: take + 1,
        ...(cursor ? { cursor, skip } : {}),
        include: {
          calls: {
            orderBy: { calledAt: 'desc' },
            take: 1,
          },
        },
      });

      const page = rows.slice(0, take);
      res.json({
        data: page.map((t) => tokenSummary(t, t.calls[0] ?? null)),
        nextCursor: rows.length > take ? (page[page.length - 1]?.mint ?? null) : null,
      });
    })
  );

  return router;
}

/**
 * Query strings are strings.
 *
 * Every numeric filter here is a gate somebody's list is built from, and
 * `Number('')` is 0 — so a stray empty parameter would silently become
 * "minimum score zero" rather than "no minimum". Each conversion is explicit
 * and anything unparseable is simply dropped.
 */
function parse(raw: unknown): ScreenerQuery {
  const q = raw as Record<string, string | undefined>;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const list = (v: string | undefined): string[] | undefined =>
    v && v.trim() !== '' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  return {
    preset: q.preset as ScreenerQuery['preset'],
    sort: q.sort as ScreenerQuery['sort'],
    order: q.order === 'asc' ? 'asc' : 'desc',
    limit: num(q.limit),
    cursor: q.cursor,
    search: q.search,
    scoredOnly: q.scoredOnly === 'true',
    minScore: num(q.minScore),
    tiers: list(q.tiers) as RockTier[] | undefined,
    launchpads: list(q.launchpads),
    minLiquidityUsd: num(q.minLiquidityUsd),
    minMarketCapUsd: num(q.minMarketCapUsd),
    maxMarketCapUsd: num(q.maxMarketCapUsd),
    maxAgeHours: num(q.maxAgeHours),
  };
}
