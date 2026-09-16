import { loadConfig } from '../config/load.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * RugCheck — the security reading, and the ONLY third party that answers the
 * two questions no price feed can.
 *
 * WHAT IT IS USED FOR: the mint's authorities, the LP lock, the holder table
 * with AMM vaults already labelled, and — the valuable one — the INSIDER GRAPH,
 * which is RugCheck walking funding edges to find wallets that share a source.
 * That last one is the Solana form of the reading this product exists for, and
 * nothing else public computes it.
 *
 * WHAT IT IS NOT USED FOR: its own 0-1000 score. That number is somebody else's
 * weighting of somebody else's inputs, and importing it would make this
 * product's grade a thin wrapper around a black box it cannot explain. The
 * FACTS are taken; the verdict is computed here, where every weight is in a
 * pure function with a test beside it.
 *
 * EVERY FIELD IS NULLABLE AND A MISSING REPORT RETURNS null, not a default.
 * RugCheck does not cover every mint — brand new tokens are routinely absent —
 * and "no report" must reach the scorer as an unmeasured pillar rather than as
 * a clean one.
 */

const API = 'https://api.rugcheck.xyz/v1/tokens';
const cfg = loadConfig();
const spacer = new Spacer(cfg.sources.rugcheck.minIntervalMs);
const log = logger.child({ source: 'rugcheck' });

export interface HolderRow {
  address: string;
  amount: string;
  pct: number;
  kind: 'wallet' | 'amm' | 'locker' | 'burn' | 'creator' | 'unknown';
  label: string | null;
  rank: number;
}

export interface SecurityReport {
  /** NULL means the authority could not be read, not that it is revoked. */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  metadataMutable: boolean | null;
  /** Token-2022 transfer fee, basis points. */
  transferFeeBps: number | null;

  /** Top ten holders with AMM vaults, lockers and burn EXCLUDED. */
  top10Pct: number | null;
  creatorPct: number | null;
  holderCount: number | null;
  holders: HolderRow[];

  lpLockedPct: number | null;
  lpLockedUsd: number | null;
  marketCount: number;

  /** Supply held by wallets RugCheck's graph links to one funding source. */
  insiderPct: number | null;
  insiderNetworks: number | null;

  /** RugCheck's own flag that the token has already been pulled. */
  rugged: boolean | null;
  /** The raw risk list, so a finding can cite what produced it. */
  risks: { name: string; level: string; description?: string }[];
  /** Their score. Carried for reference and NOT used in the grade — see above. */
  rugcheckScore: number | null;
  launchpad: string | null;
  imageUrl: string | null;
}

/**
 * The accounts that are not people.
 *
 * The largest balance in almost every Solana token belongs to its own AMM
 * vault, and a concentration metric that counts it reports every healthy
 * graduated launch as one whale holding half the supply. RugCheck labels most
 * of them in `knownAccounts`; this is the classification applied to that.
 */
function classify(type: string | undefined, isCreator: boolean): HolderRow['kind'] {
  if (isCreator) return 'creator';
  switch (type) {
    case 'AMM':
      return 'amm';
    case 'LOCKER':
      return 'locker';
    case 'BURN':
      return 'burn';
    case undefined:
      return 'wallet';
    default:
      return 'unknown';
  }
}

