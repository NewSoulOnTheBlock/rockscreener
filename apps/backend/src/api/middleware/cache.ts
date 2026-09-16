import type { RequestHandler } from 'express';

/**
 * A short response cache header for the anonymous read surface.
 *
 * FIVE SECONDS IS NOT A PERFORMANCE TWEAK, it is what makes a feed that polls
 * every five seconds cost one query instead of one per reader. `stale-while-
 * revalidate` means a burst never all waits on the same refresh.
 *
 * It is applied ONLY to routes with no session-dependent content. A cached
 * response that varied by user would be the worst bug in this file's power to
 * cause, so nothing under `/auto`, `/wallets` or `/auth` ever uses it.
 */
export function publicCache(seconds: number): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('cache-control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 3}`);
    next();
  };
}
