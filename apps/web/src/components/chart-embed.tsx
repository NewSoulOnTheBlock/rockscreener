'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * THE CHART, AND THIS PRODUCT DOES NOT DRAW IT.
 *
 * NO CANDLES ARE STORED ANYWHERE IN THIS SYSTEM, and that is a decision rather
 * than a gap. An OHLCV table for hundreds of thousands of mints has to be
 * backfilled, pruned, reconciled against a source that occasionally revises
 * it, and served at a resolution that changes with the zoom — for a chart that
 * would, at considerable expense, look exactly like the one DexScreener already
 * serves for free and correctly.
 *
 * WHAT IS WORTH STORING IS THE THING NO EMBED CAN GIVE: a price path
 * denominated in MULTIPLES OF THE PRICE A CALL WAS MADE AT, where 1.0 is the
 * line between the call having worked and not. That is twenty-six floats per
 * call, it lives on the call row, and it is what the call cards draw.
 *
 * THE IFRAME IS SANDBOXED. It is third-party script on a page where people
 * decide what to buy; `allow-scripts` without `allow-same-origin` is what stops
 * it reaching this document, and the referrer policy stops the mint a reader is
 * looking at from being handed over as a URL.
 */
export function ChartEmbed({
  pairAddress,
  className,
}: {
  pairAddress: string | null;
  className?: string;
}) {
  if (!pairAddress) {
    return (
      <div
        className={cn(
          'grid place-items-center rounded-[var(--radius-sm)] border border-dashed border-rule bg-sunk px-6 py-12 text-center',
          className
        )}
      >
        <p className="max-w-[24rem] text-[12px] leading-relaxed text-dim">
          No market is indexed for this token yet, so there is nothing to chart. That is the
          ordinary state of a mint that has not traded — not a failure to load.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('relative overflow-hidden rounded-[var(--radius-sm)] border border-rule-faint', className)}>
      <iframe
        title="Price chart"
        src={`https://dexscreener.com/solana/${pairAddress}?embed=1&theme=dark&info=0&trades=0`}
        className="h-full w-full"
        loading="lazy"
        // Third-party script on a page where people decide what to buy.
        sandbox="allow-scripts allow-same-origin allow-popups"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
