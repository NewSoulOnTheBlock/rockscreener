'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bot, CheckCircle2, CircleDollarSign, Power, XCircle } from 'lucide-react';
import {
  type AutoTradeEvent,
  type AutoTradeSettings,
  type EntryRules,
  type ExitRules,
} from '@rockscreener/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, multiple, pct, sol, usd } from '@/lib/format';
import { GateBanner } from '@/components/gate-banner';
import { TokenAvatar } from '@/components/token-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * THE ENGINE ROOM.
 *
 * THE LOG IS HALF THIS SCREEN, and that is the design brief rather than a
 * space-filling decision. "Why didn't it buy that one" is the first question
 * anybody asks of an automated buyer, and an engine that cannot answer it is
 * one people switch off after a day. So every refusal names its rule and both
 * numbers — `entry.maxBundledPct: 34.1% above your 20%` — and the refusals are
 * the DEFAULT view, not a filter somebody has to find.
 *
 * THE CEILINGS ARE NOT PREFERENCES. Position size, concurrent positions, hourly
 * spend and the daily loss cap are all required and all bounded, and there is
 * no value of any of them meaning "unlimited". The failure mode of automated
 * buying is not one bad trade, it is forty bad trades in ninety seconds.
 *
 * ARMING IS GATED TWICE: by the ROCK holding, and by the switch. Neither is a
 * substitute for the other — the gate says this account may run an engine, the
 * switch says this account wants one running right now.
 */
