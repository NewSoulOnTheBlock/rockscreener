'use client';

import * as React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Bot,
  Gem,
  LogOut,
  Mountain,
  PanelLeftClose,
  PanelLeftOpen,
  Pickaxe,
  Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { shortMint } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { ConnectDialog } from '@/components/connect-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The sidebar.
 *
 * IT COLLAPSES BECAUSE THE WORKSPACE IS THE PRODUCT. A feed row carries a
 * stone, four chips, a call trace and five figures, and on a 1280px laptop the
 * difference between a 236px sidebar and a 64px one decides whether the numbers
 * column fits beside the chips or wraps under them. So the reader chooses, and
 * the choice is remembered.
 *
 * COLLAPSED IS A RAIL, NOT A HIDDEN MENU. The icons stay, the active marker
 * stays, and the tooltips carry the labels — hiding navigation behind a
 * hamburger is how somebody loses their place in a list they are scanning.
 *
 * THE ACCOUNT LIVES AT THE BOTTOM, away from the navigation, because it is not
 * a destination. A control up there that looked like a sixth tab would imply
 * there is a sixth screen behind it.
 */
const COLLAPSE_KEY = 'rockscreener:sidebar-collapsed';

export const LINKS = [
  { href: '/', label: 'Bench', icon: Mountain, hint: 'Every Solana launch, cut and graded' },
  { href: '/auto', label: 'Auto-trade', icon: Bot, hint: 'Rules you write once, acted on while you are not watching' },
  { href: '/wallet', label: 'Wallet', icon: Wallet, hint: 'Trading wallets, balances and ROCK' },
  { href: '/creators', label: 'Creators', icon: Pickaxe, hint: 'Who launched what, and how it ended' },
  { href: '/docs', label: 'How it works', icon: BookOpen, hint: 'What the grade means and what it refuses to claim' },
  { href: '/rocks', label: 'EtherRock', icon: Gem, hint: 'A hundred rocks on Ethereum, reconstructed from a contract that logs nothing' },
];

export function Sidebar() {
  const pathname = usePathname();
  const [connecting, setConnecting] = React.useState(false);
  const qc = useQueryClient();
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: () => api.session() });

  /**
   * Signing out clears the cookie AND the cached session.
   *
   * Without the second half the server forgets you and the sidebar does not:
   * `useQuery` keeps serving the cached session until something happens to
   * refetch it, so the account block stays drawn and the next protected request
   * comes back 401 for no visible reason. Everything keyed to the account is
   * cleared too, because a stale wallet balance or gate reading belongs to a
   * session that no longer exists.
   */
  const signOut = async (): Promise<void> => {
    await api.signOut().catch(() => undefined);
    qc.setQueryData(['session'], null);
    for (const key of ['gate', 'wallets', 'linked', 'positions', 'events', 'auto-settings']) {
      qc.removeQueries({ queryKey: [key] });
    }
  };

  /*
   * Starts expanded and settles after mount. Reading localStorage during render
   * would make the server and the first client paint disagree about the width,
   * which React reports as a hydration error and the reader sees as the whole
   * sidebar jumping.
   */
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // Storage blocked (private window). The default stands and the toggle
      // still works for this session.
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // See above: a preference that cannot be stored is not an error.
      }
      return next;
    });
  };

  return (
    <>
      <nav
        className={cn(
          // GONE below `lg` rather than narrowed: 240px of a 400px screen is
          // most of the screen, and even a 72px rail is the widest thing
          // competing with a feed row. `MobileNav` replaces it entirely.
          'hidden lg:flex',
          'sticky top-0 h-[calc(100dvh-var(--statusline))] shrink-0 flex-col border-r border-rule-faint bg-bench/70 backdrop-blur-xl',
          'transition-[width] duration-200 ease-out',
          collapsed ? 'w-[72px]' : 'w-[240px]'
        )}
      >
        <div
          className={cn(
            'flex h-[64px] shrink-0 items-center border-b border-rule-faint',
            collapsed ? 'justify-center px-2' : 'gap-2.5 px-3'
          )}
        >
          <Link
            href="/"
            className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-sunk/70"
            aria-label="RockScreener"
          >
            {/*
              A PLINTH UNDER THE STONE, and it is not decoration.

              The mark is a granite boulder whose shadow side is #121214 — three
              points from the sidebar it sits on — so on the bare panel half of
              it simply disappears and what is left reads as a bright smear. A
              slightly sunken tile behind it gives the dark facets something to
              be dark AGAINST, which is the whole reason the drawing is legible
              at 38px at all. `.mark-lit` does the rest; see globals.css.
            */}
            <Image src="/rock-logo.svg" alt="" width={38} height={38} priority className="mark-lit" />
          </Link>
          {!collapsed ? (
            <div className="min-w-0">
              {/* The one gradient in the product. A gradient that appears twice
                  is a theme; one that appears once is a signature. */}
              <div className="sol-gradient-text truncate text-[15px] font-bold tracking-tight">
                RockScreener
              </div>
              <div className="label truncate">Solana, cut and graded</div>
            </div>
          ) : null}
        </div>

        <div className={cn('flex-1 space-y-0.5 py-3', collapsed ? 'px-2' : 'px-2.5')}>
          {LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            const Icon = link.icon;
            const body = (
              <Link
                href={link.href}
                className={cn(
                  'relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-2 text-[13px] transition-colors',
                  collapsed ? 'justify-center px-2' : 'px-2.5',
                  active ? 'bg-raised text-bone' : 'text-dim hover:bg-raised/60 hover:text-ash'
                )}
              >
                {active ? (
                  <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-rock" />
                ) : null}
                <Icon className={cn('size-4 shrink-0', active && 'text-rock')} />
                {!collapsed ? <span className="truncate">{link.label}</span> : null}
              </Link>
            );
            return collapsed ? (
              <Tooltip key={link.href}>
                <TooltipTrigger asChild>{body}</TooltipTrigger>
                <TooltipContent side="right">
                  <span className="font-medium text-bone">{link.label}</span> {'·'} {link.hint}
                </TooltipContent>
              </Tooltip>
            ) : (
              <React.Fragment key={link.href}>{body}</React.Fragment>
            );
          })}
        </div>

        <div className={cn('shrink-0 border-t border-rule-faint py-3', collapsed ? 'px-2' : 'px-2.5')}>
          {session ? (
            <div
              className={cn(
                'flex items-center gap-2 rounded-[var(--radius-sm)] bg-sunk p-2',
                collapsed && 'justify-center'
              )}
            >
              <span className="size-6 shrink-0 rounded-full bg-gradient-to-br from-action to-rock" />
              {!collapsed ? (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ash">
                    {session.telegramUsername ?? shortMint(session.address, 4, 4)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    className="text-dim transition-colors hover:text-down"
                    aria-label="Sign out"
                  >
                    <LogOut className="size-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <Button
              variant="action"
              size={collapsed ? 'icon' : 'md'}
              className="w-full"
              onClick={() => setConnecting(true)}
            >
              {collapsed ? <Wallet className="size-4" /> : 'Connect'}
            </Button>
          )}

          <button
            type="button"
            onClick={toggle}
            className={cn(
              'mt-2 flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11px] text-dim',
              'transition-colors hover:bg-raised hover:text-ash',
              collapsed && 'justify-center px-0'
            )}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}
            {!collapsed ? 'Collapse' : null}
          </button>
        </div>
      </nav>

      <ConnectDialog open={connecting} onOpenChange={setConnecting} />
    </>
  );
}
