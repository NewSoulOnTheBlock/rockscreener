import {
  DEFAULT_AUTO_TRADE,
  ROCK_GATE_USD,
  ROCK_MINT,
  type AutoPosition,
  type AutoTradeEvent,
  type AutoTradeSettings,
  type Call,
  type CallRecord,
  type Finding,
  type HolderRow,
  type RockGate,
  type RockScore,
  type SystemStatus,
  type TokenDetail,
  type TokenSummary,
  type TradingWallet,
} from '@rockscreener/shared';

/**
 * THE MOCK BENCH — the whole product with the chain unplugged.
 *
 * WHY IT EXISTS. The interface is the thing being argued about right now, and
 * an interface cannot be judged against three rows of lorem ipsum: the layout
 * questions that actually matter are "what does a row look like when the score
 * is null", "where does a 34% bundle warning go", "does the record strip still
 * read when half the calls lost money". So this file answers those with data
 * shaped exactly like the wire contract in @rockscreener/shared, INCLUDING its
 * nulls — there are unscored rows, unchecked sells and unmeasured pillars in
 * here on purpose, because those are the states the real feed spends most of
 * its time in and the ones a demo dataset always forgets.
 *
 * IT IS DETERMINISTIC. A seeded generator rather than `Math.random`, so the
 * same row is the same row on every reload and a screenshot can be compared
 * against the one before it. The ONLY thing that moves is the clock.
 *
 * WHEN THE BACKEND LANDS this file is deleted and `lib/api.ts` stops importing
 * it. Nothing else in the app knows it was ever here — every component takes
 * the shared types, never these constants.
 */

/** mulberry32: small, fast, and the same sequence in every browser. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = seeded(0x52_4f_43_4b); // "ROCK"

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
const int = (lo: number, hi: number): number => Math.floor(between(lo, hi + 1));
const chance = (p: number): boolean => rnd() < p;

/** Base58-ish, and never a real mint: these must not resolve on an explorer. */
function fakeMint(suffix = ''): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 44 - suffix.length; i += 1) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out + suffix;
}

const NAMES: [string, string][] = [
  ['Granite', 'GRNT'], ['Basalt', 'BSLT'], ['Obsidian', 'OBSD'], ['Quartzite', 'QRTZ'],
  ['Moondust', 'DUST'], ['Bedrock', 'BDRK'], ['Flintlock', 'FLINT'], ['Slate Runner', 'SLATE'],
  ['Pebble', 'PEB'], ['Magma Cat', 'MAGMA'], ['Geode', 'GEODE'], ['Tuff', 'TUFF'],
  ['Shale Whale', 'SHALE'], ['Gneiss Guy', 'GNEISS'], ['Pumice', 'PUM'], ['Chalk', 'CHALK'],
  ['Marble Dog', 'MRBL'], ['Sandstone', 'SAND'], ['Anthracite', 'ANTH'], ['Cobble', 'COBL'],
  ['Limestone', 'LIME'], ['Feldspar', 'FELD'], ['Mica Drop', 'MICA'], ['Onyx', 'ONYX'],
  ['Schist Posting', 'SCHIST'], ['Dolomite', 'DOLO'], ['Gabbro', 'GABRO'], ['Rhyolite', 'RHYO'],
];

const LAUNCHPADS = ['pumpfun', 'pumpfun', 'pumpfun', 'moonshot', 'believe', 'boop', 'raydium'] as const;