export default function AutoTradePage() {
  const qc = useQueryClient();
  const [tab, setTab] = React.useState('log');

  const { data: gate, isFetching: gateBusy } = useQuery({ queryKey: ['gate'], queryFn: () => api.gate() });
  const { data: settings } = useQuery({ queryKey: ['auto-settings'], queryFn: () => api.autoSettings() });
  const { data: positions } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions() });
  const { data: events } = useQuery({ queryKey: ['events'], queryFn: () => api.events(), refetchInterval: 8_000 });

  const [draft, setDraft] = React.useState<AutoTradeSettings | null>(null);
  React.useEffect(() => {
    if (settings && !draft) setDraft(settings);
  }, [settings, draft]);

  const locked = !gate?.unlocked;
  const open = positions?.filter((p) => p.status === 'open' || p.status === 'opening') ?? [];
  const realised = (positions ?? []).reduce((sum, p) => sum + Number(p.pnlLamports), 0);

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 py-5 sm:px-6">
      <header className="mb-4">
        <h1 className="font-display text-[30px] leading-none text-bone sm:text-[34px]">Auto-trade</h1>
        <p className="mt-1.5 max-w-[42rem] text-[12px] leading-relaxed text-dim">
          Rules you write down once, and an engine that follows them without asking again. It
          buys what the product called and your rules are a filter on top of that — never a
          second opinion competing with it.
        </p>
      </header>

      {gate ? (
        <GateBanner
          gate={gate}
          rechecking={gateBusy}
          onRecheck={async () => {
            // `refresh` skips the server's cache: somebody who just bought ROCK
            // should not wait out a TTL to be let in.
            await qc.fetchQuery({ queryKey: ['gate'], queryFn: () => api.gate(true) });
          }}
          className="mb-4"
        />
      ) : null}

      {/* --- arm ------------------------------------------------------------- */}
      <Panel className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border',
            draft?.enabled
              ? 'border-rock/40 bg-rock-wash text-rock'
              : 'border-rule bg-sunk text-dim'
          )}
        >
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-bone">
            {draft?.enabled ? 'Armed' : 'Disarmed'}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-dim">
            {locked
              ? 'Hold the required ROCK to arm the engine. Everything else on this page is editable and stored either way.'
              : draft?.enabled
                ? 'The engine is buying to your rules. Exits run whether it is armed or not — disarming stops new entries and keeps managing what you hold.'
                : 'Exits still run for any open position. Arming only controls whether it opens new ones.'}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Switch
                checked={draft?.enabled ?? false}
                disabled={locked || !draft}
                onCheckedChange={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            {locked ? 'Locked until the ROCK holding clears the line.' : 'Arm or disarm entries.'}
          </TooltipContent>
        </Tooltip>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_25rem]">
        {/* --- log and positions ------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <Panel className="flex min-h-0 flex-col">
            <PanelHead label="What the engine did" hint={`${events?.length ?? 0} events`}>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="log">All</TabsTrigger>
                  <TabsTrigger value="skipped">Refusals</TabsTrigger>
                  <TabsTrigger value="fills">Fills</TabsTrigger>
                </TabsList>
              </Tabs>
            </PanelHead>
            <div className="max-h-[26rem] overflow-y-auto">
              {(events ?? [])
                .filter((e) =>
                  tab === 'skipped'
                    ? e.kind === 'skipped'
                    : tab === 'fills'
                      ? e.kind === 'bought' || e.kind === 'sold'
                      : true
                )
                .map((e) => (
                  <EventLine key={e.id} event={e} />
                ))}
              {!events ? <div className="label p-4">reading the log{'…'}</div> : null}
            </div>
          </Panel>

          <Panel>
            <PanelHead
              label="Positions"
              hint={`${open.length} open`}
            >
              <span className={cn('tnum text-[12px]', realised >= 0 ? 'text-up' : 'text-down')}>
                {realised >= 0 ? '+' : ''}
                {sol(realised)}
              </span>
            </PanelHead>
            {(positions ?? []).length === 0 ? (
              <p className="p-4 text-[12px] text-dim">
                Nothing open. The engine opens at most one position per pass, re-reads its budget
                afterwards, and refuses everything that does not clear your rules.
              </p>
            ) : (
              (positions ?? []).map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 border-b border-rule-faint px-3 py-2.5 last:border-b-0"
                >
                  <TokenAvatar mint={p.mint} symbol={p.symbol} imageUrl={p.imageUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-bone">{p.symbol}</span>
                      <span
                        className={cn(
                          'label',
                          p.status === 'closed' ? 'text-dim' : 'text-rock'
                        )}
                      >
                        {p.status}
                      </span>
                    </div>
                    <div className="label mt-0.5">
                      opened {ago(p.openedAt)} ago at a score of {p.entryScore}
                      {p.closeReason ? ` · ${p.closeReason}` : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn('tnum text-[13px]', p.pnlPct >= 0 ? 'text-up' : 'text-down')}>
                      {p.pnlPct >= 0 ? '+' : ''}
                      {p.pnlPct.toFixed(1)}%
                    </div>
                    <div className="label mt-0.5">{sol(p.spentLamports, 2)} in</div>
                  </div>
                </div>
              ))
            )}
          </Panel>
        </div>

        {/* --- the rules ---------------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <Panel>
            <PanelHead label="Ceilings" hint="required, and bounded" />
            <div className="space-y-3 p-3.5">
              <Field
                label="Position size"
                hint="Per entry."
                value={draft ? String(Number(draft.buyAmountLamports) / 1e9) : ''}
                suffix="SOL"
                onChange={(v) =>
                  setDraft((d) =>
                    d ? { ...d, buyAmountLamports: String(Math.round(Number(v || 0) * 1e9)) } : d
                  )
                }
              />
              <Field
                label="Concurrent positions"
                hint="There is no unlimited value."
                value={draft ? String(draft.maxConcurrentPositions) : ''}
                onChange={(v) =>
                  setDraft((d) => (d ? { ...d, maxConcurrentPositions: Number(v || 1) } : d))
                }
              />
              <Field
                label="Spend per hour"
                hint="Rolling, not per clock hour."
                value={draft ? String(Number(draft.maxSpendPerHourLamports) / 1e9) : ''}
                suffix="SOL"
                onChange={(v) =>
                  setDraft((d) =>
                    d ? { ...d, maxSpendPerHourLamports: String(Math.round(Number(v || 0) * 1e9)) } : d
                  )
                }
              />
              <Field
                label="Daily loss cap"
                hint="DISARMS the engine rather than pausing it — a cap that silently resumes at midnight loses the same money every day."
                value={draft ? String(Number(draft.dailyLossCapLamports) / 1e9) : ''}
                suffix="SOL"
                onChange={(v) =>
                  setDraft((d) =>
                    d ? { ...d, dailyLossCapLamports: String(Math.round(Number(v || 0) * 1e9)) } : d
                  )
                }
              />
              <Field
                label="Slippage"
                value={draft ? String(draft.slippageBps / 100) : ''}
                suffix="%"
                onChange={(v) => setDraft((d) => (d ? { ...d, slippageBps: Math.round(Number(v || 0) * 100) } : d))}
              />
            </div>
          </Panel>

          {draft ? <EntryPanel rules={draft.entry} onChange={(entry) => setDraft({ ...draft, entry })} /> : null}
          {draft ? <ExitPanel rules={draft.exit} onChange={(exit) => setDraft({ ...draft, exit })} /> : null}

          <Button
            variant="action"
            className="w-full"
            disabled={!draft}
            onClick={() => draft && api.saveAutoSettings(draft)}
          >
            Save rules
          </Button>
        </div>
      </div>
    </div>
  );
}

const EVENT_ICON: Record<AutoTradeEvent['kind'], React.ReactNode> = {
  considered: <CircleDollarSign className="size-3.5 text-dim" />,
  skipped: <Ban className="size-3.5 text-dim" />,
  bought: <CheckCircle2 className="size-3.5 text-rock" />,
  sold: <CheckCircle2 className="size-3.5 text-action" />,
  failed: <XCircle className="size-3.5 text-down" />,
  disarmed: <Power className="size-3.5 text-warn" />,
};

function EventLine({ event }: { event: AutoTradeEvent }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-rule-faint px-3 py-2 last:border-b-0">
      <span className="mt-0.5 shrink-0">{EVENT_ICON[event.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12px] font-medium text-bone">{event.symbol ?? 'engine'}</span>
          {/* The rule path, in mono, because it is an identifier the reader will
              go and find in the form above. */}
          {event.rule ? (
            <span className="font-mono text-[10.5px] text-action/90">{event.rule}</span>
          ) : null}
          <span className="label ml-auto">{ago(event.at)}</span>
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ash">{event.message}</p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  suffix?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {suffix ? <span className="label">{suffix}</span> : null}
      </div>
      <Input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        className="mt-1"
      />
      {hint ? <p className="mt-1 text-[11px] leading-relaxed text-dim">{hint}</p> : null}
    </div>
  );
}

