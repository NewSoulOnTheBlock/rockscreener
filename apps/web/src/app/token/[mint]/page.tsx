'use client';

import * as React from 'react';
import Link from 'next/link';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Globe, Send, Twitter } from 'lucide-react';
import { rockTierLabel } from '@rockscreener/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, compactNumber, count, pct, usd } from '@/lib/format';
import { Chip, Delta } from '@/components/chips';
import { CopyMint } from '@/components/copy-mint';
import { CoreStrata, CoverageNote, TIER_TEXT, Verdict } from '@/components/core-sample';
import { TokenAvatar } from '@/components/token-avatar';
import { silhouettePillars } from '@/lib/silhouette';
import { ChartEmbed } from '@/components/chart-embed';
import { TradePanel } from '@/components/trade-panel';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * ONE TOKEN, IN FULL.
 *
 * The page is laid out in the order a decision is actually made: what it is,
 * what it is worth, WHY the grade says what it says, who holds it, and only
 * then the ticket to buy it. The trade panel is deliberately last in the
 * reading order and first in the visual hierarchy on a wide screen — it is the
 * action, but it must never be the argument.
 */
export default function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = use(params);

  const { data: token, isLoading, isError } = useQuery({
    queryKey: ['token', mint],
    queryFn: () => api.token(mint),
    refetchInterval: 8_000,
  });
  const { data: score } = useQuery({
    queryKey: ['score', mint],
    queryFn: () => api.score(mint),
    enabled: Boolean(token),
  });
  const { data: holders } = useQuery({
    queryKey: ['holders', mint],
    queryFn: () => api.holders(mint),
    enabled: Boolean(token),
  });

  if (isError) {
    return (
      <Shell>
        <Panel className="p-8 text-center">
          <p className="font-display text-2xl text-ash">Nothing indexed under that mint</p>
          <p className="mx-auto mt-2 max-w-[28rem] text-[12px] leading-relaxed text-dim">
            Either it has never traded, or it is below the activation threshold and is carried as
            an identity record only. Nothing is scored until there is something to read.
          </p>
        </Panel>
      </Shell>
    );
  }

  if (isLoading || !token) {
    return (
      <Shell>
        <div className="animate-pulse-rock h-32 rounded-[var(--radius-lg)] bg-slab" />
      </Shell>
    );
  }

  return (
    <Shell>
      {/* --- identity -------------------------------------------------------- */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-start gap-4">
          <TokenAvatar mint={token.mint} symbol={token.symbol} imageUrl={token.imageUrl} size={56} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-bold leading-none text-bone">{token.symbol}</h1>
              <span className="text-[14px] text-ash">{token.name}</span>
              <Chip>{token.launchpad}</Chip>
              {token.status === 'BONDING' ? (
                <Chip
                  tone={token.progressBps === null ? undefined : 'action'}
                  state={token.progressBps === null ? 'unknown' : 'on'}
                  title="How far the bonding curve has filled."
                >
                  {token.progressBps === null ? 'curve \u2014' : `${(token.progressBps / 100).toFixed(0)}% bonded`}
                </Chip>
              ) : (
                <Chip tone="rock">graduated</Chip>
              )}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <CopyMint mint={token.mint} lead={8} tail={8} />
              <span className="label">{ago(token.launchTime)} old</span>
              {token.websiteUrl ? <IconLink href={token.websiteUrl} icon={<Globe className="size-3.5" />} /> : null}
              {token.twitterUrl ? <IconLink href={token.twitterUrl} icon={<Twitter className="size-3.5" />} /> : null}
              {token.telegramUrl ? <IconLink href={token.telegramUrl} icon={<Send className="size-3.5" />} /> : null}
              <a
                href={token.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-dim transition-colors hover:text-ash"
              >
                Solscan
                <ArrowUpRight className="size-3" />
              </a>
            </div>
          </div>

          <div className="text-right">
            <div className="tnum text-[22px] font-bold leading-none text-bone">
              {usd(token.priceUsd, { compact: false })}
            </div>
            <div className="mt-1.5 flex justify-end gap-3">
              <LabelledDelta label="5m" value={token.priceChange5m} />
              <LabelledDelta label="1h" value={token.priceChange1h} />
              <LabelledDelta label="24h" value={token.priceChange24h} />
            </div>
          </div>

          {token.rock ? (
            <Verdict
              pillars={score?.pillars ?? silhouettePillars(token)}
              score={token.rock.score}
              tier={token.rock.tier}
              coverage={token.rock.coverage}
              className="shrink-0"
            />
          ) : null}
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-4">
          {/* --- the market ------------------------------------------------- */}
          <Panel>
            <PanelHead label="Market" />
            <div className="grid grid-cols-2 gap-px bg-rule-faint sm:grid-cols-4">
              <Stat label="Market cap" value={usd(token.marketCapUsd)} />
              <Stat label="Liquidity" value={usd(token.liquidityUsd)} />
              <Stat label="Volume 24h" value={usd(token.volume24hUsd)} />
              <Stat label="All-time high" value={usd(token.allTimeHighUsd, { compact: false })} />
              <Stat label="Holders" value={count(token.holderCount)} />
              <Stat label="Traders 24h" value={count(token.traders24h)} />
              <Stat label="Buys / sells" value={`${compactNumber(token.buys24h)} / ${compactNumber(token.sells24h)}`} />
              <Stat label="Markets" value={String(token.marketCount)} />
            </div>
          </Panel>

          {/* --- the grade ---------------------------------------------------- */}
          <Panel>
            <PanelHead
              label="The grade"
              hint={score ? `computed ${ago(score.computedAt)} ago` : undefined}
            />
            <div className="p-3.5">
              {score ? (
                <>
                  <CoreStrata pillars={score.pillars} tier={score.tier} />
                  <CoverageNote coverage={score.coverage} className="mt-3" />
                  {score.findings.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-t border-rule-faint pt-3">
                      {score.findings.map((f) => (
                        <li key={f.code} className="flex gap-2 text-[12px] leading-relaxed">
                          <span
                            className={cn(
                              'mt-[5px] size-1.5 shrink-0 rounded-full',
                              f.severity === 'good'
                                ? 'bg-rock'
                                : f.severity === 'critical' || f.severity === 'high'
                                  ? 'bg-down'
                                  : 'bg-warn'
                            )}
                          />
                          <span className="text-ash">{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-[12px] leading-relaxed text-dim">
                  Not scored yet.
                </p>
              )}
            </div>
          </Panel>

          {/* --- the mint ------------------------------------------------------ */}
          <Panel>
            <PanelHead label="The mint" hint="facts, tri-state" />
            <div className="flex flex-wrap gap-2 p-3.5">
              <Authority label="Mint authority" revoked={token.mintAuthorityRevoked} />
              <Authority label="Freeze authority" revoked={token.freezeAuthorityRevoked} />
              <Chip
                state={token.metadataMutable === null ? 'unknown' : 'on'}
                tone={token.metadataMutable ? 'warn' : 'rock'}
                title="Whether the name, symbol and art can still be changed."
              >
                metadata {token.metadataMutable === null ? '—' : token.metadataMutable ? 'mutable' : 'frozen'}
              </Chip>
              <Chip
                tone={token.transferFeeBps > 0 ? 'warn' : 'rock'}
                title="Token-2022 transfer fee. Zero on a plain SPL mint."
              >
                transfer fee {(token.transferFeeBps / 100).toFixed(2)}%
              </Chip>
              <Chip
                state={token.lpLockedPct === null ? 'unknown' : 'on'}
                tone={(token.lpLockedPct ?? 0) >= 90 ? 'rock' : 'warn'}
                title="Share of the LP that is locked or burnt."
              >
                LP {token.lpLockedPct === null ? '—' : pct(token.lpLockedPct, 0)} secured
              </Chip>
              <Chip title="Total supply, in whole tokens.">
                supply {compactNumber(Number(token.totalSupply) / 10 ** token.decimals)}
              </Chip>
            </div>
          </Panel>

          {/* --- holders ------------------------------------------------------- */}
          <Panel>
            <PanelHead
              label="Who holds it"
              hint="AMM vaults labelled, never counted as whales"
            />
            <div className="p-3.5">
              {(holders ?? []).map((h) => (
                <div key={h.address} className="flex items-center gap-2.5 py-1.5">
                  <span className="label w-5 shrink-0 text-right">{h.rank}</span>
                  <span
                    className={cn(
                      'h-1.5 shrink-0 rounded-full',
                      h.kind === 'amm'
                        ? 'bg-dim'
                        : h.kind === 'creator'
                          ? 'bg-warn'
                          : 'bg-rock/60'
                    )}
                    style={{ width: `${Math.max(2, Math.min(60, h.pct))}%` }}
                  />
                  <span className="tnum shrink-0 text-[12px] text-bone">{pct(h.pct)}</span>
                  <CopyMint mint={h.address} className="ml-auto" />
                  {h.label ? <Chip>{h.label}</Chip> : null}
                </div>
              ))}
              <p className="mt-2 text-[11px] leading-relaxed text-dim">
                The largest balance in almost every Solana token belongs to its own pool. Counting
                it would report every healthy graduated launch as maximally concentrated, so it is
                labelled and excluded from the concentration figure the grade uses.
              </p>
            </div>
          </Panel>
        </div>

        {/* --- act, and the tape ---------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <TradePanel token={token} className="xl:sticky xl:top-4" />

          <Panel>
            <PanelHead label="Chart" hint="DexScreener" />
            {/*
              EMBEDDED, NOT REDRAWN. See `ChartEmbed` for why this product
              stores no candles at all — and for the one series it DOES keep,
              which is the call's own path in multiples of its entry.
            */}
            <ChartEmbed pairAddress={token.poolAddress} className="h-[22rem] border-0" />
          </Panel>

        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 py-5 sm:px-6">
      <Link
        href="/"
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-dim transition-colors hover:text-ash"
      >
        <ArrowLeft className="size-3.5" />
        Back to the bench
      </Link>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-slab px-3 py-2.5">
      <div className="label leading-none">{label}</div>
      <div className="tnum mt-1.5 text-[14px] leading-none text-bone">{value}</div>
    </div>
  );
}

function LabelledDelta({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-right">
      <span className="label block leading-none">{label}</span>
      <Delta value={value} className="mt-1 block text-[12px] leading-none" />
    </span>
  );
}

/**
 * An authority chip, and the third state is the one that matters: `null` is
 * "nobody has read the mint account", which is not the same as "revoked".
 */
function Authority({ label, revoked }: { label: string; revoked: boolean | null }) {
  if (revoked === null) {
    return (
      <Chip state="unknown" title="The mint account has not been read yet.">
        {label} {'—'}
      </Chip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Chip tone={revoked ? 'rock' : 'down'}>
            {label} {revoked ? 'revoked' : 'LIVE'}
          </Chip>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {revoked
          ? 'Revoked — nobody can use it any more.'
          : 'Still held. Whoever holds it can use it at any time, without warning.'}
      </TooltipContent>
    </Tooltip>
  );
}

function IconLink({ href, icon }: { href: string; icon: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-dim transition-colors hover:text-ash"
    >
      {icon}
    </a>
  );
}
