import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/clients/prisma.js';
import { loadConfig } from '../src/config/load.js';
import { Spacer } from '../src/infra/interval.js';

/**
 * DOES REFUSING AN EXTENDED ENTRY ACTUALLY HELP?
 *
 * The timing gates and the extension term in the momentum pillar were written
 * against one damning observation — of the first seventy-nine calls, forty-one
 * never traded above their entry price — and then given thresholds that were
 * chosen rather than measured. This settles them against history.
 *
 * WHY THIS BACKTEST IS POSSIBLE AT ALL, given that the product deliberately
 * stores no candles: every input to the timing rules is RECONSTRUCTIBLE from
 * GeckoTerminal's 5-minute OHLCV. `priceChange5m` is one bar, `priceChange1h`
 * is twelve, `volume1hUsd` is a twelve-bar sum. So the exact features the gate
 * reads can be replayed at every historical bar, and the forward return from
 * that bar measured. Nothing has to be stored to do it once.
 *
 * WHAT IT DOES NOT TEST, and the limit is worth stating plainly:
 *
 * - THE SLOW FACTS ARE TAKEN AS THEY ARE NOW. Safety, holders, liquidity and
 *   the launch analysis are not replayed — there is no history of them. So this
 *   measures the TIMING rules in isolation, which is exactly what changed, and
 *   says nothing about whether the quality gates are right.
 * - SURVIVORSHIP. The sample is tokens currently in the index with a live pool;
 *   the ones that died are not here. That makes every absolute number below
 *   optimistic. It does NOT damage the comparison, which is the point of the
 *   exercise: the passing and failing entries are drawn from the same tokens
 *   over the same bars, so the bias applies equally to both sides.
 *
 * THE BARS ARE CACHED ON DISK. Fetching them is rate-limited to thirty
 * requests a minute, so a first run over a hundred tokens takes minutes — and a
 * backtest you have to wait three minutes for is one nobody re-runs after
 * changing a threshold, which defeats the entire purpose of having it. Second
 * and later runs are instant. Delete `.backtest-cache` to refresh the window.
 *
 * Run:   pnpm tsx --env-file=../../.env scripts/backtest.ts [tokenCount]
 * Fresh: rm -rf .backtest-cache && pnpm tsx ... 
 */

const BASE = 'https://api.geckoterminal.com/api/v2';
// Their free tier publishes 30 requests a minute. One request per token.
const spacer = new Spacer(2_100);

/** 5-minute bars, so twelve of them is an hour. */
const BARS_PER_HOUR = 12;
/** How far ahead an entry is judged. */
const FORWARD_BARS = 12;
/** Bars of history needed before a bar can be scored at all. */
const LOOKBACK_BARS = BARS_PER_HOUR;

