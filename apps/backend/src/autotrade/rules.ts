import { z } from 'zod';
import { DEFAULT_AUTO_TRADE, ROCK_TIERS, type AutoTradeSettings, type RockTier } from '@rockscreener/shared';

/**
 * What a user is allowed to write down.
 *
 * THE CEILINGS ARE NOT PREFERENCES. `buyAmountLamports`,
 * `maxConcurrentPositions`, `maxSpendPerHourLamports` and
 * `dailyLossCapLamports` are all bounded here, and there is NO VALUE of any of
 * them meaning "unlimited". That is the one thing this schema exists for: the
 * failure mode of automated buying is not a bad trade, it is forty bad trades
 * in ninety seconds, and the only reliable place to stop that is before the
 * settings are stored.
 *
 * VALIDATED SERVER-SIDE EVEN THOUGH THE CLIENT VALIDATES TOO. The settings
 * arrive as JSON from a browser; the browser's copy of these rules is a
 * convenience for the person filling in the form, and this one is the rule.
 */

/**
 * Hard ceilings, in lamports.
 *
 * Twenty SOL a position and a hundred an hour are far above what anyone sensible
 * will set and far below what a typo can cost: the number this guards against is
 * the one with an extra three zeros, typed into a field whose units are lamports.
 */
const MAX_BUY_LAMPORTS = 20n * 1_000_000_000n;
const MAX_HOURLY_LAMPORTS = 100n * 1_000_000_000n;
const MAX_POSITIONS = 25;

function lamports(max: bigint, label: string) {
  return z
    .string()
    .regex(/^\d{1,20}$/, `${label} must be a whole number of lamports.`)
    .refine((v) => BigInt(v) > 0n, `${label} must be greater than zero.`)
    .refine((v) => BigInt(v) <= max, `${label} is above the ceiling this deployment allows.`);
}

/**
 * The tier names, taken from the bands rather than typed out again — so adding
 * a band cannot leave a tier a user is unable to select.
 */
const tier = z.enum(ROCK_TIERS.map((t) => t.tier) as [RockTier, ...RockTier[]]);

/** A Solana address, by shape. Case is significant in base58 and is preserved. */
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Not a Solana address.');

const pct = z.number().min(0).max(100).nullable();
const positive = z.number().min(0).nullable();

const EntrySchema = z.object({
  minScore: z.number().min(0).max(100),
  allowedTiers: z.array(tier).max(ROCK_TIERS.length),
  allowedLaunchpads: z.array(z.string().max(24)).max(20),
  minLiquidityUsd: positive,
  minMarketCapUsd: positive,
  maxMarketCapUsd: positive,
  minAgeSeconds: z.number().int().min(0).max(2_592_000).nullable(),
  maxAgeSeconds: z.number().int().min(0).max(2_592_000).nullable(),
  minHolders: z.number().int().min(0).nullable(),
  minUniqueTraders: z.number().int().min(0).nullable(),
  maxBundledPct: pct,
  maxClusteredPct: pct,
  maxCreatorPct: pct,
  maxTop10Pct: pct,
  requireMintRevoked: z.boolean(),
  requireFreezeRevoked: z.boolean(),
  requireLpSecured: z.boolean(),
  maxTransferFeeBps: z.number().int().min(0).max(10_000).nullable(),
  requireSellConfirmed: z.boolean(),
  maxSellImpactPct: z.number().min(0).max(100).nullable(),
  blockCreatorReputation: z.array(z.enum(['suspect', 'serial_rugger'])).max(2),
  blockedCreators: z.array(address).max(200),
  reentryCooldownSeconds: z.number().int().min(0).max(604_800),
});

const ExitSchema = z.object({
  exitOnRugSignal: z.boolean(),
  exitOnCallWithdrawn: z.boolean().default(true),
  exitBelowScore: z.number().min(0).max(100).nullable(),
  stopLossPct: z.number().min(1).max(99).nullable(),
  trailingStopPct: z.number().min(1).max(99).nullable(),
  takeProfit: z
    .array(z.object({ gainPct: z.number().min(1).max(100_000), sellPct: z.number().min(1).max(100) }))
    .max(6)
    /*
     * ASCENDING, and REJECTED rather than silently sorted for them.
     *
     * A ladder written out of order is far more likely to be a mistake about
     * what the fields mean than a deliberate choice, and reordering it would
     * hide that — the user would see their ladder redrawn and have to work out
     * why. Saying "these must go up" is one sentence and leaves them in control
     * of their own numbers.
     */
    .refine(
      (steps) => steps.every((s, i) => i === 0 || s.gainPct > (steps[i - 1]?.gainPct ?? 0)),
      'Take-profit rungs must be in ascending order of gain.'
    ),
  maxHoldSeconds: z.number().int().min(60).max(2_592_000).nullable(),
  minExitValueLamports: z.string().regex(/^\d{1,20}$/),
});

export const AutoTradeRulesSchema = z.object({
  buyAmountLamports: lamports(MAX_BUY_LAMPORTS, 'Position size'),
  maxConcurrentPositions: z.number().int().min(1).max(MAX_POSITIONS),
  maxSpendPerHourLamports: lamports(MAX_HOURLY_LAMPORTS, 'Hourly spend cap'),
  dailyLossCapLamports: lamports(MAX_HOURLY_LAMPORTS, 'Daily loss cap'),
  slippageBps: z.number().int().min(10).max(5_000),
  maxPriorityFeeLamports: lamports(1n * 1_000_000_000n, 'Priority fee ceiling'),
  entry: EntrySchema,
  exit: ExitSchema,
});

export type AutoTradeRules = z.infer<typeof AutoTradeRulesSchema>;

/** The rules half of the settings — everything that is not its own column. */
export function rulesOf(settings: AutoTradeSettings): AutoTradeRules {
  const { enabled: _e, walletId: _w, disarmedAt: _d, disarmedReason: _r, ...rules } = settings;
  return rules as AutoTradeRules;
}

export const DEFAULT_RULES: AutoTradeRules = rulesOf(DEFAULT_AUTO_TRADE);

/**
 * Parse stored JSON back into rules, falling back to the defaults FIELD BY
 * FIELD rather than wholesale.
 *
 * WHY NOT JUST THROW. This runs on the engine's hot path, over rows written by
 * earlier versions of this schema. A row that fails to parse because a field
 * was added since it was saved must not take a user's engine offline —
 * especially not while they hold open positions the exit loop is responsible
 * for. Merging over the defaults keeps every field the row does have and fills
 * the rest with the conservative value.
 *
 * THE API PATH DOES NOT USE THIS. A user saving settings gets a real validation
 * error naming the field, because there the input is a request and a rejection
 * is information.
 */
export function readRules(raw: unknown): AutoTradeRules {
  const direct = AutoTradeRulesSchema.safeParse(raw);
  if (direct.success) return direct.data;

  const merged = AutoTradeRulesSchema.safeParse({
    ...DEFAULT_RULES,
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
    entry: { ...DEFAULT_RULES.entry, ...pick(raw, 'entry') },
    exit: { ...DEFAULT_RULES.exit, ...pick(raw, 'exit') },
  });
  return merged.success ? merged.data : DEFAULT_RULES;
}

function pick(raw: unknown, key: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
