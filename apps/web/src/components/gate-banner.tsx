'use client';

import Link from 'next/link';
import { Lock, RefreshCw, Unlock } from 'lucide-react';
import { ROCK_MINT, type RockGate } from '@rockscreener/shared';
import { cn } from '@/lib/cn';
import { ago, compactNumber, usd } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { CopyMint } from '@/components/copy-mint';

/**
 * THE ROCK GATE.
 *
 * Auto-trade opens for an account holding $500 of ROCK — a POSITION, not a
 * subscription. The difference matters and the banner says it: a subscription
 * is a payment that leaves, a holding is something the holder keeps, and it
 * aligns the one feature that spends money by itself with the token whose price
 * it moves.
 *
 * THE LOCKED STATE IS THE DESIGNED STATE. It is what every new visitor sees, so
 * it has to do three things rather than one: say exactly how short they are,
 * show which wallets were counted (holding in the wrong wallet is the single
 * commonest reason a gate looks broken), and give them the mint to buy. A gate
 * that only says "locked" generates a support message every time.
 *
 * IT REPORTS ITS OWN STALENESS. A balance read four minutes ago is not a fact
 * about now, and a user whose position just moved is entitled to know whether
 * the number in front of them is out of date rather than wrong.
 */
export function GateBanner({
  gate,
  onRecheck,
  rechecking,
  className,
}: {
  gate: RockGate;
  onRecheck?: () => void;
  rechecking?: boolean;
  className?: string;
}) {
  const progress = Math.min(100, (gate.heldUsd / Math.max(1, gate.requiredUsd)) * 100);

  return (
    <div
      className={cn(
        'card p-4',
        gate.unlocked ? 'border-rock/30' : 'border-warn/30',
        className
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            'mt-0.5 grid size-8 shrink-0 place-items-center rounded-[var(--radius-sm)] border',
            gate.unlocked ? 'border-rock/30 bg-rock-wash text-rock' : 'border-warn/30 bg-warn/10 text-warn'
          )}
        >
          {gate.unlocked ? <Unlock className="size-4" /> : <Lock className="size-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-bone">
            {gate.unlocked ? 'Auto-trade is open' : 'Auto-trade needs ROCK'}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-ash">
            {gate.unlocked ? (
              <>
                You hold <span className="tnum text-rock">{usd(gate.heldUsd)}</span> of ROCK, above
                the <span className="tnum">{usd(gate.requiredUsd, { compact: false })}</span> the
                engine requires. The check runs again before every entry — if the position falls
                below the line the engine stops buying and keeps managing what it already holds.
              </>
            ) : gate.priceUsd === null ? (
              /* A gate that fails OPEN on a pricing outage is not a gate. */
              <>No source would price ROCK just now, so the holding cannot be valued and the
              engine stays closed. This is a refusal to guess, not a verdict on your balance.</>
            ) : (
              <>
                The engine opens for accounts holding{' '}
                <span className="tnum text-bone">{usd(gate.requiredUsd, { compact: false })}</span>{' '}
                of ROCK. You hold{' '}
                <span className="tnum text-bone">{compactNumber(gate.heldTokens)}</span> ROCK
                {' ≈ '}
                <span className="tnum text-bone">{usd(gate.heldUsd)}</span> — short by{' '}
                <span className="tnum text-warn">{usd(gate.missingUsd)}</span>.
              </>
            )}
          </p>

          {/* The bar, and it is honest past 100%: it stops, and the surplus is
              in the sentence above rather than drawn as a longer bar. */}
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-sunk">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', gate.unlocked ? 'bg-rock' : 'bg-warn')}
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {gate.wallets.map((w) => (
              <span key={w.address} className="flex items-center gap-1.5 text-[11px]">
                <span className="label">{w.kind === 'custodial' ? 'engine wallet' : 'linked wallet'}</span>
                <CopyMint mint={w.address} />
                <span className="tnum text-ash">{compactNumber(w.tokens)} ROCK</span>
              </span>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!gate.unlocked ? (
              <Button variant="action" size="sm" asChild>
                <a
                  href={`https://jup.ag/swap/SOL-${ROCK_MINT}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Buy ROCK
                </a>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onRecheck} disabled={rechecking}>
              <RefreshCw className={cn('size-3.5', rechecking && 'animate-spin')} />
              Re-check
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/wallet">Link another wallet</Link>
            </Button>
            <span className="label ml-auto">read {ago(gate.checkedAt)} ago</span>
          </div>
        </div>
      </div>
    </div>
  );
}
