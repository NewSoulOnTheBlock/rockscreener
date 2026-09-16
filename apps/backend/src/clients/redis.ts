import { Redis } from 'ioredis';
import { env } from '../config/load.js';
import { errField, logger } from '../infra/logger.js';

/**
 * Redis, and the product works without it.
 *
 * EVERYTHING KEPT HERE IS RECONSTRUCTIBLE: response caches, rate-limit windows,
 * sign-in challenges and the single-writer lock. Nothing that cannot be
 * recomputed from Postgres is ever written here, which is what lets the
 * connection be optional rather than a hard dependency — a deployment with no
 * Redis loses the cache and the multi-replica guarantees, not its data.
 *
 * The ONE thing that degrades meaningfully is the sign-in challenge: with two
 * gateway replicas and no shared store, `/auth/nonce` and `/auth/verify` land
 * on different processes and every sign-in fails. See `auth.ts`.
 */
export type RedisClient = Redis;

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;
  const url = env.redisUrl;
  if (!url) return null;

  client = new Redis(url, {
    maxRetriesPerRequest: 2,
    // Commands issued before the socket is up queue rather than throw, which is
    // what a boot sequence that starts workers immediately actually needs.
    enableOfflineQueue: true,
    lazyConnect: false,
  });
  client.on('error', (err: unknown) => logger.warn({ err: errField(err) }, 'redis error'));
  return client;
}

/**
 * A single-writer lock, held by renewal rather than by luck.
 *
 * Used by the trader: exactly one process may hold custodial keys and broadcast
 * exits, because two would race to sell the same position and the second sale
 * would fail on a balance the first already spent. Without Redis this returns
 * true — a single-process deployment IS the single writer, and refusing to
 * start there would be the wrong failure.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const ok = await redis.set(key, process.pid.toString(), 'PX', ttlMs, 'NX');
  return ok === 'OK';
}

export async function renewLock(key: string, ttlMs: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.pexpire(key, ttlMs);
}

/**
 * Hands the lock back on a clean shutdown, so a replacement starts at once
 * instead of waiting out a TTL for a process that is already gone.
 *
 * ONLY IF WE STILL HOLD IT. Deleting the key unconditionally would let a
 * process that had already lost the lock — paused long enough for the TTL to
 * lapse and somebody else to take it — delete the NEW holder's lock on its way
 * out, leaving two traders with one set of keys between them. The compare-and-
 * delete is in Lua because a read followed by a delete is two round trips with
 * a gap in the middle, and the gap is the bug.
 */
export async function releaseLock(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      key,
      process.pid.toString()
    );
  } catch {
    // A lock that could not be released will lapse on its own. That is what the
    // TTL is for, and failing a shutdown over it would be worse.
  }
}

/** Cache-aside with a TTL. A miss on a broken Redis is a miss, never a throw. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  if (!redis) return produce();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // A cache that cannot be read is a cache miss, not an outage.
  }
  const value = await produce();
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Likewise: a cache that cannot be written still served the request.
  }
  return value;
}
