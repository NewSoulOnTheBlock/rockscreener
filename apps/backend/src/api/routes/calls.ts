import { Router } from 'express';
import type { CallTier } from '@rockscreener/shared';
import { prisma } from '../../clients/prisma.js';
import { callRecord } from '../../calls/record.js';
import { publicCache } from '../middleware/cache.js';
import { wrap } from '../middleware/error-handler.js';
import { callWithToken } from '../serialize.js';

/**
 * The calls, and the record.
 *
 * LIVE CALLS FIRST, THEN THE CLOSED ONES — and the closed ones are NOT filtered
 * out. A rugged call keeps its place in the feed with its entry price and its
 * multiple struck through, because a product that quietly drops the calls that
 * went to zero is publishing a different set of claims from the ones it made.
 *
 * WITHIN EACH GROUP, THE STRONGEST SIGNAL LEADS rather than the newest. The two
 * orderings answer different questions and only one of them is the rail's: a
 * feed sorted by recency puts a 70.1 that squeaked over the line two minutes
 * ago ahead of an 88 from this morning, so the first card a reader sees is the
 * weakest claim on the board. The score is the claim; the timestamp is printed
 * on every card for anyone who wants to re-sort by eye.
 */
export function callsRouter(): Router {
  const router = Router();

  router.get(
    '/calls',
    publicCache(10),
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 40) || 40, 100);

      const calls = await prisma.call.findMany({
        include: { token: true },
        orderBy: [
          // `live` sorts before every other outcome alphabetically, which is a
          // coincidence — so the ordering is made explicit by sorting on
          // `closedAt` nulls-first instead of relying on it.
          { closedAt: { sort: 'asc', nulls: 'first' } },
          // The signal, strongest first. See the note at the top.
          { score: 'desc' },
          // Two calls at the same score to one decimal is common enough to
          // matter; without this the pair would swap places between polls.
          { calledAt: 'desc' },
        ],
        take: limit,
      });

      res.json({ data: calls.map(callWithToken) });
    })
  );

  router.get(
    '/calls/record',
    publicCache(30),
    wrap(async (req, res) => {
      const windowHours = Math.min(Math.max(Number(req.query.windowHours ?? 168) || 168, 1), 8_760);
      const tier = (req.query.tier as CallTier | 'all' | undefined) ?? 'all';
      res.json({ data: await callRecord(windowHours, tier) });
    })
  );

  return router;
}
