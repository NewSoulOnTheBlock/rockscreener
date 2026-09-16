'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { shortMint } from '@/lib/format';

/**
 * A mint, with one click to copy it.
 *
 * The confirmation is the ICON CHANGING IN PLACE for a second, not a toast. A
 * toast for a copy is a notification about something the user just did on
 * purpose, and on a page where somebody copies four addresses in a row it
 * becomes a stack of them.
 */
export function CopyMint({
  mint,
  className,
  lead = 4,
  tail = 4,
}: {
  mint: string;
  className?: string;
  lead?: number;
  tail?: number;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // Clipboard blocked (no permission, insecure origin). The address is on
      // screen and selectable; a failed copy is not worth an error state.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={mint}
      className={cn(
        'group inline-flex items-center gap-1 font-mono text-[11px] text-dim transition-colors hover:text-ash',
        className
      )}
    >
      {shortMint(mint, lead, tail)}
      {copied ? (
        <Check className="size-3 text-rock" />
      ) : (
        <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
