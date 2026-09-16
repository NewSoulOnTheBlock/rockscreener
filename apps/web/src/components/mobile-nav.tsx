'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { LINKS } from '@/components/sidebar';

/**
 * The phone's navigation: a floating bar where the thumb already is.
 *
 * It replaces the sidebar rather than collapsing it, because on a 400px screen
 * even a 72px icon rail is the widest thing competing with a feed row. It
 * floats above the status line rather than sitting under it — the status line
 * is pinned, and a nav bar underneath a pinned bar is a nav bar nobody can
 * press.
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        'fixed inset-x-3 z-40 lg:hidden',
        'bottom-[calc(var(--statusline)+0.75rem+env(safe-area-inset-bottom,0px))]',
        'flex items-center justify-around gap-1 rounded-[var(--radius-pill)] border border-rule bg-bench/90 p-1.5 backdrop-blur-xl',
        'shadow-lg shadow-black/60'
      )}
    >
      {LINKS.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-label={link.label}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 rounded-[var(--radius-pill)] py-1.5 transition-colors',
              active ? 'bg-raised text-bone' : 'text-dim'
            )}
          >
            <Icon className={cn('size-4', active && 'text-rock')} />
            <span className="text-[10px] leading-none">{link.label.split(' ')[0]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
