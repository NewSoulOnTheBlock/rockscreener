'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { CALL_WORKED_MULTIPLE, type ScreenerPreset, type TokenSummary } from '@rockscreener/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { multiple } from '@/lib/format';
import { CallCard } from '@/components/call-card';
import { DetailDrawer } from '@/components/detail-drawer';
import { TokenTable, sortTokens, type SortKey } from '@/components/token-table';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * THE BENCH: what we said, then everything we have.
 *
 * TWO OBJECTS, AND THEY ARE DIFFERENT KINDS OF THING. The call cards along the
 * top are the product's opinion — rare, timestamped, with the reasoning printed
 * on them and the losses drawn the same size as the wins. The table underneath
 * is the evidence: everything indexed, sortable, unfiltered.
 *
 * THE ORDER IS THE ARGUMENT. A screener that shows you its database and lets
 * you sort it has made no claim and can never be wrong; one that shows you only
 * its picks is asking to be believed. Putting the claim above the evidence, on
 * the same screen, with the seven-day record beside it, is the only arrangement
 * where both can be checked against each other.
 *
 * THE RECORD IS NOT BEHIND A TAB. It sits on the calls header, it counts every
 * call in the window the same way, and it prints the median PEAK and the median
 * NOW side by side — the gap between those two is what a feed that publishes
 * only its peaks is hiding.
 */

/**
 * THE DEFAULT LANE IS `Graded`, AND THE FIREHOSE IS ONE CLICK AWAY.
 *
 * Both have to exist and only one can be the default. Sorted by age, the
 * firehose is a wall of seconds-old mints with no market, no grade and nothing
 * measured — every column an em dash, which is HONEST and is not a screen
 * anybody opens a screener to read. The graded lane is the evidence the calls
 * above can be checked against; `Everything` is there so that evidence can be
 * checked in turn.
 */
const LANES: { id: ScreenerPreset; label: string; hint: string; scoredOnly?: boolean }[] = [
  { id: 'rocks', label: 'Graded', hint: 'Every token with enough measured to publish a verdict. Provisional scores are held back.', scoredOnly: true },
  /*
   * THE CALLED LANE IS THE TABLE FORM OF THE RAIL ABOVE, and it exists because
   * the three call columns are otherwise an em dash on almost every row: calls
   * are rare by construction — seventy-odd out of twelve thousand — so in any
   * other lane the reader has to already know which mints were called in order
   * to find them. Here the same claims are sortable by what they were worth,
   * what they are worth, and how high they got, with the losers in the list.
   */
  { id: 'calls', label: 'Called', hint: 'Every token this product has published a call on, winners and losers together. The three market-cap columns are what those calls are judged on.' },
  { id: 'new', label: 'Everything', hint: 'The raw firehose, uncut stones and all. Unscored rows included — being able to see them is what makes the calls above checkable.' },
  { id: 'bonding', label: 'Bonding', hint: 'Still on the curve.' },
  { id: 'graduated', label: 'Graduated', hint: 'Off the curve and into a real pool.' },
];

