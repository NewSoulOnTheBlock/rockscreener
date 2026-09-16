import { Connection, PublicKey } from '@solana/web3.js';
import { env } from '../config/load.js';

/**
 * Two connections, on purpose.
 *
 * READ work — mint accounts, holder tables, ROCK balances — is bulk and will
 * happily consume a rate limit. SEND work is one request that must not be
 * queued behind four hundred of them, because a swap that goes out ten seconds
 * late on this chain is a swap at a different price. A deployment with one
 * endpoint points both at it and accepts the coupling; a deployment that cares
 * sets `SOLANA_TRADE_RPC_URL` to something staked.
 */
let readConn: Connection | null = null;
let tradeConn: Connection | null = null;

export function rpc(): Connection {
  readConn ??= new Connection(env.rpcUrl, {
    commitment: 'confirmed',
    // A read that hangs is worse than a read that fails: the worker behind it
    // stops, and the queue behind the worker grows.
    confirmTransactionInitialTimeout: 45_000,
  });
  return readConn;
}

export function tradeRpc(): Connection {
  tradeConn ??= new Connection(env.tradeRpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 45_000,
  });
  return tradeConn;
}

/** A mint, or null. Never throws on user input. */
export function toPublicKey(address: string): PublicKey | null {
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}

export { PublicKey };
