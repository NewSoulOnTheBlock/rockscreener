import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * A panel: the card, plus the one header shape every screen here uses.
 *
 * `PanelHead` exists so a label, a hint and a right-hand control cannot drift
 * apart by two pixels across five pages. It is not a layout primitive; it is
 * this product's own header, and pages that need something else should not
 * bend it.
 */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card overflow-hidden', className)} {...props} />;
}

export function PanelHead({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center justify-between gap-3 border-b border-rule-faint px-3',
        className
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[12px] font-semibold tracking-tight text-bone">{label}</span>
        {hint ? <span className="label truncate">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
