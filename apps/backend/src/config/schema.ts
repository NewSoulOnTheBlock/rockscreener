import { z } from 'zod';

/**
 * The shape of `configuration.json`, enforced at boot.
 *
 * PARSED ONCE, AT STARTUP, AND THE PROCESS REFUSES TO START IF IT IS WRONG.
 * Every number in that file is a threshold somebody's money moves through, and
 * the failure mode of an unvalidated config is not a crash — it is a typo'd
 * `minLiquidityUsd` of `"15000"` silently comparing a string to a number and a
 * call firing on a token with no liquidity at all.
 */

const ms = z.number().int().min(100);

export const ConfigSchema = z.object({
  ingestion: z.object({
    activation: z.object({
      minLiquidityUsd: z.number().min(0),
      minTxns24h: z.number().int().min(0),
    }),
    dormantAfterHours: z.number().min(1),
    pollIntervalMs: ms,
    /** DexScreener truncates past 30 mints per request, silently. */
    batchSize: z.number().int().min(1).max(30),
  }),

  sources: z.object({
    dexscreener: z.object({ minIntervalMs: ms, timeoutMs: ms }),
    rugcheck: z.object({ minIntervalMs: ms, timeoutMs: ms, cacheMinutes: z.number().min(1) }),
    jupiter: z.object({ minIntervalMs: ms, timeoutMs: ms }),
    pumpfun: z.object({ minIntervalMs: ms, timeoutMs: ms }),
    rpc: z.object({ minIntervalMs: z.number().int().min(0), timeoutMs: ms }),
  }),

  scoring: z.object({
    intervalMs: ms,
    batchSize: z.number().int().min(1).max(500),
    rescoreAfterSeconds: z.number().int().min(10),
    historyEpsilon: z.number().min(0),
  }),

  sellCheck: z.object({
    observedWindowHours: z.number().min(1),
    minDistinctSellers: z.number().int().min(1),
    probeUsd: z.number().min(1),
    maxImpactPct: z.number().min(0).max(100),
    recheckMinutes: z.number().min(1),
  }),

  calls: z.object({
    intervalMs: ms,
    minCoverage: z.number().min(0).max(100),
    minLiquidityUsd: z.number().min(0),
    maxMarketCapUsd: z.number().min(0),
    minHolders: z.number().int().min(0),
    minAgeSeconds: z.number().int().min(0),
    requireLaunchAnalyzed: z.boolean(),
    requireSellConfirmed: z.boolean(),
    rearmHours: z.number().min(0),
    trackHours: z.number().min(1),
    stagnantAfterMinutes: z.number().min(1),
    maxPriceChange5m: z.number(),
    maxPriceChange1h: z.number(),
    minVolume1hUsd: z.number().min(0),
    invalidateBelowScore: z.number().min(0).max(100),
    ruggedLiquidityDrop: z.number().min(0).max(1),
    sparkPoints: z.number().int().min(4).max(200),
  }),

  autotrade: z.object({
    enabled: z.boolean(),
    /**
     * The kill switch. It stops ENTRIES only — the exit loop keeps running,
     * because a switch that stranded people in whatever they were holding
     * would be the opposite of a safety control.
     */
    allowEntries: z.boolean(),
    entryTickMs: ms,
    exitTickMs: ms,
    maxOpenPositionsGlobal: z.number().int().min(1),
    candidatesPerTick: z.number().int().min(1).max(200),
    callFreshnessSeconds: z.number().int().min(30),
    gateCacheSeconds: z.number().int().min(10),
  }),

  gate: z.object({
    requiredUsd: z.number().min(0),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AutoTradeConfig = Config['autotrade'];
export type CallsConfig = Config['calls'];
export type ScoringConfig = Config['scoring'];
export type SellCheckConfig = Config['sellCheck'];
