import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * A chip.
 *
 * THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS: `on`, `off`, and
 * `unknown` — drawn with a dashed border and dimmed text. A product where a
 * check that has not run looks exactly like a check that came back clean is a
 * product that lies by omission, and on a feed of minutes-old launches
 * "unknown" is the commonest state of most facts.
 */
export function Chip({
  children,
  state = 'off',
  tone,
  className,
  title,
}: {
  children: React.ReactNode;
  state?: 'on' | 'off' | 'unknown';
  tone?: 'rock' | 'warn' | 'down' | 'action';
  className?: string;
  title?: string;
}) {
  const toneClass =
    state === 'unknown'
      ? 'border-dashed border-rule text-dim'
      : tone === 'rock'
        ? 'border-rock/30 bg-rock-wash text-rock'
        : tone === 'warn'
          ? 'border-warn/30 bg-warn/10 text-warn'
          : tone === 'down'
            ? 'border-down/30 bg-down/10 text-down'
            : tone === 'action'
              ? 'border-action/30 bg-action-wash text-action'
              : 'border-rule-faint bg-raised text-ash';

  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-[var(--radius-xs)] border px-1.5',
        'text-[11px] font-medium leading-none whitespace-nowrap',
        toneClass,
        className
      )}
    >
      {children}
    </span>
  );
}

/** A signed percentage, coloured. Zero is neutral, not green. */
export function Delta({
  value,
  className,
  digits = 1,
}: {
  value: number | null | undefined;
  className?: string;
  digits?: number;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={cn('tnum text-dim', className)}>{'—'}</span>;
  }
  return (
    <span
      className={cn(
        'tnum',
        value > 0.05 ? 'text-up' : value < -0.05 ? 'text-down' : 'text-ash',
        className
      )}
    >
      {value > 0 ? '+' : ''}
      {value.toFixed(digits)}%
    </span>
  );
}