const WARNINGS = [
  '31.4% of supply sits in 3 wallet clusters sharing one funding source.',
  'The freeze authority is still live — your token account can be frozen.',
  'The top ten wallets hold 58% of supply.',
  'Liquidity is 1.8% of the valuation being asked — the exit is far smaller than the price implies.',
  '24.6% of supply was taken in the first traded slot by 11 wallets.',
  'Nothing has confirmed this token can be sold yet.',
  'The creator still holds 17.2% of supply.',
  'Only 19 distinct wallets traded today.',
];

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function makeFindings(score: number, mint: string): Finding[] {
  const out: Finding[] = [];
  if (score < 55) {
    out.push({
      code: 'funding_cluster', pillar: 'launch', severity: score < 40 ? 'critical' : 'high',
      message: WARNINGS[0]!, delta: 28,
    });
  }
  if (score < 45) {
    out.push({
      code: 'freeze_authority', pillar: 'safety', severity: 'critical',
      message: WARNINGS[1]!, delta: 40,
    });
  }
  if (score < 70) {
    out.push({
      code: 'concentrated', pillar: 'distribution', severity: 'medium',
      message: WARNINGS[2]!, delta: 14,
    });
  }
  if (score >= 60) {
    out.push({
      code: 'lp_burnt', pillar: 'liquidity', severity: 'good',
      message: 'The LP tokens are burnt — the liquidity cannot be pulled.', delta: -15,
    });
    out.push({
      code: 'authorities_revoked', pillar: 'safety', severity: 'good',
      message: 'Mint and freeze authorities are both revoked.', delta: -14,
    });
  }
  if (score >= 75) {
    out.push({
      code: 'sell_confirmed', pillar: 'safety', severity: 'good',
      message: '7 unrelated wallets have sold in the last six hours.', delta: -22,
    });
    out.push({
      code: 'clean_open', pillar: 'launch', severity: 'good',
      message: 'Nothing unusual happened in the first traded slot.', delta: -18,
    });
  }
  return out.map((f) => ({ ...f, code: `${f.code}` })).slice(0, mint.length % 2 === 0 ? 6 : 5);
}