interface Bar {
  ts: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** One hypothetical entry: what was visible, and what happened next. */
interface Entry {
  symbol: string;
  change5m: number;
  change1h: number;
  volume1h: number;
  /** Best return available in the next hour, as a multiple. Nobody gets this. */
  peak: number;
  /** Where it was one hour later. This is the honest one. */
  after: number;
}

const CACHE = join(process.cwd(), '.backtest-cache');

async function ohlcv(pool: string): Promise<Bar[]> {
  const file = join(CACHE, `${pool}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Bar[];
  } catch {
    // Not cached yet, or unreadable. Either way, fetch it.
  }

  await spacer.wait();
  try {
    const res = await fetch(
      `${BASE}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000`,
      { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) {
      if (res.status === 429) spacer.backoff();
      return [];
    }
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = body.data?.attributes?.ohlcv_list ?? [];
    // Newest first in their response. Reversed here so index order is time order.
    const bars = list
      .slice()
      .reverse()
      .map((r) => ({ ts: r[0]!, close: r[4]!, high: r[2]!, low: r[3]!, volume: r[5]! }))
      .filter((b) => b.close > 0);

    /*
     * AN EMPTY RESULT IS CACHED TOO. A pool too new to have a history is the
     * usual answer for a good part of this sample, and without caching the
     * empty answer every re-run would pay the full rate-limited wait again for
     * tokens that will never have bars.
     */
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(bars));
    return bars;
  } catch {
    return [];
  }
}

/** Every bar of one token's history, as a candidate entry. */
function entriesFrom(symbol: string, bars: Bar[]): Entry[] {
  const out: Entry[] = [];
  for (let i = LOOKBACK_BARS; i < bars.length - FORWARD_BARS; i++) {
    const now = bars[i]!;
    const prev = bars[i - 1]!;
    const hourAgo = bars[i - BARS_PER_HOUR]!;
    if (!(now.close > 0) || !(prev.close > 0) || !(hourAgo.close > 0)) continue;

    let volume1h = 0;
    for (let j = i - BARS_PER_HOUR + 1; j <= i; j++) volume1h += bars[j]!.volume ?? 0;

    const forward = bars.slice(i + 1, i + 1 + FORWARD_BARS);
    if (forward.length < FORWARD_BARS) continue;

    out.push({
      symbol,
      change5m: (now.close / prev.close - 1) * 100,
      change1h: (now.close / hourAgo.close - 1) * 100,
      volume1h,
      peak: Math.max(...forward.map((b) => b.high)) / now.close,
      after: forward[forward.length - 1]!.close / now.close,
    });
  }
  return out;
}

/**
 * The summary of a set of entries.
 *
 * THE MEDIAN, NOT THE MEAN. One token that went 40x drags a mean anywhere you
 * like, and on this market that token exists in almost every sample — a mean
 * return would make every bucket look profitable and tell you nothing about the
 * entry you are actually about to make.
 *
 * `neverUp` is the statistic this whole exercise came from: the share of
 * entries whose price never traded above the entry price again, not once, in
 * the following hour.
 */
function summarise(label: string, rows: Entry[]): string {
  if (rows.length === 0) return `${label.padEnd(22)} ${String(0).padStart(6)}  —`;
  const sorted = (key: 'peak' | 'after'): number[] => rows.map((r) => r[key]).sort((a, b) => a - b);
  const median = (xs: number[]): number => xs[Math.floor(xs.length / 2)]!;

  const neverUp = rows.filter((r) => r.peak <= 1.001).length / rows.length;
  const up10 = rows.filter((r) => r.after >= 1.1).length / rows.length;
  const down20 = rows.filter((r) => r.after <= 0.8).length / rows.length;

  return [
    label.padEnd(22),
    String(rows.length).padStart(6),
    median(sorted('after')).toFixed(3).padStart(8),
    median(sorted('peak')).toFixed(3).padStart(8),
    `${(neverUp * 100).toFixed(0)}%`.padStart(8),
    `${(up10 * 100).toFixed(0)}%`.padStart(7),
    `${(down20 * 100).toFixed(0)}%`.padStart(8),
  ].join('');
}

const HEADER = [
  'bucket'.padEnd(22),
  'n'.padStart(6),
  'med +1h'.padStart(8),
  'med peak'.padStart(8),
  'never up'.padStart(8),
  '>+10%'.padStart(7),
  '<-20%'.padStart(8),
].join('');

async function main(): Promise<void> {
  const want = Number(process.argv[2] ?? 160);
  const cfg = loadConfig().calls;

  /*
   * THE SAMPLE IS THE ENGINE'S OWN CANDIDATE SET, not "all tokens". Backtesting
   * a timing rule over tokens the quality gates would have refused anyway
   * measures a rule that never runs.
   */
  const tokens = await prisma.token.findMany({
    where: {
      poolAddress: { not: null },
      score: { not: null },
      coverage: { gte: cfg.minCoverage },
      liquidityUsd: { gte: cfg.minLiquidityUsd },
      marketCapUsd: { lte: cfg.maxMarketCapUsd },
    },
    orderBy: { score: 'desc' },
    select: { symbol: true, poolAddress: true },
    take: want,
  });

  console.log(`sampling ${tokens.length} tokens that clear the quality gates\n`);

  const entries: Entry[] = [];
  let done = 0;
  for (const t of tokens) {
    const bars = await ohlcv(t.poolAddress!);
    entries.push(...entriesFrom(t.symbol, bars));
    if (++done % 20 === 0) console.log(`  ${done}/${tokens.length} — ${entries.length} entries`);
  }

  console.log(`\n${entries.length} hypothetical entries across ${tokens.length} tokens`);
  console.log('every row: enter at that bar, judged one hour later\n');

  // --- how far it had already run ------------------------------------------
  console.log('BY HOW FAR THE PRICE HAD ALREADY RUN IN THE PRECEDING HOUR');
  console.log(HEADER);
  const bands: [string, (e: Entry) => boolean][] = [
    ['falling <-20%', (e) => e.change1h < -20],
    ['soft -20..0%', (e) => e.change1h >= -20 && e.change1h < 0],
    ['calm 0..30%', (e) => e.change1h >= 0 && e.change1h < 30],
    ['rising 30..80%', (e) => e.change1h >= 30 && e.change1h < 80],
    ['hot 80..150%', (e) => e.change1h >= 80 && e.change1h < 150],
    ['ran 150..400%', (e) => e.change1h >= 150 && e.change1h < 400],
    ['vertical >400%', (e) => e.change1h >= 400],
  ];
  for (const [label, test] of bands) console.log(summarise(label, entries.filter(test)));

  // --- the last five minutes ------------------------------------------------
  console.log('\nBY THE LAST FIVE MINUTES ALONE');
  console.log(HEADER);
  const spikes: [string, (e: Entry) => boolean][] = [
    ['5m <0%', (e) => e.change5m < 0],
    ['5m 0..10%', (e) => e.change5m >= 0 && e.change5m < 10],
    ['5m 10..25%', (e) => e.change5m >= 10 && e.change5m < 25],
    ['5m 25..60%', (e) => e.change5m >= 25 && e.change5m < 60],
    ['5m >60%', (e) => e.change5m >= 60],
  ];
  for (const [label, test] of spikes) console.log(summarise(label, entries.filter(test)));

  /*
   * THE SWEEP IS THE POINT OF THE SCRIPT. Every row is a candidate value for
   * `calls.maxPriceChange1h`, scored on what it would have refused. A ceiling
   * that improves the median while refusing almost nothing is free; one that
   * only improves it by refusing ninety per cent of entries has not found a
   * rule, it has found a smaller sample.
   */
  console.log('\nSWEEP: maxPriceChange1h — what each ceiling would have let through');
  console.log(HEADER + '   refused');
  for (const ceiling of [40, 60, 80, 100, 120, 160, 200, 300, 500, Infinity]) {
    const kept = entries.filter((e) => e.change1h <= ceiling);
    const refused = ((1 - kept.length / entries.length) * 100).toFixed(0);
    const label = ceiling === Infinity ? 'no ceiling' : `<= ${ceiling}%`;
    console.log(`${summarise(label, kept)}${`${refused}%`.padStart(10)}`);
  }

  console.log('\nSWEEP: maxPriceChange5m');
  console.log(HEADER + '   refused');
  for (const ceiling of [10, 15, 20, 30, 50, 80, Infinity]) {
    const kept = entries.filter((e) => e.change5m <= ceiling);
    const refused = ((1 - kept.length / entries.length) * 100).toFixed(0);
    const label = ceiling === Infinity ? 'no ceiling' : `<= ${ceiling}%`;
    console.log(`${summarise(label, kept)}${`${refused}%`.padStart(10)}`);
  }

  // --- the gate as it is actually configured --------------------------------
  const passes = (e: Entry): boolean =>
    e.change5m <= cfg.maxPriceChange5m &&
    e.change1h <= cfg.maxPriceChange1h &&
    e.volume1h >= cfg.minVolume1hUsd;

  console.log('\nTHE GATE AS CONFIGURED RIGHT NOW');
  console.log(
    `  maxPriceChange5m ${cfg.maxPriceChange5m}%, maxPriceChange1h ${cfg.maxPriceChange1h}%, minVolume1hUsd $${cfg.minVolume1hUsd}`
  );
  console.log(HEADER);
  console.log(summarise('gate passes', entries.filter(passes)));
  console.log(summarise('gate refuses', entries.filter((e) => !passes(e))));
  console.log(summarise('no gate at all', entries));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
