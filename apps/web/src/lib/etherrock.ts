/**
 * The EtherRock snapshot — types, formatting and palette.
 *
 * THE DATA IS A SNAPSHOT, NOT A FEED. It is rebuilt offline by the indexer that
 * produced it and served as a static file, so nothing on this page polls, and
 * the timestamp in the masthead is the only honest claim about freshness. The
 * 2017 rock contract emits no events at all; every figure here was decoded from
 * raw transaction input and reconciled against the contract's own counters,
 * which is why `reconciliation` travels with the numbers rather than behind a
 * footnote.
 */

export type Rock = {
  id: number;
  custodian: string;
  forSale: boolean;
  askWei: string;
  askEth: number | null;
  timesSold: number;
  wrapped: boolean;
  owner: string;
  primaryPriceEth: number | null;
  saleCount: number;
  volumeEth: number;
  peakEth: number | null;
  lastSale: { ts: number; priceEth: number } | null;
  osListing: { priceEth: number } | null;
};

export type SaleEvent = {
  type: string;
  rockId: number;
  ts: number;
  priceEth: number;
  buyer?: string;
  block?: number;
  hidden?: boolean;
  preMigration?: boolean;
};

export type MonthRow = {
  month: string;
  sales: number;
  volumeEth: number;
  medianEth: number;
  maxEth: number;
};

export type Holder = { address: string; rocks: number[]; wrapped: number };

export type Affinity = {
  address: string;
  name: string | null;
  holderCount: number;
  totalTokens: number;
  floorEth: number | null;
};

export type Acquisition = { ts: string | number; name: string | null; tokenId?: string; holder: string };

export type Snapshot = {
  generatedAt: string;
  headBlock: number;
  contracts: { fixed: string; wrapper: string; genesis: string; migrationBlock: number };
  rocks: Rock[];
  summary: {
    totals: { supply: number; wrapped: number; unwrapped: number; uniqueHolders: number };
    contractMarket: { floorEth: number | null; floorRockId: number | null; listed: number; eligible: number };
    openseaMarket: { floorEth: number | null; floorRockId: number | null; listed: number; eligible: number };
    holders: Holder[];
    concentration: { top1: number; top5: number; top10: number; singletons: number };
  };
  events: SaleEvent[];
  monthly: MonthRow[];
  opensea: { sales?: { priceEth: number; ts: number | string; rockId: number; buyer?: string }[] };
  ghostMarket: { sales: number; volumeEth: number; firstTs: number } | null;
  affinity: Affinity[];
  acquisitions: Acquisition[];
  reconciliation: {
    onchainTimesSoldTotal: number;
    seededPreMigration: number;
    decodedPostMigration: number;
    recoveredHidden: number;
    unexplainedGaps: unknown[];
    complete: boolean;
  };
  totals: { lifetimeSales: number; lifetimeVolumeEth: number; peakSaleEth: number };
};

/* ---------------- formatting ---------------- */

export const nf = (v: number, d = 0): string =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * ETH, at six orders of magnitude.
 *
 * The collection's range runs from a 0.001 mint to a 234 ETH sale and one buy
 * at 444 *wei*, so a single fixed precision is wrong at one end or the other.
 * Below 0.0001 it goes exponential rather than rendering as a row of zeros,
 * which is the only form in which 444 wei reads as a number at all.
 */
export function eth(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v < 0.0001) return v.toExponential(2);
  if (v < 1) return nf(v, 4);
  if (v < 1000) return nf(v, v < 10 ? 2 : 0);
  return nf(v, 0);
}

export const short = (a: string | null | undefined): string =>
  a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

export const dstr = (ts: number | null | undefined): string =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—';

export const etherscan = (a: string): string => 'https://etherscan.io/address/' + a;

/* ---------------- palette ---------------- */

/**
 * THREE SERIES, TAKEN FROM THIS PRODUCT RATHER THAN BROUGHT WITH THE DATA.
 *
 * The source dashboard used a blue/orange/aqua set chosen for a light page. On
 * the bench that set belongs to nothing — so the two markets take the two
 * colours this product already treats as a pair (the same green and violet in
 * the wordmark and the account chip), and the orphaned 2017 sales take cyan,
 * which appears nowhere else and so cannot be mistaken for either venue.
 */
export const SERIES = {
  contract: 'var(--color-rock)',
  opensea: 'var(--color-action)',
  premigration: 'var(--color-cyan)',
} as const;

export const SERIES_ORDER = [SERIES.contract, SERIES.opensea, SERIES.premigration];
export const SERIES_NAME = ['Contract sale', 'OpenSea sale', 'Pre-migration (2017)'];

/**
 * The sequential ramp, seven steps, dark-only.
 *
 * It climbs out of the panel rather than out of white: step 0 is barely lifted
 * off `--color-raised` so an untraded rock reads as *absent* from the market
 * instead of as a dim member of the scale, and the top step is the brand green
 * at full strength. Ink is declared per step here because the page has exactly
 * one theme — there is no second palette for it to invert against.
 */
export const RAMP = ['#1b2b23', '#16452c', '#115c3a', '#0a9c60', '#10c87c', '#14f195', '#5cffc0'];
export const RAMP_INK = ['#9ea5ab', '#c8d2cd', '#e9ecee', '#04170e', '#04170e', '#04170e', '#04170e'];

export const rampStep = (value: number, max: number): number =>
  max ? Math.min(RAMP.length - 1, Math.round((value / max) * (RAMP.length - 1))) : 0;
