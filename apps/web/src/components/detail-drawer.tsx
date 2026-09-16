'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, ShieldCheck, X } from 'lucide-react';
import { rockTierLabel, type Finding, type TokenSummary } from '@rockscreener/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, count, multiple, pct, usd } from '@/lib/format';
import { silhouettePillars } from '@/lib/silhouette';
import { CoreStrata, CoverageNote, TIER_TEXT } from '@/components/core-sample';
import { TokenAvatar } from '@/components/token-avatar';
import { CopyMint } from '@/components/copy-mint';
import { Chip, Delta } from '@/components/chips';
import { Button } from '@/components/ui/button';

/**
 * THE SAMPLE DRAWER.
 *
 * NON-MODAL ON A DESKTOP, and that is the point of building it by hand rather
 * than reaching for a modal dialog. A trench reader clicks eight tokens in a
 * minute; a drawer that dims the columns and traps focus makes each of those a
 * two-step open-and-close, and the columns are live, so dimming them hides the
 * thing the reader came for. Here the drawer opens beside the trenches and the
 * next card click simply replaces its contents.
 *
 * ON A PHONE IT IS A SHEET, with a backdrop, because there is no "beside" — it
 * is the screen, and a panel covering the screen without a backdrop is a page
 * that has lost its back button.
 *
 * IT SHOWS THE BREAKDOWN FIRST AND THE NUMBER SECOND. A score of 62 is not
 * actionable; "the LP is burnt, the distribution is fine, and 34% of supply was
 * taken in the first traded slot" is a decision. The findings are ordered
 * worst-first with the positives LAST rather than interleaved — the panel is
 * read for about four seconds, and a layout that mixed "supply is fixed" in
 * among the warnings would spend one of those on reassurance.
 */