export default function Bench() {
  const [search, setSearch] = React.useState('');
  const [lane, setLane] = React.useState<ScreenerPreset>('rocks');
  const [sortKey, setSortKey] = React.useState<SortKey>('score');
  const [sortDesc, setSortDesc] = React.useState(true);
  const [selected, setSelected] = React.useState<TokenSummary | null>(null);
  const [pendingMint, setPendingMint] = React.useState<string | null>(null);

  const activeLane = LANES.find((l) => l.id === lane)!;

  const { data, isLoading } = useQuery({
    queryKey: ['screener', lane, search],
    queryFn: () =>
      api.screener({
        preset: lane,
        limit: 200,
        ...(activeLane.scoredOnly ? { scoredOnly: true } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      }),
    refetchInterval: 5_000,
  });

  const { data: calls } = useQuery({ queryKey: ['calls'], queryFn: () => api.calls(), refetchInterval: 15_000 });
  const { data: record } = useQuery({ queryKey: ['record', 168], queryFn: () => api.record(168), refetchInterval: 60_000 });

  /*
   * A call names a MINT, and the token behind it may not be in the current
   * lane — a call from four hours ago has long scrolled out of "Everything"
   * sorted by age. So the card sets a mint and this fetches the row.
   */
  const { data: fetched } = useQuery({
    queryKey: ['token', pendingMint],
    queryFn: () => api.token(pendingMint!),
    enabled: Boolean(pendingMint),
  });
  React.useEffect(() => {
    if (fetched) setSelected(fetched);
  }, [fetched]);

  const rows = React.useMemo(
    () => sortTokens(data?.data ?? [], sortKey, sortDesc),
    [data, sortKey, sortDesc]
  );

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-var(--statusline))] flex-col gap-3 p-3 sm:p-4">
      {/* --- bar -------------------------------------------------------------- */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <Link href="/" className="flex shrink-0 items-center gap-2 lg:hidden" aria-label="RockScreener">
          <Image src="/rock-logo.svg" alt="" width={26} height={26} className="mark-lit" />
          <span className="sol-gradient-text text-[14px] font-bold tracking-tight">RockScreener</span>
        </Link>

        <label className="relative min-w-0 flex-1 sm:max-w-[19rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="symbol, name or mint"
            className="h-8 pl-7"
            aria-label="Search launches"
          />
        </label>

        <p className="ml-auto hidden text-[11px] text-dim md:block">
          Solana, cut and graded.{' '}
          <Link
            href="/docs"
            className="text-ash underline decoration-rule underline-offset-4 transition-colors hover:text-rock"
          >
            How the grade works
          </Link>
        </p>
      </div>

      {/* --- what we said ------------------------------------------------------ */}
      <section className="shrink-0">
        <header className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-bone">
            <span className="size-1.5 rounded-full bg-rock animate-pulse-rock" />
            Calls
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="label cursor-help border-b border-dashed border-rule-faint">
                7-day record
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Every call in the window counted the same way — the ones that ran and the ones that
              went to zero. A call counts as having worked once it reached {CALL_WORKED_MULTIPLE}x
              at any point while it was tracked.
            </TooltipContent>
          </Tooltip>

          {record ? (
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
              <Fig value={String(record.calls)} label="calls" />
              <Fig value={String(record.successCount)} label="worked" tone="up" />
              <Fig value={`${record.hit2xPct}%`} label="hit 2x" tone="up" />
              <Fig value={`${record.hit5xPct}%`} label="hit 5x" tone="up" />
              <Fig value={`${record.drawdown50Pct}%`} label="fell 50%" tone="down" />
              <Fig value={String(record.ruggedCount)} label="rugged" tone="down" />
              <Fig value={multiple(record.medianPeakMultiple)} label="med. peak" />
              <Fig
                value={multiple(record.medianCurrentMultiple)}
                label="med. now"
                tone={(record.medianCurrentMultiple ?? 1) >= 1 ? 'up' : 'down'}
              />
            </div>
          ) : null}
        </header>

        <CallRail calls={calls ?? []} onSelect={setPendingMint} />
      </section>

      {/* --- everything we have ------------------------------------------------ */}
      <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-rule-faint px-3">
          <div className="segment flex gap-0.5">
            {LANES.map((l) => (
              <Tooltip key={l.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setLane(l.id)}
                    className={cn(
                      'rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] font-medium transition-colors',
                      lane === l.id ? 'bg-raised text-bone' : 'text-dim hover:text-ash'
                    )}
                  >
                    {l.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{l.hint}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <span className="label ml-auto">{rows.length} rows</span>
        </header>

        <TokenTable
          rows={rows}
          loading={isLoading}
          sortKey={sortKey}
          sortDesc={sortDesc}
          onSort={onSort}
          selected={selected}
          onSelect={(t) => {
            setPendingMint(null);
            setSelected(t);
          }}
        />
      </section>

      <DetailDrawer
        token={selected}
        onClose={() => {
          setSelected(null);
          setPendingMint(null);
        }}
      />
    </div>
  );
}

/**
 * The rail of call cards.
 *
 * It scrolls under the reader's finger and has arrows for a mouse, because a
 * horizontal strip with no visible affordance is a strip most people never
 * discover has more in it.
 */
function CallRail({
  calls,
  onSelect,
}: {
  calls: import('@rockscreener/shared').Call[];
  onSelect: (mint: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const nudge = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * 340, behavior: 'smooth' });

  if (calls.length === 0) {
    return (
      <div className="card px-4 py-5">
        <p className="max-w-[46rem] text-[12px] leading-relaxed text-dim">
          Nothing is called right now. A call has to clear the grade, a coverage floor, a closed
          launch window with the bundle actually analysed, a confirmed sell and real liquidity —
          most launches never clear all of it, which is the entire point.
        </p>
      </div>
    );
  }

  return (
    <div className="group/rail relative">
      <div ref={ref} className="strip-x flex gap-2.5 pb-1">
        {calls.map((call) => (
          <CallCard key={call.id} call={call} onSelect={onSelect} />
        ))}
      </div>
      <RailButton side="left" onClick={() => nudge(-1)} />
      <RailButton side="right" onClick={() => nudge(1)} />
    </div>
  );
}

function RailButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Scroll calls left' : 'Scroll calls right'}
      className={cn(
        'absolute top-1/2 hidden -translate-y-1/2 rounded-full border border-rule bg-bench/90 p-1.5 text-ash',
        'opacity-0 shadow-lg shadow-black/50 backdrop-blur transition-opacity',
        'hover:text-bone group-hover/rail:opacity-100 md:block',
        side === 'left' ? '-left-1' : '-right-1'
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function Fig({ value, label, tone }: { value: string; label: string; tone?: 'up' | 'down' }) {
  return (
    <span className="flex items-baseline gap-1">
      <span
        className={cn(
          'tnum text-[12px] font-semibold',
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-bone'
        )}
      >
        {value}
      </span>
      <span className="label">{label}</span>
    </span>
  );
}