function makeToken(i: number): TokenSummary {
  const [name, symbol] = NAMES[i % NAMES.length]!;
  const mint = fakeMint(chance(0.6) ? 'pump' : '');

  /*
   * THE SHAPE OF THE DISTRIBUTION IS THE POINT.
   *
   * Roughly one row in six has no score at all and one in four scores below 40,
   * because that is what a launch feed actually looks like. A mock where every
   * token grades 70+ produces a screen that never has to answer "what does a
   * bad row look like", which is the row the reader most needs to recognise.
   */
  const scored = i % 6 !== 5;
  const base = i < 8 ? between(74, 93) : i < 34 ? between(52, 86) : between(11, 76);
  const score = Math.round(base * 10) / 10;
  const coverage = i < 34 ? int(70, 100) : int(34, 94);
  const provisional = coverage < 60;

  const age = i < 24 ? between(20, 5_000) : between(300, 1_400_000);
  /*
   * A SLICE OF ROWS HAS NO MARKET AT ALL, because that is what the real feed
   * looks like: a mint discovered seconds ago has no pool, so it has no price,
   * no valuation and no depth — and the wire carries NULL for each rather than
   * zero. Without these rows the fixture never exercises the em dash, and the
   * "$0" bug this replaced would be invisible in the demo.
   */
  const unlisted = i % 9 === 8;
  const mcap = unlisted ? null : between(9_000, 2_400_000);
  const liq = mcap === null ? null : mcap * between(0.02, 0.22);
  const supply = 1_000_000_000;
  const price = mcap === null ? null : mcap / supply;
  const bonding = chance(0.28);

  const tier =
    score >= 82 ? 'diamond' : score >= 68 ? 'solid' : score >= 50 ? 'rough' : score >= 32 ? 'brittle' : 'dust';

  // A call requires a market, so an unlisted row can never carry one.
  const called = !unlisted && scored && !provisional && score >= 68 && chance(0.55);
  const peak = between(1.0, called ? 6.5 : 2);
  const current = peak * between(0.22, 1.0);

  const buys = int(40, 3_000);
  const sells = Math.round(buys * between(0.5, 1.4));

  return {
    mint,
    launchpad: pick(LAUNCHPADS),
    tier: bonding ? 'ACTIVE' : 'GRADUATED',
    status: bonding ? 'BONDING' : 'MIGRATED',
    name,
    symbol,
    nameState: 'named',
    imageUrl: null,
    creator: fakeMint(),
    launchTime: iso(age * 1000),
    lastActivityAt: iso(between(2, 400) * 1000),
    migratedAt: bonding ? null : iso(between(600, age) * 1000),
    // Null on a slice of them: the curve account is not read instantly, and
    // the card has to draw that state.
    progressBps: bonding ? (i % 7 === 3 ? null : int(1_200, 9_800)) : 0,
    priceUsd: price,
    priceSol: price === null ? null : price / 214,
    marketCapUsd: mcap,
    liquidityUsd: liq,
    fdvUsd: mcap,
    // Volume buckets are counts we maintain ourselves, so zero IS the reading.
    volume5mUsd: (liq ?? 0) * between(0.02, 0.9),
    volume1hUsd: (liq ?? 0) * between(0.1, 4),
    volume6hUsd: (liq ?? 0) * between(0.4, 9),
    volume24hUsd: (liq ?? 0) * between(0.8, 22),
    priceChange5m: between(-18, 24),
    priceChange1h: between(-42, 68),
    priceChange6h: between(-64, 180),
    priceChange24h: between(-82, 460),
    txns24h: buys + sells,
    buys24h: buys,
    sells24h: sells,
    /* Null on the youngest rows: nobody has run the distinct-trader pass yet. */
    traders24h: age < 900 ? null : int(12, 1_400),
    holderCount: age < 600 ? null : int(14, 6_400),
    top10Pct: age < 600 ? null : between(8, 74),
    creatorPct: age < 600 ? null : between(0, 22),
    risk: score >= 68 ? 'safe' : score >= 45 ? 'warning' : scored ? 'danger' : 'unknown',
    riskWarnings: scored ? int(0, 5) : 0,
    rock: scored
      ? {
          score,
          tier,
          coverage,
          topWarning: score < 72 ? pick(WARNINGS) : null,
          bundledPct: chance(0.85) ? between(0.4, 42) : null,
          clusteredPct: chance(0.7) ? between(0, 38) : null,
          /* Tri-state, and the null is a third of the rows on purpose. */
          sellOk: chance(0.62) ? true : chance(0.5) ? null : false,
          computedAt: iso(between(5, 240) * 1000),
        }
      : null,
    call: called
      ? {
          tier: score >= 82 ? 'strong_buy' : 'buy',
          calledAt: iso(between(120, 86_400) * 1000),
          entryMarketCapUsd: (mcap ?? 0) / current,
          // Derived from the entry so the three caps stay internally consistent
          // — a mock where peak < now would put a shape on the screen that the
          // real pipeline can never produce.
          peakMarketCapUsd: ((mcap ?? 0) / current) * peak,
          lastMarketCapUsd: mcap ?? 0,
          peakMultiple: peak,
          currentMultiple: current,
          outcome: current < 0.25 ? 'rugged' : chance(0.2) ? 'invalidated' : 'live',
        }
      : null,
    hasSocials: chance(0.55),
    dexPaid: chance(0.35) ? chance(0.3) : null,
    dexPaidTypes: chance(0.15) ? ['tokenProfile'] : [],
    boosts: chance(0.12) ? int(10, 500) : 0,
    dexId: bonding ? 'pumpfun' : pick(['raydium', 'pumpswap', 'meteora']),
    poolAddress: fakeMint(),
  };
}

/**
 * HOW MANY ROWS, AND WHY IT IS THIS MANY.
 *
 * A trench column shows perhaps nine cards at a time and the reader scrolls it;
 * a fixture of twenty produces a column that runs out, which is a layout nobody
 * ever has to solve in production and a screenshot that looks like an empty
 * product. Two hundred and forty is enough that all three columns scroll for a
 * long way, that the search returns plausible numbers of matches, and that the
 * distribution below (one row in six unscored, a third with no sell check) is
 * actually visible as a distribution rather than as three odd rows.
 */
