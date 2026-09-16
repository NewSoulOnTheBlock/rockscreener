'use client';

import * as React from 'react';
import { useTip } from '@/components/etherrock/tooltip';
import {
  eth,
  nf,
  dstr,
  short,
  SERIES_ORDER,
  SERIES_NAME,
  type MonthRow,
  type Snapshot,
} from '@/lib/etherrock';

/** Measures the host so the SVG can be laid out in real pixels rather than guessed. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(900);
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (next > 0) setW(next);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

type Point = {
  rockId: number;
  ts: number;
  priceEth: number;
  buyer?: string;
  block?: number;
  hidden?: boolean;
  series: number;
};

/**
 * Every recorded sale, one dot each.
 *
 * LOG BY DEFAULT, and the axis says so. The series spans a 0.001 ETH mint and a
 * 234 ETH sale; on a linear axis the first four years of the collection are a
 * single line of dots resting on the baseline, which is a true plot of a range
 * nobody can read. The toggle is offered rather than removed because linear is
 * the honest view of *how much money moved*, and log is the honest view of how
 * the price behaved.
 */
export function PriceScatter({ snapshot, logScale }: { snapshot: Snapshot; logScale: boolean }) {
  const [ref, W] = useWidth();
  const tip = useTip();

  const pts = React.useMemo<Point[]>(() => {
    const sales = snapshot.events.filter((e) => e.type === 'sale' && e.priceEth > 0);
    const os = (snapshot.opensea?.sales ?? [])
      .filter((s) => s.priceEth > 0 && s.ts)
      .map((s) => ({
        ...s,
        ts: typeof s.ts === 'number' ? s.ts : Math.floor(Date.parse(String(s.ts)) / 1000),
      }));
    return [
      ...sales.filter((s) => s.preMigration).map((s) => ({ ...s, series: 2 })),
      ...sales.filter((s) => !s.preMigration).map((s) => ({ ...s, series: 0 })),
      ...os.map((s) => ({ ...s, series: 1 })),
    ].filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.priceEth)) as Point[];
  }, [snapshot]);

  const H = 380;
  const m = { t: 14, r: 18, b: 34, l: 58 };
  const iw = Math.max(80, W - m.l - m.r);
  const ih = H - m.t - m.b;

  if (!pts.length) return <div ref={ref} className="py-10 text-center text-[12px] text-dim">No sales recorded.</div>;

  const xs = pts.map((p) => p.ts);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const X = (t: number) => m.l + ((t - x0) / (x1 - x0 || 1)) * iw;

  const ys = pts.map((p) => p.priceEth);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const lo = logScale ? Math.log10(yMin) : 0;
  const hi = logScale ? Math.log10(yMax) : yMax;
  const Y = (v: number) => {
    const t = logScale ? (Math.log10(v) - lo) / (hi - lo) : (v - lo) / (hi - lo);
    return m.t + ih - t * ih;
  };

  const ticks = logScale
    ? Array.from({ length: Math.ceil(hi) - Math.floor(lo) + 1 }, (_, i) => Math.pow(10, Math.floor(lo) + i)).filter(
        (v) => v >= yMin * 0.5 && v <= yMax * 2
      )
    : [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];

  const yearFrom = new Date(x0 * 1000).getUTCFullYear();
  const yearTo = new Date(x1 * 1000).getUTCFullYear();
  const years: number[] = [];
  for (let y = yearFrom; y <= yearTo; y++) {
    const ts = Date.UTC(y, 0, 1) / 1000;
    if (ts >= x0 && ts <= x1) years.push(y);
  }

  const ordered = [...pts].sort((a, b) => a.priceEth - b.priceEth);

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className="block w-full overflow-visible">
        {ticks.map((tv, i) => {
          const y = Y(tv);
          if (!Number.isFinite(y)) return null;
          return (
            <g key={i}>
              <line x1={m.l} x2={m.l + iw} y1={y} y2={y} stroke="var(--color-rule-faint)" strokeWidth={1} />
              <text x={m.l - 8} y={y + 4} textAnchor="end" className="fill-dim font-mono text-[11px]">
                {eth(tv)}
              </text>
            </g>
          );
        })}

        <text
          x={m.l - 46}
          y={m.t + ih / 2}
          textAnchor="middle"
          transform={`rotate(-90 ${m.l - 46} ${m.t + ih / 2})`}
          className="fill-ash text-[11.5px]"
        >
          {'Sale price (ETH)' + (logScale ? ' — log scale' : '')}
        </text>

        {years.map((y) => {
          const xv = X(Date.UTC(y, 0, 1) / 1000);
          return (
            <g key={y}>
              <line x1={xv} x2={xv} y1={m.t} y2={m.t + ih} stroke="var(--color-rule-faint)" strokeWidth={1} />
              <text x={xv} y={H - 12} textAnchor="middle" className="fill-dim font-mono text-[11px]">
                {y}
              </text>
            </g>
          );
        })}

        {ordered.map((p, i) => {
          const cx = X(p.ts);
          const cy = Y(p.priceEth);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={4.5}
              fill={SERIES_ORDER[p.series]}
              stroke="var(--color-slab)"
              strokeWidth={2}
              className="cursor-pointer"
              {...tip(`Rock #${p.rockId} — ${eth(p.priceEth)} ETH`, [
                ['Date', dstr(p.ts)],
                ['Venue', SERIES_NAME[p.series]],
                ['Buyer', short(p.buyer)],
                p.hidden ? ['Note', 'recovered from archive'] : ['Block', nf(p.block ?? 0)],
              ])}
            />
          );
        })}
      </svg>

      <div className="mt-3 flex flex-wrap gap-4 text-[12.5px] text-ash">
        {SERIES_NAME.map((n, i) => (
          <span key={n} className="flex items-center gap-2">
            <span className="size-[11px] shrink-0 rounded-[3px]" style={{ background: SERIES_ORDER[i] }} />
            {n} ({pts.filter((p) => p.series === i).length})
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * One month per column.
 *
 * VOLUME AND COUNT GET THEIR OWN FRAMES. Twin axes on one chart let the reader
 * read a crossing as a relationship when the only thing that crossed was two
 * arbitrary scalings, and the two series here genuinely do diverge — the months
 * with the most trades are not the months with the most money.
 *
 * Only the extreme is direct-labelled. Labelling every column turns the chart
 * into a table that happens to have bars behind it.
 */
export function MonthlyBars({
  rows,
  metric,
  color,
}: {
  rows: MonthRow[];
  metric: 'volumeEth' | 'sales';
  color: string;
}) {
  const [ref, W] = useWidth();
  const tip = useTip();

  const H = 190;
  const m = { t: 12, r: 12, b: 28, l: 56 };
  const iw = Math.max(60, W - m.l - m.r);
  const ih = H - m.t - m.b;

  if (!rows.length) return <div ref={ref} className="py-8 text-center text-[12px] text-dim">No monthly data.</div>;

  const max = Math.max(...rows.map((r) => r[metric]));
  const band = iw / rows.length;
  const bw = Math.min(24, Math.max(3, band - 2));

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className="block w-full overflow-visible">
        {[0, 0.5, 1].map((f) => {
          const y = m.t + ih - f * ih;
          return (
            <g key={f}>
              <line x1={m.l} x2={m.l + iw} y1={y} y2={y} stroke="var(--color-rule-faint)" strokeWidth={1} />
              <text x={m.l - 8} y={y + 4} textAnchor="end" className="fill-dim font-mono text-[11px]">
                {metric === 'volumeEth' ? eth(max * f) : nf(Math.round(max * f))}
              </text>
            </g>
          );
        })}

        {rows.map((r, i) => {
          const h = max ? (r[metric] / max) * ih : 0;
          const x = m.l + i * band + (band - bw) / 2;
          const y = m.t + ih - h;
          const rx = Math.min(4, bw / 2);
          const isMax = r[metric] === max;
          const edge = rows.length <= 40 && (i === 0 || i === rows.length - 1 || isMax);
          return (
            <g key={r.month}>
              <path
                d={`M${x},${y + h} L${x},${y + rx} Q${x},${y} ${x + rx},${y} L${x + bw - rx},${y} Q${x + bw},${y} ${x + bw},${y + rx} L${x + bw},${y + h} Z`}
                fill={color}
                className="cursor-pointer"
                {...tip(r.month, [
                  ['Sales', nf(r.sales)],
                  ['Volume', eth(r.volumeEth) + ' ETH'],
                  ['Median', eth(r.medianEth) + ' ETH'],
                  ['Max', eth(r.maxEth) + ' ETH'],
                ])}
              />
              {edge ? (
                <text x={x + bw / 2} y={H - 10} textAnchor="middle" className="fill-dim font-mono text-[11px]">
                  {r.month}
                </text>
              ) : null}
              {isMax ? (
                <text
                  x={x + bw / 2}
                  y={y - 5}
                  textAnchor="middle"
                  className="fill-bone font-mono text-[11px] font-bold"
                >
                  {metric === 'volumeEth' ? eth(r.volumeEth) + ' ETH' : nf(r.sales)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