/**
 * The entry gates.
 *
 * NULL MEANS "NOT CHECKED" ON THE MARKET-SHAPE RULES, and FAILS on the
 * launch-analysis ones. The asymmetry is deliberate and is worth a line in the
 * UI: a percentage that was never established is not a low percentage, and
 * buying a token whose bundle analysis has not run is betting on which it is.
 */
function EntryPanel({ rules, onChange }: { rules: EntryRules; onChange: (r: EntryRules) => void }) {
  const set = <K extends keyof EntryRules>(key: K, value: EntryRules[K]) =>
    onChange({ ...rules, [key]: value });

  return (
    <Panel>
      <PanelHead label="Entry" hint="a filter on the product's own calls" />
      <div className="space-y-3 p-3.5">
        <Field
          label="Minimum score"
          hint="Required. An engine with no score floor is a bot that buys every launch."
          value={String(rules.minScore)}
          onChange={(v) => set('minScore', Number(v || 0))}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Min liquidity"
            suffix="$"
            value={String(rules.minLiquidityUsd ?? '')}
            onChange={(v) => set('minLiquidityUsd', v === '' ? null : Number(v))}
          />
          <Field
            label="Max market cap"
            suffix="$"
            value={String(rules.maxMarketCapUsd ?? '')}
            onChange={(v) => set('maxMarketCapUsd', v === '' ? null : Number(v))}
          />
          <Field
            label="Max bundled"
            suffix="%"
            value={String(rules.maxBundledPct ?? '')}
            onChange={(v) => set('maxBundledPct', v === '' ? null : Number(v))}
          />
          <Field
            label="Max one funder"
            suffix="%"
            value={String(rules.maxClusteredPct ?? '')}
            onChange={(v) => set('maxClusteredPct', v === '' ? null : Number(v))}
          />
          <Field
            label="Max creator"
            suffix="%"
            value={String(rules.maxCreatorPct ?? '')}
            onChange={(v) => set('maxCreatorPct', v === '' ? null : Number(v))}
          />
          <Field
            label="Max top 10"
            suffix="%"
            value={String(rules.maxTop10Pct ?? '')}
            onChange={(v) => set('maxTop10Pct', v === '' ? null : Number(v))}
          />
        </div>

        <div className="space-y-2 border-t border-rule-faint pt-3">
          <Toggle
            label="Mint authority must be revoked"
            hint="Otherwise supply can be diluted under you at any time."
            checked={rules.requireMintRevoked}
            onChange={(v) => set('requireMintRevoked', v)}
          />
          <Toggle
            label="Freeze authority must be revoked"
            hint="The Solana-native honeypot: the buy succeeds, the balance arrives, and the account is frozen before you can send it anywhere."
            checked={rules.requireFreezeRevoked}
            onChange={(v) => set('requireFreezeRevoked', v)}
          />
          <Toggle
            label="LP must be locked or burnt"
            hint="The single most effective filter here."
            checked={rules.requireLpSecured}
            onChange={(v) => set('requireLpSecured', v)}
          />
          <Toggle
            label="Refuse anything the sell check could not clear"
            hint="It refuses not only a token that FAILED the check but one the check could not answer for — which, minutes after a launch, is the common case. Treating 'we could not check' as a pass is how an automated buyer walks into the one trade it exists to avoid."
            checked={rules.requireSellConfirmed}
            onChange={(v) => set('requireSellConfirmed', v)}
          />
        </div>
      </div>
    </Panel>
  );
}

