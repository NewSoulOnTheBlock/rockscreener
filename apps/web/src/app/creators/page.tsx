'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, usd } from '@/lib/format';
import { CopyMint } from '@/components/copy-mint';
import { Chip } from '@/components/chips';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * CREATORS.
 *
 * A creator's record is the single most predictive fact available about the
 * token in front of you — more than any property of the mint itself. Somebody
 * on their ninth launch, seven of which lost most of their liquidity within an
 * hour of peak, is telling you what the tenth will be.
 *
 * GROUPED SERVER-SIDE. An earlier version pulled a page of the screener and
 * bucketed it in the browser, which meant the "top creators" were whoever
 * happened to appear in the most recent sixty rows — a ranking of recency
 * wearing the label of a ranking of activity.
 *
 * A FIRST LAUNCH IS NOT A SIGNAL IN EITHER DIRECTION, and the list says so by
 * not containing them: the API only returns creators this index has seen launch
 * more than once. A page of first-time creators is a page of no information.
 */
const REPUTATION: Record<string, { label: string; tone: 'rock' | 'warn' | 'down' | undefined }> = {
  trusted: { label: 'trusted', tone: 'rock' },
  neutral: { label: 'neutral', tone: undefined },
  suspect: { label: 'suspect', tone: 'warn' },
  serial_rugger: { label: 'serial rugger', tone: 'down' },
};

export default function CreatorsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['creators'],
    queryFn: () => api.creators(),
    refetchInterval: 60_000,
  });

  const rows = data ?? [];

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-5 sm:px-6">
      <header className="mb-4">
        <h1 className="font-display text-[30px] leading-none text-bone sm:text-[34px]">Creators</h1>
        <p className="mt-1.5 max-w-[44rem] text-[12px] leading-relaxed text-dim">
          Who launched what, and how it ended. A record is built entirely from what this index has
          actually seen, so it is only ever as long as this deployment has been running — and a
          creator seen launching once does not appear at all.
        </p>
      </header>

      <Panel>
        <PanelHead label="Seen launching more than once" hint={`${rows.length} addresses`} />

        {isLoading ? (
          <div aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-rule-faint px-3.5 py-3">
                <span className="animate-pulse-rock h-3 w-32 rounded bg-rule-faint" />
                <span className="animate-pulse-rock ml-auto h-3 w-20 rounded bg-rule-faint" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px] leading-relaxed text-dim">
            Nobody in this index has launched more than once yet. That is the ordinary state of a
            deployment that started recently — the record grows with what it watches.
          </p>
        ) : (
          rows.map((row) => {
            const reputation = row.history?.reputation
              ? REPUTATION[row.history.reputation]
              : undefined;
            return (
              <div
                key={row.address}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule-faint px-3.5 py-2.5 last:border-b-0"
              >
                <CopyMint mint={row.address} lead={6} tail={6} />

                <Chip>{row.launches} launches</Chip>

                {reputation ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Chip tone={reputation.tone}>{reputation.label}</Chip>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {row.history!.rugged} of their launches lost most of their liquidity after
                      reaching a real valuation; {row.history!.survived} are still trading with
                      depth behind them.
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {row.history && row.history.rugged > 0 ? (
                  <span className={cn('tnum text-[11px]', 'text-down')}>
                    {row.history.rugged} rugged
                  </span>
                ) : null}
                {row.history && row.history.survived > 0 ? (
                  <span className="tnum text-[11px] text-up">{row.history.survived} alive</span>
                ) : null}

                <span className="tnum ml-auto text-[12px] text-ash">
                  best {usd(row.bestMarketCapUsd)}
                </span>
                <span className="label w-12 text-right">{ago(row.lastLaunchAt)}</span>
              </div>
            );
          })
        )}
      </Panel>

      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        &ldquo;Rugged&rdquo; here is a measurement, not an accusation: a token that reached a real
        market capitalisation and now has almost no liquidity left. Launches that never traded at
        all are excluded from the count, so a creator&rsquo;s twenty dead experiments do not read
        as twenty rug pulls.
      </p>
    </div>
  );
}
