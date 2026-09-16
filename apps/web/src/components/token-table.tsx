'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ExternalLink } from 'lucide-react';
import { MIN_COVERAGE_FOR_VERDICT, type TokenSummary } from '@rockscreener/shared';
import { cn } from '@/lib/cn';
import { ago, compactNumber, multiple, pct, usd } from '@/lib/format';
import { silhouettePillars } from '@/lib/silhouette';
import { CoreStrip, TIER_TEXT } from '@/components/core-sample';
import { TokenAvatar } from '@/components/token-avatar';
import { Delta } from '@/components/chips';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * THE ASSAY TABLE.
 *
 * A TABLE, WITH REAL COLUMN HEADERS, and it is sortable — because the honest
 * shape of "everything we have indexed" is a table, and dressing a table up as
 * a feed of cards costs three times the vertical space to say the same thing.
 * The product's opinion lives in the call cards above; this is the evidence
 * underneath, and evidence should be scannable and sortable rather than
 * curated.
 *
 * WHAT THE COLUMNS ARE FOR, in order: the core (texture — full, empty, gappy),
 * the score, what it is, how new, what it is worth, how deep, how it is moving,
 * the two distribution numbers that actually kill trades, and — for a token
 * this product has CALLED — the three market caps of that call. Everything else
 * is in the drawer.
 *
 * THE THREE CALL COLUMNS ARE THREE COLUMNS, NOT ONE. A single cell reading
 * "2.4x, peak 3.1x" hides the only thing that makes a call checkable: the SIZE
 * of what was called. 3x from $40k and 3x from $40m are not the same claim, and
 * the second one is usually not a claim at all — so `Call MC` (frozen at the
 * moment of the call), `Now MC` and `Peak MC` each get their own sortable
 * column, and the multiple is computed by the reader's eye from two numbers
 * they can see rather than asserted by one they cannot check.
 *
 * THE NULL COLUMNS STAY NULL. An unscored token sorts to the bottom and prints
 * an em dash; it does not get a zero, and it is not hidden — the firehose is
 * what makes the calls above it checkable.
 */
export type SortKey =
  | 'score'
  | 'age'
  | 'marketCap'
  | 'liquidity'
  | 'volume24h'
  | 'change1h'
  | 'insider'
  | 'top10'
  | 'callMc'
  | 'nowMc'
  | 'peakMc';

interface Column {
  key: SortKey | null;
  label: string;
  hint?: string;
  /** Tailwind width + alignment for both the header and the cells. */
  cls: string;
}