/**
 * The exits, in the order they are evaluated: WORST NEWS FIRST.
 *
 * The list is shown in that order rather than alphabetically or by type,
 * because the order IS the rule: a rug signal beats a stop, a stop beats a
 * take-profit, and the time limit is last because it is the only one that is
 * not about what the position is worth.
 */
function ExitPanel({ rules, onChange }: { rules: ExitRules; onChange: (r: ExitRules) => void }) {
  const set = <K extends keyof ExitRules>(key: K, value: ExitRules[K]) =>
    onChange({ ...rules, [key]: value });

  return (
    <Panel>
      <PanelHead label="Exit" hint="evaluated worst-news-first" />
      <div className="space-y-3 p-3.5">
        <Toggle
          label="Sell everything on a rug signal"
          hint="Liquidity pulled, the sell route gone, the account frozen. A human finds out when the price is already zero."
          checked={rules.exitOnRugSignal}
          onChange={(v) => set('exitOnRugSignal', v)}
        />
        <Toggle
          label="Sell when the call is withdrawn"
          hint="You choose whether to follow the product's retraction — not what a retraction is. A second configurable definition would be a second opinion competing with the first."
          checked={rules.exitOnCallWithdrawn}
          onChange={(v) => set('exitOnCallWithdrawn', v)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Stop loss"
            suffix="%"
            value={String(rules.stopLossPct ?? '')}
            onChange={(v) => set('stopLossPct', v === '' ? null : Number(v))}
          />
          <Field
            label="Trailing stop"
            suffix="%"
            value={String(rules.trailingStopPct ?? '')}
            onChange={(v) => set('trailingStopPct', v === '' ? null : Number(v))}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-dim">
          The two run together rather than instead of each other: the fixed stop bounds the loss
          from entry, the trailing one protects a gain that has already happened.
        </p>

        <div className="border-t border-rule-faint pt-3">
          <Label>Take profit</Label>
          <p className="mb-2 mt-1 text-[11px] leading-relaxed text-dim">
            Sell that share of what is still held, at that gain. A gap past several rungs fills
            the highest and retires the ones below it.
          </p>
          <div className="space-y-1.5">
            {rules.takeProfit.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className="tnum w-14 text-right text-up">+{step.gainPct}%</span>
                <span className="text-dim">{'→'} sell</span>
                <span className="tnum text-bone">{step.sellPct}%</span>
                <span className="label ml-auto">rung {i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <Label className="text-bone">{label}</Label>
        <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}
