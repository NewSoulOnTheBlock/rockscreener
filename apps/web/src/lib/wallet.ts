import bs58Encode from './bs58';

/**
 * Talking to a browser wallet, without a wallet-adapter stack.
 *
 * WHY NOT `@solana/wallet-adapter`. This app asks a wallet for exactly one
 * thing — sign these bytes — and never builds, simulates or sends a
 * transaction from the browser: every fill is routed and signed server-side
 * from a custodial wallet. The adapter stack is four packages, a React context,
 * a modal and a CSS bundle to wrap a method that is already standard.
 *
 * THE PROVIDER IS DETECTED, NOT ASSUMED. Phantom, Solflare and Backpack all
 * expose the same `signMessage`; the wallet a person actually has is whichever
 * one injected itself.
 */

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
  }
}

export function getProvider(): SolanaProvider | null {
  if (typeof window === 'undefined') return null;
  return window.phantom?.solana ?? window.solana ?? window.solflare ?? window.backpack ?? null;
}

export function walletInstalled(): boolean {
  return getProvider() !== null;
}

export interface SignedChallenge {
  address: string;
  signature: string;
}

/**
 * Connects, then signs the EXACT text the server issued.
 *
 * `fetchMessage` is a callback rather than a string so the challenge is
 * requested AFTER the address is known and immediately before it is signed —
 * the message names the address, and a challenge fetched for one wallet and
 * signed by another is a signature the server will correctly reject.
 */
export async function connectAndSign(
  fetchMessage: (address: string) => Promise<string>
): Promise<SignedChallenge> {
  const provider = getProvider();
  if (!provider) {
    throw new Error('No Solana wallet is installed in this browser.');
  }

  const { publicKey } = await provider.connect();
  const address = publicKey.toString();

  const message = await fetchMessage(address);
  const { signature } = await provider.signMessage(new TextEncoder().encode(message), 'utf8');

  return { address, signature: bs58Encode(signature) };
}
