'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ExternalLink, Loader2 } from 'lucide-react';
import { LAMPORTS_PER_SOL, explorerTx, type TokenDetail } from '@rockscreener/shared';
import { api, USING_MOCK } from '@/lib/api';
import { cn } from '@/lib/cn';
import { pct, usd } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';

/**
 * THE TICKET.
 *
 * IT WARNS BEFORE IT PRICES. The caution below is drawn from the same findings
 * the grade is built on and it sits ABOVE the amount field, not beside the
 * button — a warning somebody reads after they have typed a number is a warning
 * they have already decided to ignore.
 *
 * IT DOES NOT REFUSE. The engine's entry rules are what somebody wrote down to
 * be applied while they are not watching; this is a person looking at a token
 * and deciding. Blocking the trade here would mean the product refusing to let
 * them buy what is on their screen because of a rule written for a different
 * purpose — so it says the thing plainly and then gets out of the way.
 *
 * THE PRESETS ARE SOL, NOT PERCENTAGES OF A BALANCE, on the buy side. A "50%"
 * button on a launchpad is how somebody puts half their wallet into a token
 * they have been looking at for nine seconds. On the SELL side percentages are
 * correct, because there the quantity is the position they already hold.
 */
const BUY_PRESETS = [0.1, 0.25, 0.5, 1];
const SELL_PRESETS = [25, 50, 100];

export function TradePanel({ token, className }: { token: TokenDetail; className?: string }) {
  const qc = useQueryClient();
  const [side, setSide] = React.useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = React.useState('0.25');
  const [percent, setPercent] = React.useState(50);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [filled, setFilled] = React.useState<string | null>(null);

  const { data: session } = useQuery({ queryKey: ['session'], queryFn: () => api.session() });

  /*
   * The route is priced as the amount settles, DEBOUNCED — an aggregator quote
   * per keystroke is a request per keystroke, and the number it returns for
   * "0.2" on the way to "0.25" is not one anybody reads.
   */
  const [debounced, setDebounced] = React.useState(amount);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(amount), 400);
    return () => clearTimeout(t);
  }, [amount]);

  const lamports = React.useMemo(() => {
    const n = Number(debounced);
    return Number.isFinite(n) && n > 0 ? String(Math.round(n * LAMPORTS_PER_SOL)) : null;
  }, [debounced]);

  const { data: quote, isFetching: quoting } = useQuery({
    queryKey: ['trade-quote', token.mint, side, lamports],
    queryFn: () => api.tradeQuote(token.mint, 'buy', lamports!),
    // Only the buy side can be priced from an amount the user typed; a sell is
    // sized from the chain at the moment it is pressed, so there is nothing
    // here to quote against.
    enabled: side === 'buy' && lamports !== null && !USING_MOCK,
    staleTime: 8_000,
  });

  const blocking =
    token.freezeAuthorityRevoked === false
      ? 'The freeze authority is still live. Whoever holds it can freeze your token account after the trade fills.'
      : token.rock?.sellOk === false
        ? 'No route exists to sell a real position. Nobody is getting out of this at size.'
        : token.rock?.sellOk === null
          ? 'Nothing has confirmed this token can be sold yet. That is not the same as a clean check.'
          : null;

  const submit = async (): Promise<void> => {
    setError(null);
    setFilled(null);
    setBusy(true);
    try {
      if (USING_MOCK) throw new Error('No backend is connected in this build.');
      const result = await api.trade(
        side === 'buy'
          ? { mint: token.mint, side, amountLamports: lamports ?? '0' }
          : { mint: token.mint, side, percent }
      );
      setFilled(result.signature);
      // The balance and the position list both just changed.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['wallets'] }),
        qc.invalidateQueries({ queryKey: ['positions'] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That trade did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className={cn('overflow-hidden', className)}>
      <PanelHead label="Trade" hint={token.symbol}>
        <div className="segment flex gap-0.5 p-0.5">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setFilled(null);
                setError(null);
              }}
              className={cn(
                'rounded-[var(--radius-pill)] px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors',
                side === s
                  ? s === 'buy'
                    ? 'bg-rock/20 text-rock'
                    : 'bg-down/15 text-down'
                  : 'text-dim hover:text-ash'
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </PanelHead>

      <div className="space-y-3 p-3.5">
        {blocking ? (
          <div
            className={cn(
              'flex gap-2 rounded-[var(--radius-sm)] border p-2.5',
              token.rock?.sellOk === null
                ? 'border-warn/30 bg-warn/10 text-warn'
                : 'border-down/30 bg-down/10 text-down'
            )}
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p className="text-[11px] leading-relaxed">{blocking}</p>
          </div>
        ) : null}

        {side === 'buy' ? (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">Amount</span>
              <span className="label">SOL</span>
            </div>
            <Input
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 h-10 text-[15px]"
            />
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {BUY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(String(p))}
                  className={cn(
                    'rounded-[var(--radius-xs)] border border-rule-faint py-1 text-[11px] transition-colors',
                    Number(amount) === p ? 'border-rule bg-raised text-bone' : 'text-dim hover:text-ash'
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">Sell</span>
              <span className="tnum text-[12px] text-bone">{percent}%</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {SELL_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPercent(p)}
                  className={cn(
                    'rounded-[var(--radius-xs)] border border-rule-faint py-1.5 text-[12px] transition-colors',
                    percent === p ? 'border-rule bg-raised text-bone' : 'text-dim hover:text-ash'
                  )}
                >
                  {p}%
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-dim">
              Sized from the chain when you press it, not from what this page last drew — so 100%
              means the whole position as it is now.
            </p>
          </div>
        )}

        <dl className="space-y-1 border-t border-rule-faint pt-2.5 text-[11px]">
          <Row term="Price" value={usd(token.priceUsd, { compact: false })} />
          <Row term="Liquidity" value={usd(token.liquidityUsd)} />
          <Row
            term="Route impact"
            value={
              side === 'sell'
                ? '—'
                : quoting
                  ? '…'
                  : quote
                    ? pct(quote.priceImpactPct)
                    : '—'
            }
            hint={side === 'sell' ? 'priced at fill' : quote ? undefined : 'no route'}
          />
        </dl>

        <Button
          variant={side === 'buy' ? 'action' : 'danger'}
          className="h-10 w-full"
          disabled={!session || busy || (side === 'buy' && lamports === null)}
          onClick={submit}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Filling
            </>
          ) : !session ? (
            'Connect to trade'
          ) : (
            `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`
          )}
        </Button>

        {filled ? (
          <a
            href={explorerTx(filled)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-rock/30 bg-rock-wash px-2.5 py-2 text-[11px] text-rock transition-colors hover:bg-rock/15"
          >
            <Check className="size-3.5 shrink-0" />
            Filled — open the transaction
            <ExternalLink className="ml-auto size-3" />
          </a>
        ) : null}

        {error ? (
          <p className="rounded-[var(--radius-sm)] border border-down/30 bg-down/10 px-2.5 py-2 text-[11px] leading-relaxed text-down">
            {error}
          </p>
        ) : null}

        <p className="text-[10.5px] leading-relaxed text-dim">
          Routed through Jupiter from your own custodial wallet. Nothing is signed for you outside
          the trade you pressed, and the engine&rsquo;s rules do not apply to a manual ticket.
        </p>
      </div>
    </Panel>
  );
}

function Row({ term, value, hint }: { term: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-dim">{term}</dt>
      <dd className={cn('tnum', hint ? 'text-dim' : 'text-ash')}>
        {value}
        {hint ? <span className="ml-1 text-dim">{hint}</span> : null}
      </dd>
    </div>
  );
}
