'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Send, Wallet } from 'lucide-react';
import { api, USING_MOCK } from '@/lib/api';
import { cn } from '@/lib/cn';
import { connectAndSign, walletInstalled } from '@/lib/wallet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/**
 * TWO WAYS IN, AND NEITHER IS A PASSWORD.
 *
 * A Solana wallet proves control of an address by signing a challenge THIS
 * SERVER ISSUED — never text the client chose, because a client that picks the
 * wording can get a signature over anything and present it here as a login.
 * Telegram proves control of an account through a widget payload signed under
 * the bot token. Both land on the same account row, because what a person wants
 * back when they return is their rules and their positions, not their login
 * method.
 *
 * A METHOD WITH NO CREDENTIALS IS GREYED OUT WITH A REASON rather than offered
 * and then failing at the last step. A deployment without a Telegram bot token
 * is not broken; it simply cannot do that one thing, and saying so up front is
 * the difference between a missing feature and a bug.
 */
export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<'wallet' | 'telegram' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const { data: methods } = useQuery({
    queryKey: ['auth-methods'],
    queryFn: () => api.authMethods(),
    enabled: open,
  });

  /* Detected after mount: `window.solana` does not exist on the server. */
  const [hasWallet, setHasWallet] = React.useState(true);
  React.useEffect(() => setHasWallet(walletInstalled()), [open]);

  const connectWallet = async (): Promise<void> => {
    setError(null);
    setBusy('wallet');
    try {
      if (USING_MOCK) {
        throw new Error('No backend is connected in this build. Add ?demo=in to see the signed-in shell.');
      }
      /*
       * The challenge is fetched INSIDE the signing flow, after the address is
       * known: the message names the address, and one fetched for a wallet the
       * user then switched away from is a signature the server will correctly
       * reject.
       */
      const signed = await connectAndSign(async (address) => (await api.nonce(address)).message);
      await api.verifyWallet(signed.address, signed.signature);
      await qc.invalidateQueries({ queryKey: ['session'] });
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="text-[15px] font-semibold text-bone">Connect</DialogTitle>
        <DialogDescription className="mt-1 text-[12px] leading-relaxed text-dim">
          Reading the bench never needs an account. Sign in when you want the engine to hold rules
          and a wallet for you.
        </DialogDescription>

        <div className="mt-4 space-y-2">
          <Method
            icon={<Wallet className="size-4" />}
            title="Solana wallet"
            body={
              !hasWallet
                ? 'No wallet extension is installed in this browser.'
                : 'Sign a message. No transaction, no fee, and no approval to spend anything.'
            }
            busy={busy === 'wallet'}
            disabled={!hasWallet || methods?.wallet === false}
            onClick={connectWallet}
          />
          <Method
            icon={<Send className="size-4" />}
            title="Telegram"
            body={
              methods?.telegram === false
                ? 'Not configured on this deployment.'
                : 'Signs you in through the login widget, and lets the engine message you when it fills.'
            }
            busy={busy === 'telegram'}
            disabled={methods?.telegram === false}
            onClick={() => {
              /*
               * Telegram's Login Widget renders its own button and calls back
               * into the page — there is no imperative API to start it, so the
               * widget mounts below rather than being triggered here.
               */
              setError('Use the Telegram button below.');
            }}
          />
        </div>

        {methods?.telegram ? <TelegramWidget onError={setError} /> : null}

        {error ? (
          <p className="mt-3 rounded-[var(--radius-sm)] border border-warn/30 bg-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
            {error}
          </p>
        ) : null}

        <p className="mt-4 text-[11px] leading-relaxed text-dim">
          A custodial trading wallet is generated for you on first sign-in. Its key is encrypted
          with a master key held only in the server process — never written to the database, never
          logged, and never returned by any endpoint.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Telegram's Login Widget.
 *
 * It is a script tag that injects an iframe and calls a GLOBAL callback, which
 * is why the handler is installed on `window` and cleaned up on unmount. The
 * payload it hands back is signed under the bot token and is verified
 * server-side — nothing here trusts it, and nothing here can: the browser does
 * not have the bot token, which is the entire point of the scheme.
 */
function TelegramWidget({ onError }: { onError: (message: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  React.useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT;
    if (!botUsername) return;

    (window as unknown as Record<string, unknown>).onTelegramAuth = async (
      payload: Record<string, unknown>
    ) => {
      try {
        await api.verifyTelegram(payload);
        await qc.invalidateQueries({ queryKey: ['session'] });
      } catch (err) {
        onError(messageOf(err));
      }
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'medium');
    script.setAttribute('data-radius', '8');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
      delete (window as unknown as Record<string, unknown>).onTelegramAuth;
    };
  }, [onError, qc]);

  return <div ref={ref} className="mt-3 flex justify-center" />;
}

function Method({
  icon,
  title,
  body,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        'flex w-full items-start gap-3 rounded-[var(--radius-md)] border border-rule-faint bg-sunk p-3 text-left',
        'transition-colors hover:border-rule hover:bg-raised',
        'disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-rule-faint disabled:hover:bg-sunk'
      )}
    >
      <span className="mt-0.5 text-action">
        {busy ? <Loader2 className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-bone">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-dim">{body}</span>
      </span>
    </button>
  );
}

/**
 * A wallet rejection is not an error state.
 *
 * Code 4001 is "the user pressed cancel", which every wallet reports as a
 * thrown exception — showing it as a red failure banner tells somebody their
 * own deliberate action went wrong.
 */
function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 4001) {
    return 'Sign-in cancelled.';
  }
  return err instanceof Error ? err.message : 'Could not connect.';
}
