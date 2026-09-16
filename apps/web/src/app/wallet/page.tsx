'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Loader2, Plus, Unlink } from 'lucide-react';
import { ROCK_MINT } from '@rockscreener/shared';
import { api, USING_MOCK } from '@/lib/api';
import { ago, compactNumber, sol, usd } from '@/lib/format';
import { connectAndSign, walletInstalled } from '@/lib/wallet';
import { CopyMint } from '@/components/copy-mint';
import { GateBanner } from '@/components/gate-banner';
import { Chip } from '@/components/chips';
import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';

/**
 * WALLETS.
 *
 * TWO KINDS, AND THEY DO DIFFERENT JOBS. The custodial wallet is what the
 * engine spends from; a linked wallet is one you prove you control by signing,
 * and it exists so ROCK you already hold counts toward the gate WITHOUT having
 * to move it. Holding in the wrong wallet is the single commonest reason a
 * token gate looks broken, and the fix is to count both rather than to write a
 * help article.
 *
 * THE KEY WARNING IS ON THE PAGE, NOT IN A TOOLTIP. A custodial key is
 * encrypted with a master key that lives only in the server process — never in
 * the database, never in a log, never in a response. Losing that master key
 * loses every wallet and there is no recovery path, because a recoverable
 * master key is simply a second copy of it. That is a real property of the
 * system and the person holding money in it is entitled to read it.
 */
export default function WalletPage() {
  const qc = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  const { data: wallets } = useQuery({ queryKey: ['wallets'], queryFn: () => api.wallets() });
  const { data: gate, isFetching } = useQuery({ queryKey: ['gate'], queryFn: () => api.gate() });
  const { data: linked } = useQuery({ queryKey: ['linked'], queryFn: () => api.linkedWallets() });
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: () => api.session() });

  const create = useMutation({
    mutationFn: () => api.createWallet(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
    onError: (err: Error) => setError(err.message),
  });

  /**
   * Linking proves control by signing a challenge THIS SERVER issued.
   *
   * The challenge is fetched inside the flow, after the address is known,
   * because the message names that address — one fetched for a wallet the user
   * then switched away from is a signature the server will correctly reject.
   */
  const link = useMutation({
    mutationFn: async () => {
      if (USING_MOCK) throw new Error('No backend is connected in this build.');
      const signed = await connectAndSign(async (address) => (await api.nonce(address)).message);
      return api.linkWallet(signed.address, signed.signature);
    },
    onSuccess: async () => {
      setError(null);
      // The gate counts linked wallets, so it is stale the moment one lands.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['linked'] }),
        qc.fetchQuery({ queryKey: ['gate'], queryFn: () => api.gate(true) }),
      ]);
    },
    onError: (err: unknown) => setError(messageOf(err)),
  });

  const unlink = useMutation({
    mutationFn: (address: string) => api.unlinkWallet(address),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['linked'] }),
        qc.fetchQuery({ queryKey: ['gate'], queryFn: () => api.gate(true) }),
      ]);
    },
  });

  const signedOut = session === null;

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-5 sm:px-6">
      <header className="mb-4">
        <h1 className="font-display text-[30px] leading-none text-bone sm:text-[34px]">Wallet</h1>
        <p className="mt-1.5 max-w-[42rem] text-[12px] leading-relaxed text-dim">
          One wallet the engine spends from, and any number of wallets you have proved you control.
          ROCK in either counts toward the auto-trade gate.
        </p>
      </header>

      {gate ? (
        <GateBanner
          gate={gate}
          rechecking={isFetching}
          onRecheck={async () => {
            await qc.fetchQuery({ queryKey: ['gate'], queryFn: () => api.gate(true) });
          }}
          className="mb-4"
        />
      ) : null}

      {error ? (
        <p className="mb-4 rounded-[var(--radius-sm)] border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {error}
        </p>
      ) : null}

      <Panel className="mb-4">
        <PanelHead label="Engine wallet" hint="custodial">
          <Button
            variant="ghost"
            size="sm"
            disabled={signedOut || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            New
          </Button>
        </PanelHead>

        {(wallets ?? []).length === 0 ? (
          <p className="p-4 text-[12px] leading-relaxed text-dim">
            {signedOut
              ? 'Sign in and a custodial wallet is generated for you.'
              : 'No wallet yet. One is created on first sign-in where the deployment holds a master key.'}
          </p>
        ) : (
          (wallets ?? []).map((w) => (
            <div
              key={w.id}
              className="flex flex-wrap items-center gap-4 border-b border-rule-faint p-3.5 last:border-b-0"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-rule bg-sunk text-action">
                <KeyRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-bone">{w.label ?? 'Wallet'}</span>
                  {w.isDefault ? <Chip tone="rock">default</Chip> : null}
                </div>
                <CopyMint mint={w.address} lead={8} tail={8} className="mt-0.5" />
                <div className="label mt-0.5">created {ago(w.createdAt)} ago</div>
              </div>
              <div className="text-right">
                <div className="tnum text-[14px] text-bone">{sol(w.solLamports, 4)}</div>
                <div className="tnum label mt-0.5">{compactNumber(w.rockTokens)} ROCK</div>
              </div>
            </div>
          ))
        )}

        <p className="border-t border-rule-faint p-3.5 text-[11px] leading-relaxed text-dim">
          The private key is encrypted at rest with a master key held only in the server process.
          It is never written to the database, never logged, and no endpoint returns it — there is
          no export, by design. Fund this wallet with what you intend the engine to risk and no
          more.
        </p>
      </Panel>

      <Panel>
        <PanelHead label="Linked wallets" hint="proved by signature, never touched">
          <Button
            variant="outline"
            size="sm"
            disabled={signedOut || link.isPending || !walletInstalled()}
            onClick={() => link.mutate()}
          >
            {link.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
            Link a wallet
          </Button>
        </PanelHead>

        <div className="p-3.5">
          {(linked ?? []).length === 0 ? (
            <p className="text-[12px] leading-relaxed text-dim">
              Nothing linked. Link the wallet your ROCK is already in and it counts toward the
              gate — you do not have to move it.
            </p>
          ) : (
            (linked ?? []).map((w) => {
              const counted = gate?.wallets.find((g) => g.address === w.address);
              return (
                <div key={w.address} className="flex items-center gap-3 py-1.5">
                  <CopyMint mint={w.address} lead={8} tail={8} />
                  <span className="label">linked {ago(w.verifiedAt)} ago</span>
                  <span className="tnum ml-auto text-[12px] text-ash">
                    {counted ? `${compactNumber(counted.tokens)} ROCK` : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => unlink.mutate(w.address)}
                    className="text-dim transition-colors hover:text-down"
                    aria-label={`Unlink ${w.address}`}
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            Linking grants no spending power of any kind. There is no key column for a linked
            wallet anywhere in the schema and no code path that could sign for one; it is read
            only to count ROCK toward the gate.
          </p>

          <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-sm)] border border-rule-faint bg-sunk p-2.5">
            <span className="label shrink-0">ROCK mint</span>
            <CopyMint mint={ROCK_MINT} lead={10} tail={10} />
            {gate?.priceUsd ? (
              <span className="tnum ml-auto text-[11px] text-ash">
                {usd(gate.priceUsd, { compact: false })}
              </span>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** A wallet rejection is the user pressing cancel, not an error state. */
function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 4001) {
    return 'Cancelled.';
  }
  return err instanceof Error ? err.message : 'Could not link that wallet.';
}