export const MOCK_TOKENS: TokenSummary[] = Array.from({ length: 240 }, (_, i) => makeToken(i));

/** The calls lane: only tokens that actually carry a call, newest first. */
export const MOCK_CALLED: TokenSummary[] = MOCK_TOKENS.filter((t) => t.call).sort(
  (a, b) => Date.parse(b.call!.calledAt) - Date.parse(a.call!.calledAt)
);

export const MOCK_CALLS: Call[] = MOCK_CALLED.map((t, i) => ({
  id: `call_${i}`,
  mint: t.mint,
  symbol: t.symbol,
  name: t.name,
  imageUrl: null,
  tier: t.call!.tier,
  score: t.rock!.score,
  coverage: t.rock!.coverage,
  headline: t.rock!.topWarning,
  calledAt: t.call!.calledAt,
  entryPriceUsd: (t.priceUsd ?? 0) / t.call!.currentMultiple,
  entryMarketCapUsd: t.call!.entryMarketCapUsd,
  entryLiquidityUsd: (t.liquidityUsd ?? 0) * 0.7,
  peakPriceUsd: ((t.priceUsd ?? 0) / t.call!.currentMultiple) * t.call!.peakMultiple,
  peakMarketCapUsd: t.call!.entryMarketCapUsd * t.call!.peakMultiple,
  peakAt: t.call!.calledAt,
  peakMultiple: t.call!.peakMultiple,
  lastPriceUsd: t.priceUsd ?? 0,
  lastMarketCapUsd: t.marketCapUsd ?? 0,
  currentMultiple: t.call!.currentMultiple,
  maxDrawdownPct: -Math.min(94, Math.round((1 - t.call!.currentMultiple / t.call!.peakMultiple) * 100)),
  outcome: t.call!.outcome,
  closedAt: t.call!.outcome === 'live' ? null : t.call!.calledAt,
  closeReason: t.call!.outcome === 'rugged' ? 'Liquidity left the pool.' : null,
  spark: sparkFor(t.call!.peakMultiple, t.call!.currentMultiple),
}));

/**
 * A plausible path from 1.0 up to the peak and back to where it is now.
 *
 * Deliberately not a random walk: a call's shape is the one thing the card is
 * asserting, so the series is CONSTRAINED to pass through the two facts the
 * card also prints — it peaks at `peak` and ends at `now`. A sparkline whose
 * high disagreed with the "peak 6.21x" printed beside it would be worse than no
 * sparkline at all.
 */
function sparkFor(peak: number, now: number): number[] {
  const points = 26;
  const peakAt = Math.floor(points * between(0.3, 0.7));
  const out: number[] = [];
  for (let i = 0; i < points; i += 1) {
    const base =
      i <= peakAt
        ? 1 + (peak - 1) * (i / Math.max(1, peakAt))
        : peak + (now - peak) * ((i - peakAt) / Math.max(1, points - 1 - peakAt));
    // A little noise, scaled to the move, so it reads as a market rather than
    // as two straight lines.
    out.push(Math.max(0.02, base * (1 + between(-0.06, 0.06) * Math.min(1, peak - 0.9))));
  }
  out[0] = 1;
  out[points - 1] = now;
  return out;
}

/**
 * The record, with the losses in it.
 *
 * `medianPeakMultiple` and `medianCurrentMultiple` are BOTH here and the gap
 * between them is the honest measure of a feed like this: a product that
 * publishes only the peaks is showing the best moment of every call it ever
 * made.
 */
