'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * A sparkline, and the line it draws that nobody else does: THE ENTRY.
 *
 * A call's series is denominated in multiples of the price it was called at, so
 * 1.0 is a real, meaningful level rather than an arbitrary baseline — it is the
 * line between this call having worked and not. Drawing it as a faint dash
 * across the box turns the sparkline from decoration into the one thing the
 * card is claiming: above the line is profit, below it is the loss, and the
 * reader can see which without reading a number.
 *
 * NO AXES, NO GRID, NO TOOLTIP. It is 40 pixels tall and it is not a chart; the
 * numbers beside it are exact and this is the shape they came in.
 */
export function Sparkline({
  series,
  width = 132,
  height = 40,
  className,
}: {
  series: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (series.length < 2) {
    return (
      <div
        className={cn('grid place-items-center rounded-[var(--radius-xs)] bg-sunk', className)}
        style={{ width, height }}
      >
        <span className="label">no history yet</span>
      </div>
    );
  }

  const max = Math.max(...series, 1.05);
  const min = Math.min(...series, 0.95);
  const span = Math.max(0.0001, max - min);
  const pad = 3;

  const x = (i: number) => (i / (series.length - 1)) * (width - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const path = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(series.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;

  const last = series[series.length - 1]!;
  const up = last >= 1;
  const stroke = up ? 'var(--color-up)' : 'var(--color-down)';
  const entryY = y(1);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${up ? 'up' : 'down'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={area} fill={`url(#spark-${up ? 'up' : 'down'})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />

      {/* THE ENTRY. Everything above it is the call working. */}
      {entryY > 0 && entryY < height ? (
        <line
          x1="0"
          y1={entryY}
          x2={width}
          y2={entryY}
          stroke="var(--color-dim)"
          strokeWidth="1"
          strokeDasharray="2 3"
          opacity="0.8"
        />
      ) : null}

      <circle cx={x(series.length - 1)} cy={y(last)} r="2" fill={stroke} />
    </svg>
  );
}