const COLUMNS: Column[] = [
  { key: null, label: 'Core', hint: 'Five strata: safety, launch, liquidity, distribution, momentum. Width is weight, fill is score, hatching is a reading nobody has taken.', cls: 'w-[72px]' },
  { key: 'score', label: 'Score', cls: 'w-[58px] text-right' },
  { key: null, label: 'Token', cls: 'min-w-0 flex-1' },
  { key: 'age', label: 'Age', cls: 'w-[52px] text-right' },
  { key: 'marketCap', label: 'MCap', cls: 'w-[76px] text-right' },
  { key: 'liquidity', label: 'Liq', cls: 'w-[72px] text-right' },
  { key: 'volume24h', label: 'Vol 24h', cls: 'hidden @2xl:block w-[80px] text-right' },
  { key: 'change1h', label: '1h', cls: 'w-[64px] text-right' },
  /*
   * INSIDER, NOT BUNDLE, IN THE NARROW SLOT. Both are real readings and they
   * are different ones — bundle is supply taken in the first traded slot, which
   * needs a transaction-level indexer; insider is RugCheck walking funding
   * edges to find wallets that share a source. Without a Helius key the first
   * is null for every row in the index, and a column that is an em dash twelve
   * thousand times over is not honest reporting, it is dead width. The bundle
   * number keeps its own column at the width where there is room for both.
   */
  { key: 'insider', label: 'Insider', hint: 'Supply held by wallets RugCheck traced back to a shared funding source. An em dash means no report for this mint — not that none was found.', cls: 'hidden @xl:block w-[68px] text-right' },
  { key: 'top10', label: 'Top 10', hint: 'Top ten holders with AMM vaults, lockers and burn excluded.', cls: 'hidden @3xl:block w-[68px] text-right' },
  /*
   * ALL THREE APPEAR TOGETHER OR NOT AT ALL, AT @6xl. Three 76px columns plus
   * their gaps is 250px of the row, and hiding them one at a time as the window
   * narrows would leave a reader comparing a call cap against a peak with the
   * middle number missing — which is the one comparison that needs all three.
   * 1152px is where the fixed columns still leave the token name room to be a
   * name rather than an ellipsis.
   */
  { key: 'callMc', label: 'Call MC', hint: 'What it was worth at the moment of the call. Frozen — this number never moves again, which is what makes the call checkable.', cls: 'hidden @6xl:block w-[76px] text-right' },
  { key: 'nowMc', label: 'Now MC', hint: 'What the call is worth now, with the multiple against the call under it.', cls: 'hidden @6xl:block w-[76px] text-right' },
  { key: 'peakMc', label: 'Peak MC', hint: 'The highest the call ever reached. The number a feed that quotes only its winners is quoting.', cls: 'hidden @6xl:block w-[76px] text-right' },
  { key: null, label: '', cls: 'w-[26px]' },
];

export function sortTokens(rows: TokenSummary[], key: SortKey, desc: boolean): TokenSummary[] {
  const value = (t: TokenSummary): number | null => {
    switch (key) {
      case 'score':
        return t.rock?.score ?? null;
      case 'age':
        /*
         * Launch time, NOT age, and descending therefore means NEWEST FIRST.
         *
         * Worth stating because the column is labelled "Age" and the two run
         * opposite ways: a reader clicking the arrow down on Age is asking for
         * the freshest launches, and returning the age in seconds here would
         * hand them the oldest rows in the index.
         */
        return Date.parse(t.launchTime);
      case 'marketCap':
        return t.marketCapUsd;
      case 'liquidity':
        return t.liquidityUsd;
      case 'volume24h':
        return t.volume24hUsd;
      case 'change1h':
        return t.priceChange1h;
      case 'insider':
        return t.rock?.clusteredPct ?? null;
      case 'top10':
        return t.top10Pct;
      /*
       * A TOKEN WITH NO CALL SORTS AS NULL, NOT AS ZERO, on all three — and
       * because nulls sink in both directions, clicking any of these columns
       * gathers the called tokens at the top of whatever lane is open. That is
       * the fastest way to find them without leaving the lane.
       */
      case 'callMc':
        return t.call?.entryMarketCapUsd ?? null;
      case 'nowMc':
        return t.call?.lastMarketCapUsd ?? null;
      case 'peakMc':
        return t.call?.peakMarketCapUsd ?? null;
    }
  };

  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    /*
     * NULLS SINK, IN BOTH DIRECTIONS. Sorting by score ascending must not fill
     * the top of the table with tokens that have no score — "unscored" is not
     * "worst", and a reader looking for the worst graded tokens is asking about
     * tokens that were graded.
     */
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return desc ? bv - av : av - bv;
  });
}

