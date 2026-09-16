'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { compactNumber, usd } from '@/lib/format';

/**
 * THE STATUS LINE — one row that says whether anything on this page is true.
 *
 * A screener is a claim about right now, so the one thing it owes the reader is
 * whether it is still receiving. `lagSeconds` is the honest form of that: not a
 * green dot that means "the web server is up", but how long ago the indexer
 * last wrote a row. When that number climbs the feed is stale and the bar says
 * so, in words, rather than letting somebody trade off a five-minute-old price.
 *
 * It is pinned to the viewport, and its height is `--statusline` — which the
 * sidebar and every page shell subtract, so nothing ends up underneath it.
 */
export function StatusLine({ className }: { className?: string }) {
  const { data } = useQuery({ queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 10_000 });

  const stale = (data?.lagSeconds ?? 0) > 60;

  return (
    <footer
      className={cn(
        'sticky bottom-0 z-30 flex h-[var(--statusline)] items-center gap-x-4 overflow-x-auto border-t border-rule-faint',
        'bg-bench/85 px-3 text-[11px] backdrop-blur-xl',
        className
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            'size-1.5 rounded-full',
            !data ? 'bg-dim' : stale ? 'bg-warn animate-pulse-rock' : 'bg-rock animate-pulse-rock'
          )}
        />
        <span className={cn(stale ? 'text-warn' : 'text-ash')}>
          {!data
            ? 'connecting'
            : stale
              ? `stale — last write ${data.lagSeconds}s ago`
              : 'indexing'}
        </span>
      </span>

      {data ? (
        <>
          <Item label="tracked" value={compactNumber(data.tokensTracked)} />
          <Item label="scored/h" value={compactNumber(data.scoredLastHour)} />
          <Item label="calls 24h" value={String(data.callsLast24h)} />
          <Item label="SOL" value={usd(data.solPriceUsd, { compact: false })} />
          <Item label="ROCK" value={usd(data.rockPriceUsd, { compact: false })} />
          <span className="shrink-0 text-dim">
            engine {data.engineAlive ? <span className="text-rock">armed-capable</span> : 'offline'}
          </span>
        </>
      ) : null}

    </footer>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
      <span className="text-dim">{label}</span>
      <span className="tnum text-ash">{value}</span>
    </span>
  );
}