export function DetailDrawer({
  token,
  onClose,
}: {
  token: TokenSummary | null;
  onClose: () => void;
}) {
  const { data: score, isLoading } = useQuery({
    queryKey: ['score', token?.mint],
    queryFn: () => api.score(token!.mint),
    enabled: Boolean(token),
  });

  /* Escape closes it. The drawer is non-modal, so nothing else is listening. */
  React.useEffect(() => {
    if (!token) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [token, onClose]);

  const open = Boolean(token);

  return (
    <>
      {/* Backdrop: PHONE ONLY. On a desktop it would dim the live columns the
          reader is watching. */}
      <div
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-hidden="true"
      />

      <aside
        aria-label="Token detail"
        aria-hidden={!open}
        className={cn(
          'fixed z-40 flex flex-col border-rule bg-bench/95 backdrop-blur-xl transition-transform duration-200 ease-out',
          // Phone: a sheet from the bottom, above the floating nav.
          'inset-x-0 bottom-0 max-h-[82dvh] rounded-t-[var(--radius-xl)] border-t',
          // Desktop: a column against the right edge, stopping at the status line.
          'lg:inset-y-0 lg:bottom-[var(--statusline)] lg:left-auto lg:right-0 lg:max-h-none lg:w-[25rem] lg:rounded-none lg:border-l lg:border-t-0',
          open ? 'translate-y-0 lg:translate-x-0' : 'translate-y-full lg:translate-y-0 lg:translate-x-full'
        )}
      >
        {!token ? null : (
          <>
            {/* --- head ----------------------------------------------------- */}
            <div className="flex shrink-0 items-start gap-3 border-b border-rule-faint p-3.5">
              <TokenAvatar mint={token.mint} symbol={token.symbol} imageUrl={token.imageUrl} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-bone">{token.symbol}</span>
                  {token.rock ? (
                    <span className={cn('text-[11px] font-semibold', TIER_TEXT[token.rock.tier])}>
                      {rockTierLabel(token.rock.tier)} {Math.round(token.rock.score)}
                    </span>
                  ) : (
                    <span className="label">unscored</span>
                  )}
                </div>
                <div className="truncate text-[12px] text-ash">{token.name}</div>
                <CopyMint mint={token.mint} lead={6} tail={6} className="mt-0.5" />
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-[var(--radius-xs)] p-1 text-dim transition-colors hover:bg-raised hover:text-bone"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {/* --- the market ------------------------------------------- */}
              <div className="grid grid-cols-3 gap-px border-b border-rule-faint bg-rule-faint">
                <Stat label="Market cap" value={usd(token.marketCapUsd)} />
                <Stat label="Liquidity" value={usd(token.liquidityUsd)} />
                <Stat label="Volume 24h" value={usd(token.volume24hUsd)} />
                <Stat label="5m" value={<Delta value={token.priceChange5m} />} />
                <Stat label="1h" value={<Delta value={token.priceChange1h} />} />
                <Stat label="24h" value={<Delta value={token.priceChange24h} />} />
              </div>

              {/* --- the core --------------------------------------------- */}
              <section className="p-3.5">
                <h3 className="label mb-2">The core sample</h3>
                {isLoading ? (
                  <div className="animate-pulse-rock h-[9rem] rounded-[var(--radius-sm)] bg-rule-faint" />
                ) : score ? (
                  <>
                    <CoreStrata pillars={score.pillars} tier={score.tier} />
                    <CoverageNote coverage={score.coverage} className="mt-2.5" />
                    {score.clamped ? (
                      <div className="mt-2.5 flex gap-2 rounded-[var(--radius-sm)] border border-down/30 bg-down/10 p-2">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-down" />
                        <p className="text-[11px] leading-relaxed text-down">
                          <span className="font-semibold">Capped at {score.clamped.at}.</span>{' '}
                          {score.clamped.reason} Four good strata do not outvote this one.
                        </p>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <CoreStrata pillars={silhouettePillars(token)} tier="dust" />
                    <p className="mt-2.5 text-[11px] leading-relaxed text-dim">
                      Not scored yet. A token this new has no distribution and no trading to read,
                      so nothing is published rather than a number four fifths invented.
                    </p>
                  </>
                )}
              </section>

              {/* --- the launch -------------------------------------------- */}
              {score?.launch.analyzed ? (
                <section className="border-t border-rule-faint p-3.5">
                  <h3 className="label mb-2.5">The launch</h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <Reading
                      label="First slot"
                      value={pct(score.launch.bundledPct)}
                      note={score.launch.bundleWallets ? `${score.launch.bundleWallets} wallets` : null}
                      bad={(score.launch.bundledPct ?? 0) >= 15}
                    />
                    <Reading
                      label="First 15s"
                      value={pct(score.launch.sniperPct)}
                      note={score.launch.sniperWallets ? `${score.launch.sniperWallets} wallets` : null}
                      bad={(score.launch.sniperPct ?? 0) >= 35}
                    />
                    <Reading
                      label="One funder"
                      value={pct(score.launch.clusteredPct)}
                      note={score.launch.clusters ? `${score.launch.clusters} clusters` : null}
                      bad={(score.launch.clusteredPct ?? 0) >= 15}
                    />
                    <Reading
                      label="Still held"
                      value={pct(score.launch.stillHeldPct)}
                      note="of the bundle"
                      bad={(score.launch.stillHeldPct ?? 0) >= 12}
                    />
                  </div>
                  {score.creator ? (
                    <p className="mt-3 text-[11px] leading-relaxed text-dim">
                      The creator has launched {score.creator.tokensLaunched} token
                      {score.creator.tokensLaunched === 1 ? '' : 's'}
                      {score.creator.tokensLaunched > 1
                        ? `, ${score.creator.rugged} of which ended badly and ${score.creator.survived} of which are still trading.`
                        : '. A first launch is not a signal in either direction.'}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {/* --- findings ---------------------------------------------- */}
              {score && score.findings.length > 0 ? (
                <section className="border-t border-rule-faint p-3.5">
                  <h3 className="label mb-2">What was found</h3>
                  <ul className="space-y-2">
                    {score.findings.map((f) => (
                      <FindingLine key={f.code} finding={f} />
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* --- the call ----------------------------------------------- */}
              {token.call ? (
                <section className="border-t border-rule-faint p-3.5">
                  <h3 className="label mb-2">The call</h3>
                  <p className="text-[12px] leading-relaxed text-ash">
                    Called {ago(token.call.calledAt)} ago at a{' '}
                    <span className="tnum text-bone">{usd(token.call.entryMarketCapUsd)}</span>{' '}
                    market cap. It reached{' '}
                    <span className="tnum text-up">{multiple(token.call.peakMultiple)}</span> and is
                    currently{' '}
                    <span
                      className={cn(
                        'tnum',
                        token.call.currentMultiple >= 1 ? 'text-up' : 'text-down'
                      )}
                    >
                      {multiple(token.call.currentMultiple)}
                    </span>
                    .
                  </p>
                </section>
              ) : null}

              {/* --- reported, not scored ------------------------------------ */}
              <section className="border-t border-rule-faint p-3.5">
                <h3 className="label mb-2">Reported, not scored</h3>
                <div className="flex flex-wrap gap-1.5">
                  {token.dexPaid === null ? (
                    <Chip state="unknown" title="DexScreener has not been asked about this token.">
                      paid {'—'}
                    </Chip>
                  ) : token.dexPaid ? (
                    <Chip>paid listing</Chip>
                  ) : (
                    <Chip title="Checked. Nothing paid for — which is not a mark against it.">
                      nothing paid
                    </Chip>
                  )}
                  <Chip>{token.dexId ?? 'unlisted'}</Chip>
                  <Chip>{count(token.holderCount)} holders</Chip>
                  <Chip>{count(token.traders24h)} traders</Chip>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-dim">
                  A paid profile is what a real project does and most scams do not bother with; a
                  trending ad is as likely to be a marketing budget as an exit being funded. Both
                  are facts and neither moves the grade.
                </p>
              </section>
            </div>

            {/* --- act ------------------------------------------------------- */}
            <div className="flex shrink-0 items-center gap-2 border-t border-rule-faint p-3">
              <Button variant="action" className="flex-1" asChild>
                <Link href={`/token/${token.mint}`}>Open {token.symbol}</Link>
              </Button>
              <Button variant="outline" size="icon" asChild title="Solscan">
                <a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer">
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-bench px-3 py-2">
      <div className="label leading-none">{label}</div>
      <div className="tnum mt-1 text-[13px] leading-none text-bone">{value}</div>
    </div>
  );
}

function Reading({
  label,
  value,
  note,
  bad,
}: {
  label: string;
  value: string;
  note: string | null;
  bad: boolean;
}) {
  return (
    <div>
      <div className="label leading-none">{label}</div>
      <div className={cn('tnum mt-1 text-[13px] leading-none', bad ? 'text-warn' : 'text-bone')}>
        {value}
      </div>
      {note ? <div className="label mt-0.5">{note}</div> : null}
    </div>
  );
}

const SEVERITY_STYLE: Record<Finding['severity'], string> = {
  critical: 'text-down',
  high: 'text-down/85',
  medium: 'text-warn',
  low: 'text-ash',
  good: 'text-rock',
};

function FindingLine({ finding }: { finding: Finding }) {
  const Icon = finding.severity === 'good' ? ShieldCheck : AlertTriangle;
  return (
    <li className="flex gap-2">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', SEVERITY_STYLE[finding.severity])} />
      <span className="text-[12px] leading-relaxed text-ash">{finding.message}</span>
    </li>
  );
}
