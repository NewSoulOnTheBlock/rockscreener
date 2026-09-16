'use client';

import * as React from 'react';
import { CALL_LABEL, type Call } from '@rockscreener/shared';
import { cn } from '@/lib/cn';
import { ago, multiple, usd } from '@/lib/format';
import { Sparkline } from '@/components/sparkline';
import { TokenAvatar } from '@/components/token-avatar';

/**
 * A CALL, WITH ITS RECEIPTS.
 *
 * This is the one object in the product that makes a claim, so it is the one
 * object built like a statement rather than like a row: what was said, when,
 * at what market cap, what happened next, and — the part nobody else ships —
 * WHY it was said, in the scorer's own words.
 *
 * THE LOSSES ARE DRAWN THE SAME SIZE AS THE WINS. A rugged call keeps its card,
 * its multiple and its reasoning; it is tinted and struck through, and it is
 * not filtered out, moved to a second tab, or quietly dropped after a day. A
 * feed that shows only the calls that worked is an advertisement, and the whole
 * point of publishing a call at a timestamp is that it can be checked against
 * what it did.
 *
 * THE HEADLINE IS THE SCORER'S SENTENCE, NOT MARKETING. "bundle 24.6%, still
 * held" is a finding with a number in it; it is what the grade was actually
 * built on, and printing it here is what stops the card being a tip.
 */
export function CallCard({
  call,
  onSelect,
  className,
}: {
  call: Call;
  onSelect: (mint: string) => void;
  className?: string;
}) {
  const up = call.currentMultiple >= 1;
  const rugged = call.outcome === 'rugged';
  const strong = call.tier === 'strong_buy';

  return (
    <button
      type="button"
      onClick={() => onSelect(call.mint)}
      className={cn(
        'card animate-cut-in flex w-[19.5rem] shrink-0 flex-col gap-2.5 p-3 text-left transition-colors',
        'hover:border-rule hover:bg-raised/40',
        rugged && 'border-down/25',
        className
      )}
    >
      {/* --- what was said --------------------------------------------------- */}
      <div className="flex items-start gap-2.5">
        <TokenAvatar mint={call.mint} symbol={call.symbol} imageUrl={call.imageUrl} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                strong ? 'bg-rock/20 text-rock' : 'bg-tier-solid/15 text-tier-solid'
              )}
            >
              {CALL_LABEL[call.tier]}
            </span>
            <span className="truncate text-[13px] font-semibold text-bone">{call.symbol}</span>
            <span className="label ml-auto shrink-0">{ago(call.calledAt)} ago</span>
          </div>
          <div className="mt-0.5 text-[11px] text-dim">
            called at <span className="tnum text-ash">{usd(call.entryMarketCapUsd)}</span> {'·'} score{' '}
            <span className="tnum text-ash">{call.score}</span>
          </div>
        </div>
      </div>

      {/* --- what happened next ---------------------------------------------- */}
      <div className="flex items-center gap-3">
        <Sparkline series={call.spark} width={130} height={42} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'tnum text-[20px] font-bold leading-none',
                rugged ? 'text-down line-through' : up ? 'text-up' : 'text-down'
              )}
            >
              {multiple(call.currentMultiple)}
            </span>
            <span className="label">now</span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="tnum text-[12px] text-ash">{multiple(call.peakMultiple)}</span>
            <span className="label">peak</span>
          </div>
        </div>
      </div>

      {/* --- why it was said --------------------------------------------------- */}
      <p
        className={cn(
          'border-t border-rule-faint pt-2 text-[11px] leading-relaxed',
          rugged ? 'text-down/80' : 'text-dim'
        )}
      >
        {rugged && call.closeReason
          ? call.closeReason
          : call.headline
            ? call.headline
            : 'Nothing was found against this token at the time of the call.'}
      </p>
    </button>
  );
}