export async function fetchReport(mint: string): Promise<SecurityReport | null> {
  await spacer.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.sources.rugcheck.timeoutMs);
  try {
    const res = await fetch(`${API}/${mint}/report`, { signal: controller.signal });
    if (res.status === 429) {
      spacer.backoff();
      return null;
    }
    // 400/404 mean RugCheck has never indexed this mint, which for a token
    // minutes old is the ordinary answer. Null, not an empty report.
    if (!res.ok) return null;
    return parse((await res.json()) as Record<string, any>);
  } catch (err) {
    log.debug({ mint, err: errField(err) }, 'report failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parse(data: Record<string, any>): SecurityReport {
  const known: Record<string, { type?: string; name?: string }> = data.knownAccounts ?? {};
  const topHolders: Record<string, any>[] = Array.isArray(data.topHolders) ? data.topHolders : [];
  const creator: string | null = data.creator ?? data.token?.mintAuthority ?? null;
  const supply = Number(data.token?.supply ?? 0);

  const holders: HolderRow[] = topHolders.slice(0, 20).map((h, i) => ({
    address: String(h.owner ?? h.address ?? ''),
    amount: String(h.amount ?? '0'),
    pct: Number(h.pct ?? 0),
    kind: classify(known[h.owner]?.type, creator !== null && h.owner === creator),
    label: known[h.owner]?.name ?? null,
    rank: i + 1,
  }));

  /*
   * Top TEN REAL holders. The slice is taken AFTER the pools, lockers and burn
   * address are dropped, so a token whose three biggest accounts are its own
   * markets is measured on its next ten wallets rather than on seven.
   */
  const realHolders = holders.filter((h) => h.kind === 'wallet' || h.kind === 'creator');
  const top10Pct = realHolders.length > 0
    ? realHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0)
    : null;

  // The LP lock is a property of a MARKET, and a token can trade in several.
  // The deepest locked position is the one that matters for an exit.
  const markets: Record<string, any>[] = Array.isArray(data.markets) ? data.markets : [];
  let lpLockedPct: number | null = null;
  let lpLockedUsd: number | null = null;
  for (const m of markets) {
    if (!m.lp) continue;
    const pct = Number(m.lp.lpLockedPct ?? 0);
    if (lpLockedPct === null || pct > lpLockedPct) {
      lpLockedPct = pct;
      lpLockedUsd = Number(m.lp.lpLockedUSD ?? 0);
    }
  }

  /*
   * THE INSIDER GRAPH, converted to a share of supply.
   *
   * RugCheck reports networks of wallets it has linked through funding, with
   * the token amount each network holds. Expressed as a percentage of supply it
   * is directly comparable with the bundle, which is the point: "31% of supply
   * sits behind one funder" is the sentence a trader can act on, and "4 insider
   * networks detected" is not.
   */
  const networks: Record<string, any>[] = Array.isArray(data.insiderNetworks)
    ? data.insiderNetworks
    : [];
  let insiderPct: number | null = null;
  if (supply > 0 && networks.length > 0) {
    insiderPct = networks.reduce((sum, n) => sum + (Number(n.tokenAmount ?? 0) / supply) * 100, 0);
  } else if (supply > 0) {
    // A report that ran and found no networks is a MEASUREMENT of zero, which
    // is a genuinely good sign and must not be confused with "not checked".
    insiderPct = 0;
  }

  const risks: SecurityReport['risks'] = (Array.isArray(data.risks) ? data.risks : []).map(
    (r: Record<string, any>) => ({
      name: String(r.name ?? r.description ?? 'risk'),
      level: String(r.level ?? 'info'),
      description: r.description ? String(r.description) : undefined,
    })
  );

  const creatorHolder = holders.find((h) => h.kind === 'creator');

  return {
    // `mintAuthority` and `freezeAuthority` are the ADDRESSES when live and
    // null when revoked, so the boolean is an inversion — and it is only a
    // reading at all when the report itself came back.
    mintAuthorityRevoked: data.token ? !data.token.mintAuthority : null,
    freezeAuthorityRevoked: data.token ? !data.token.freezeAuthority : null,
    metadataMutable: data.tokenMeta ? Boolean(data.tokenMeta.mutable) : null,
    transferFeeBps:
      data.transferFee?.pct !== undefined ? Math.round(Number(data.transferFee.pct) * 100) : null,

    top10Pct,
    creatorPct:
      creatorHolder?.pct ??
      (supply > 0 && data.creatorBalance !== undefined
        ? (Number(data.creatorBalance) / supply) * 100
        : null),
    holderCount: data.totalHolders !== undefined ? Number(data.totalHolders) : null,
    holders,

    lpLockedPct,
    lpLockedUsd,
    marketCount: markets.length,

    insiderPct,
    insiderNetworks: networks.length > 0 ? networks.length : supply > 0 ? 0 : null,

    rugged: data.rugged === undefined ? null : Boolean(data.rugged),
    risks,
    rugcheckScore: data.score !== undefined ? Number(data.score) : null,
    launchpad: data.launchpad?.name ?? null,
    imageUrl: data.fileMeta?.image ?? null,
  };
}