export const MOCK_RECORD: CallRecord = {
  tier: 'all',
  windowHours: 168,
  calls: MOCK_CALLS.length,
  successCount: MOCK_CALLS.filter((c) => c.peakMultiple >= 1.25).length,
  hit2xPct: Math.round((MOCK_CALLS.filter((c) => c.peakMultiple >= 2).length / MOCK_CALLS.length) * 100),
  hit5xPct: Math.round((MOCK_CALLS.filter((c) => c.peakMultiple >= 5).length / MOCK_CALLS.length) * 100),
  drawdown50Pct: Math.round((MOCK_CALLS.filter((c) => c.maxDrawdownPct <= -50).length / MOCK_CALLS.length) * 100),
  medianPeakMultiple: median(MOCK_CALLS.map((c) => c.peakMultiple)),
  medianCurrentMultiple: median(MOCK_CALLS.map((c) => c.currentMultiple)),
  ruggedCount: MOCK_CALLS.filter((c) => c.outcome === 'rugged').length,
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mockScore(t: TokenSummary): RockScore | null {
  if (!t.rock) return null;
  const s = t.rock.score;
  /* Pillars that are genuinely null on the thinner rows — the UI must draw the
     missing ones as cut-out chips rather than as short bars. */
  const measured = (v: number, when: boolean): number | null => (when ? Math.round(v) : null);
  return {
    mint: t.mint,
    score: s,
    tier: t.rock.tier,
    pillars: {
      safety: measured(Math.min(100, s + between(-12, 14)), true),
      launch: measured(Math.min(100, s + between(-22, 10)), t.rock.bundledPct !== null),
      liquidity: measured(Math.min(100, s + between(-8, 18)), t.liquidityUsd !== null),
      distribution: measured(Math.min(100, s + between(-18, 12)), t.holderCount !== null),
      momentum: measured(Math.min(100, s + between(-25, 20)), t.txns24h > 20),
    },
    coverage: t.rock.coverage,
    clamped:
      s < 32
        ? { at: 25, reason: 'The liquidity can be removed in one transaction.' }
        : null,
    findings: makeFindings(s, t.mint),
    launch: {
      analyzed: t.rock.bundledPct !== null,
      bundledPct: t.rock.bundledPct,
      bundleWallets: t.rock.bundledPct !== null ? int(2, 24) : null,
      sniperPct: t.rock.bundledPct !== null ? between(2, 44) : null,
      sniperWallets: t.rock.bundledPct !== null ? int(3, 90) : null,
      clusteredPct: t.rock.clusteredPct,
      clusters: t.rock.clusteredPct !== null ? int(1, 6) : null,
      stillHeldPct: t.rock.bundledPct !== null ? t.rock.bundledPct * between(0.1, 0.9) : null,
      creatorPct: t.creatorPct,
      creatorLinkedPct: chance(0.5) ? between(0, 14) : null,
      bundleSlot: 312_004_118,
      launchSlot: 312_004_101,
    },
    creator: chance(0.6)
      ? {
          address: t.creator,
          tokensLaunched: int(1, 14),
          rugged: int(0, 6),
          survived: int(0, 4),
          reputation: pick(['trusted', 'neutral', 'suspect', 'serial_rugger', null] as const),
        }
      : null,
    sell: {
      ok: t.rock.sellOk,
      via: t.rock.sellOk === true ? pick(['observed_sells', 'route_quote'] as const) : null,
      impactPct: t.rock.sellOk === true ? between(0.4, 11) : null,
      effectiveTaxBps: t.rock.sellOk === true ? int(0, 400) : null,
      checkedAt: t.rock.sellOk === null ? null : iso(between(20, 900) * 1000),
    },
    computedAt: t.rock.computedAt,
    previousScore: chance(0.7) ? Math.round((s + between(-9, 9)) * 10) / 10 : null,
  };
}

export function mockDetail(t: TokenSummary): TokenDetail {
  return {
    ...t,
    description:
      'A rock. Indexed, graded and tracked like everything else here — this description is mock copy and the row it sits on is not a real token.',
    websiteUrl: t.hasSocials ? 'https://example.com' : null,
    twitterUrl: t.hasSocials ? 'https://x.com/example' : null,
    telegramUrl: null,
    decimals: 6,
    totalSupply: '1000000000000000',
    transferFeeBps: chance(0.08) ? int(100, 900) : 0,
    mintAuthority: null,
    freezeAuthority: chance(0.18) ? fakeMint() : null,
    mintAuthorityRevoked: chance(0.9),
    freezeAuthorityRevoked: chance(0.82),
    metadataMutable: chance(0.4),
    lpLockedPct: chance(0.8) ? between(0, 100) : null,
    lpLockedUsd: t.liquidityUsd === null ? null : t.liquidityUsd * 0.9,
    marketCount: int(1, 4),
    allTimeHighUsd: t.priceUsd === null ? null : t.priceUsd * between(1, 7),
    allTimeHighAt: iso(between(600, 90_000) * 1000),
    launchTx: null,
    explorerUrl: `https://solscan.io/token/${t.mint}`,
  };
}

export function mockHolders(t: TokenSummary): HolderRow[] {
  const rows: HolderRow[] = [
    { address: t.poolAddress!, amount: '0', pct: between(28, 62), kind: 'amm', label: 'Raydium pool', rank: 1 },
  ];
  let rank = 2;
  let left = 100 - rows[0]!.pct;
  while (rank <= 12 && left > 0.4) {
    const p = Math.min(left, between(0.3, left / 2.2));
    rows.push({
      address: fakeMint(),
      amount: '0',
      pct: p,
      kind: rank === 2 && (t.creatorPct ?? 0) > 3 ? 'creator' : 'wallet',
      label: rank === 2 && (t.creatorPct ?? 0) > 3 ? 'Creator' : null,
      rank,
    });
    left -= p;
    rank += 1;
  }
  return rows;
}

/**
 * The gate, LOCKED by default in the mock.
 *
 * Deliberately: the locked state is the one every new visitor sees and the one
 * that has to be designed properly, and a demo that ships unlocked means nobody
 * ever looks at it. `/auto?gate=open` flips it — see `lib/api.ts`.
 */
export function mockGate(unlocked: boolean): RockGate {
  const price = 0.00418;
  const held = unlocked ? 164_500 : 41_200;
  return {
    unlocked,
    requiredUsd: ROCK_GATE_USD,
    heldUsd: held * price,
    heldTokens: held,
    missingUsd: Math.max(0, ROCK_GATE_USD - held * price),
    priceUsd: price,
    wallets: [
      { address: fakeMint(), kind: 'custodial', tokens: Math.round(held * 0.35) },
      { address: fakeMint(), kind: 'linked', tokens: Math.round(held * 0.65) },
    ],
    reason: unlocked
      ? null
      : `Auto-trade needs $${ROCK_GATE_USD} of ROCK held. You are $${Math.round(
          ROCK_GATE_USD - held * price
        )} short.`,
    checkedAt: iso(9_000),
  };
}

export const MOCK_ROCK_MINT = ROCK_MINT;

export const MOCK_SETTINGS: AutoTradeSettings = {
  ...DEFAULT_AUTO_TRADE,
  enabled: false,
  walletId: 'w_1',
};

export const MOCK_WALLETS: TradingWallet[] = [
  {
    id: 'w_1',
    address: fakeMint(),
    label: 'Engine wallet',
    solLamports: '2841000000',
    rockTokens: 57_600,
    isDefault: true,
    exportable: true,
    createdAt: iso(86_400_000 * 9),
  },
];

export const MOCK_POSITIONS: AutoPosition[] = MOCK_CALLED.slice(0, 4).map((t, i) => {
  const spent = 50_000_000;
  const pnlPct = [142.4, -21.8, 38.1, -9.2][i] ?? 0;
  return {
    id: `p_${i}`,
    mint: t.mint,
    symbol: t.symbol,
    imageUrl: null,
    status: i === 3 ? 'closed' : 'open',
    spentLamports: String(spent),
    receivedLamports: i === 3 ? String(Math.round(spent * 0.908)) : '0',
    amount: '412000000000',
    decimals: 6,
    entryPriceUsd: (t.priceUsd ?? 0) / (1 + pnlPct / 100),
    highPriceUsd: (t.priceUsd ?? 0) * 1.12,
    lastPriceUsd: t.priceUsd ?? 0,
    pnlLamports: String(Math.round((spent * pnlPct) / 100)),
    pnlPct,
    entryScore: t.rock?.score ?? 0,
    filledSteps: pnlPct > 50 ? [0] : [],
    openedAt: iso((i + 1) * 3_600_000),
    closedAt: i === 3 ? iso(900_000) : null,
    closeReason: i === 3 ? 'Down 9.2% from entry.' : null,
  };
});

/**
 * The event log, and MOST OF IT IS REFUSALS.
 *
 * That ratio is the design brief for this screen rather than an accident of the
 * mock. "Why didn't it buy that one" is the first question anybody asks of an
 * automated buyer, and a log that shows only the fills cannot answer it — so
 * the skipped rows are the default view, name the rule, and carry both numbers.
 */
export const MOCK_EVENTS: AutoTradeEvent[] = [
  { id: 'e1', at: iso(38_000), kind: 'skipped', mint: MOCK_TOKENS[3]!.mint, symbol: MOCK_TOKENS[3]!.symbol, rule: 'entry.maxBundledPct', message: 'Supply taken in the first traded slot is 34.1%, above your 20%.', signature: null },
  { id: 'e2', at: iso(96_000), kind: 'bought', mint: MOCK_TOKENS[1]!.mint, symbol: MOCK_TOKENS[1]!.symbol, rule: null, message: 'Bought 0.05 SOL at a $84.2K market cap on a Strong buy.', signature: fakeMint() },
  { id: 'e3', at: iso(141_000), kind: 'skipped', mint: MOCK_TOKENS[7]!.mint, symbol: MOCK_TOKENS[7]!.symbol, rule: 'entry.requireSellConfirmed', message: 'Nothing has confirmed this token can be sold yet.', signature: null },
  { id: 'e4', at: iso(220_000), kind: 'sold', mint: MOCK_TOKENS[2]!.mint, symbol: MOCK_TOKENS[2]!.symbol, rule: 'exit.takeProfit[0]', message: 'Up 61% — taking 40% off at the +50% rung.', signature: fakeMint() },
  { id: 'e5', at: iso(304_000), kind: 'skipped', mint: MOCK_TOKENS[9]!.mint, symbol: MOCK_TOKENS[9]!.symbol, rule: 'entry.coverage', message: "The score is provisional — only 41% of it could be measured.", signature: null },
  { id: 'e6', at: iso(388_000), kind: 'skipped', mint: MOCK_TOKENS[12]!.mint, symbol: MOCK_TOKENS[12]!.symbol, rule: 'entry.requireFreezeRevoked', message: 'The freeze authority is still live.', signature: null },
  { id: 'e7', at: iso(470_000), kind: 'sold', mint: MOCK_TOKENS[5]!.mint, symbol: MOCK_TOKENS[5]!.symbol, rule: 'exit.exitOnRugSignal', message: 'Liquidity fell 91% from entry — closed the whole position.', signature: fakeMint() },
  { id: 'e8', at: iso(610_000), kind: 'skipped', mint: MOCK_TOKENS[15]!.mint, symbol: MOCK_TOKENS[15]!.symbol, rule: 'entry.minLiquidityUsd', message: 'Liquidity is $6,410, below your $15,000.', signature: null },
];

export const MOCK_STATUS: SystemStatus = {
  indexing: true,
  lagSeconds: 3,
  tokensTracked: 184_226,
  scoredLastHour: 1_412,
  callsLast24h: 11,
  tradingConfigured: true,
  engineAlive: true,
  solPriceUsd: 214.38,
  rockPriceUsd: 0.00418,
};