export function TokenTable({
  rows,
  loading,
  sortKey,
  sortDesc,
  onSort,
  selected,
  onSelect,
}: {
  rows: TokenSummary[];
  loading: boolean;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  selected: TokenSummary | null;
  onSelect: (t: TokenSummary) => void;
}) {
  return (
    <div className="@container flex min-h-0 flex-col">
      {/* --- header, sticky ------------------------------------------------- */}
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-rule bg-slab/95 px-3 py-1.5 backdrop-blur">
        {COLUMNS.map((col, i) => {
          const active = col.key !== null && col.key === sortKey;
          const body = (
            <span
              className={cn(
                'label flex items-center gap-1 whitespace-nowrap',
                col.cls,
                col.cls.includes('text-right') && 'justify-end',
                col.key && 'cursor-pointer transition-colors hover:text-ash',
                active && 'text-bone'
              )}
              onClick={col.key ? () => onSort(col.key!) : undefined}
            >
              {col.label}
              {active ? (
                sortDesc ? (
                  <ArrowDown className="size-3" />
                ) : (
                  <ArrowUp className="size-3" />
                )
              ) : null}
            </span>
          );
          return col.hint ? (
            <Tooltip key={i}>
              <TooltipTrigger asChild>{body}</TooltipTrigger>
              <TooltipContent side="bottom">{col.hint}</TooltipContent>
            </Tooltip>
          ) : (
            <React.Fragment key={i}>{body}</React.Fragment>
          );
        })}
      </div>

      {/* --- rows ------------------------------------------------------------ */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Skeletons />
        ) : rows.length === 0 ? (
          <p className="px-3 py-16 text-center text-[12px] text-dim">
            Nothing matches. The firehose is not filtered by default — an empty table means the
            search, not a quiet minute.
          </p>
        ) : (
          rows.map((t) => (
            <Row
              key={t.mint}
              token={t}
              selected={selected?.mint === t.mint}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  token,
  selected,
  onSelect,
}: {
  token: TokenSummary;
  selected: boolean;
  onSelect: (t: TokenSummary) => void;
}) {
  const rock = token.rock;
  const provisional = rock !== null && rock.coverage < MIN_COVERAGE_FOR_VERDICT;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(token)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(token);
        }
      }}
      className={cn(
        'relative flex cursor-pointer items-center gap-2 border-b border-rule-faint px-3 py-1.5',
        'outline-none transition-colors hover:bg-raised/50 focus-visible:bg-raised/50',
        selected && 'bg-raised/80'
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[2px] transition-opacity',
          selected ? 'bg-rock opacity-90' : 'opacity-0'
        )}
      />

      {/* core */}
      <span className="w-[72px] shrink-0">
        {rock ? (
          <CoreStrip
            pillars={silhouettePillars(token)}
            tier={rock.tier}
            coverage={rock.coverage}
          />
        ) : (
          <span className="block h-[9px] w-[58px] rounded-[2px] border border-dashed border-rule" />
        )}
      </span>

      {/* score */}
      <span className={cn('tnum w-[58px] shrink-0 text-right text-[13px] font-bold', rock ? TIER_TEXT[rock.tier] : 'text-dim', provisional && 'opacity-65')}>
        {rock ? Math.round(rock.score) : '—'}
      </span>

      {/* token */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <TokenAvatar mint={token.mint} symbol={token.symbol} imageUrl={token.imageUrl} size={22} />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-semibold leading-tight text-bone">
            {token.symbol}
          </span>
          <span className="label block truncate leading-tight">{token.name}</span>
        </span>
        {/*
          ONLY WHEN THE CURVE HAS ACTUALLY BEEN READ. `progressBps` is null
          until the curve account answers, and printing "0%" for a curve nobody
          has looked at is a fabricated reading of the most specific kind.
        */}
        {token.status === 'BONDING' && token.progressBps !== null ? (
          <span className="label shrink-0 rounded-[3px] border border-action/30 bg-action-wash px-1 text-action">
            {(token.progressBps / 100).toFixed(0)}%
          </span>
        ) : null}
      </span>

      <span className="label w-[52px] shrink-0 text-right">{ago(token.launchTime)}</span>
      <span className="tnum w-[76px] shrink-0 text-right text-[12px] text-bone">{usd(token.marketCapUsd)}</span>
      <span className="tnum w-[72px] shrink-0 text-right text-[12px] text-ash">{usd(token.liquidityUsd)}</span>
      <span className="tnum hidden w-[80px] shrink-0 text-right text-[12px] text-ash @2xl:block">
        {usd(token.volume24hUsd)}
      </span>
      <Delta value={token.priceChange1h} className="w-[64px] shrink-0 text-right text-[12px]" />

      {/* insider — em dash when there is no report, never a zero */}
      <span
        className={cn(
          'tnum hidden w-[68px] shrink-0 text-right text-[12px] @xl:block',
          rock?.clusteredPct == null
            ? 'text-dim'
            : rock.clusteredPct >= 25
              ? 'text-down'
              : rock.clusteredPct >= 12
                ? 'text-warn'
                : 'text-ash'
        )}
      >
        {rock?.clusteredPct == null ? '—' : pct(rock.clusteredPct, 1)}
      </span>

      <span
        className={cn(
          'tnum hidden w-[68px] shrink-0 text-right text-[12px] @3xl:block',
          token.top10Pct === null ? 'text-dim' : token.top10Pct >= 50 ? 'text-warn' : 'text-ash'
        )}
      >
        {token.top10Pct === null ? '—' : pct(token.top10Pct, 0)}
      </span>

      {/*
        THE THREE CAPS. `Call MC` is bone because it is the fact the other two
        are measured against; `Now MC` is coloured by whether the call is up or
        down on it, which is the one comparison a reader makes without thinking;
        `Peak MC` stays quiet, because the peak is the number a feed flatters
        itself with and it should not be the brightest thing in the row.
      */}
      <span className="tnum hidden w-[76px] shrink-0 text-right text-[12px] text-bone @6xl:block">
        {token.call ? usd(token.call.entryMarketCapUsd) : <span className="label">{'—'}</span>}
      </span>
      {/*
        The multiple sits UNDER its cap rather than beside it. The row is already
        two lines tall because of the symbol and name, so the second line is
        free — and putting a compacted cap and a multiple side by side in the
        same 80px was how one of them ended up clipped at the widths people
        actually use.
      */}
      <CapCell
        cap={token.call?.lastMarketCapUsd ?? null}
        mult={token.call?.currentMultiple ?? null}
        tone={
          !token.call ? 'text-dim' : token.call.currentMultiple >= 1 ? 'text-up' : 'text-down'
        }
      />
      <CapCell
        cap={token.call?.peakMarketCapUsd ?? null}
        mult={token.call?.peakMultiple ?? null}
        tone="text-ash"
      />

      <Link
        href={`/token/${token.mint}`}
        onClick={(e) => e.stopPropagation()}
        className="w-[26px] shrink-0 text-dim transition-colors hover:text-bone"
        aria-label={`Open ${token.symbol}`}
      >
        <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}

/** One of the two derived call caps: the money on top, the multiple under it. */
function CapCell({
  cap,
  mult,
  tone,
}: {
  cap: number | null;
  mult: number | null;
  tone: string;
}) {
  return (
    <span className={cn('tnum hidden w-[76px] shrink-0 text-right text-[12px] @6xl:block', tone)}>
      {cap === null ? (
        <span className="label">{'\u2014'}</span>
      ) : (
        <>
          <span className="block leading-tight">{usd(cap)}</span>
          <span className="label block leading-tight">{multiple(mult)}</span>
        </>
      )}
    </span>
  );
}

function Skeletons() {
  return (
    <div aria-busy="true">
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-rule-faint px-3 py-2">
          <span className="animate-pulse-rock h-[9px] w-[58px] rounded-[2px] bg-rule-faint" />
          <span className="animate-pulse-rock ml-2 h-3 w-8 rounded bg-rule-faint" />
          <span className="animate-pulse-rock ml-3 size-[22px] rounded bg-rule-faint" />
          <span className="animate-pulse-rock h-3 w-28 rounded bg-rule-faint" />
          <span className="animate-pulse-rock ml-auto h-3 w-16 rounded bg-rule-faint" />
        </div>
      ))}
    </div>
  );
}
