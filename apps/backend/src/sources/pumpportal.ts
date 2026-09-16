import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { errField, logger } from '../infra/logger.js';

/**
 * PumpPortal — the discovery firehose.
 *
 * TWO STREAMS, AND THEY ARE NOT THE SAME EVENT.
 *
 *   `newToken`   a mint was created. Tens of thousands a day, and the
 *                overwhelming majority never trade twice. Carried as a cheap
 *                SEEDED identity row and nothing more — no security read, no
 *                holder sync, no scoring — until it clears the activation
 *                thresholds in configuration.json. Skipping that distinction is
 *                precisely what makes an indexer fall over.
 *
 *   `migration`  a curve filled and the token graduated to a real pool. This is
 *                the interesting one: roughly 85 SOL of demand has already been
 *                proven, the liquidity is now a market rather than a curve, and
 *                every reading the grade depends on becomes available at once.
 *
 * THE SOCKET DYING IS NORMAL, not exceptional. It is reconnected with backoff
 * and the indexer keeps polling regardless — this stream makes discovery FAST,
 * it is not what makes it complete.
 */

const URL = 'wss://pumpportal.fun/api/data';
const log = logger.child({ source: 'pumpportal' });

export interface Discovered {
  mint: string;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  kind: 'new' | 'migration';
  poolAddress: string | null;
  /** Which launchpad minted it, from the stream's own `pool` field. */
  launchpad: string;
  /**
   * The Metaplex metadata URI, straight off the create event.
   *
   * FREE AND INSTANT. It is the same pointer the metadata account holds, so
   * taking it here means the picture can be fetched at the moment of discovery
   * rather than after an RPC round trip the metadata worker would otherwise
   * have to make. Null on a migration, which carries no metadata.
   */
  uri: string | null;
}

export class PumpPortal extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectMs = 2_000;
  private timer: NodeJS.Timeout | null = null;
  /** Deduped within a session: both streams re-announce on reconnect. */
  private seen = new Set<string>();
  private sweep: NodeJS.Timeout | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    // Bounded: the set is a dedup window, not a record of everything indexed —
    // that lives in Postgres.
    this.sweep = setInterval(() => this.seen.clear(), 20 * 60_000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweep) clearInterval(this.sweep);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(URL);
    this.ws = ws;

    ws.on('open', () => {
      log.info('connected');
      this.reconnectMs = 2_000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    });

    ws.on('message', (raw) => {
      try {
        this.handle(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // A malformed frame is one lost discovery, not a reason to drop the
        // socket that is delivering the other thousand.
      }
    });

    ws.on('close', () => this.reconnect());
    ws.on('error', (err) => {
      log.debug({ err: errField(err) }, 'socket error');
      // `close` always follows; reconnecting here too would double the attempts.
    });
  }

  private reconnect(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.reconnectMs);
    // Doubling, capped at a minute. A tight reconnect loop against a service
    // that is rate-limiting you is how an IP gets blocked for the day.
    this.reconnectMs = Math.min(60_000, this.reconnectMs * 2);
  }

  private handle(msg: Record<string, any>): void {
    // Subscription acknowledgements carry `message` and no mint.
    if (msg.message && !msg.mint) return;

    const mint = (msg.mint ?? msg.tokenMint ?? msg.address) as string | undefined;
    if (!mint) return;

    /*
     * ONLY `txType: "migrate"` IS A MIGRATION.
     *
     * The obvious test — "does it have a `pool` field" — is wrong, and wrong in
     * the most expensive direction: EVERY new-mint message carries one, naming
     * the launchpad it was created on (`pump`, `bonk`). Treating that as a
     * graduation promoted every brand-new mint straight to ACTIVE, which put
     * the whole firehose through the expensive pipeline and filled the screener
     * with seconds-old tokens showing a grade and no market at all — precisely
     * what the tier system exists to prevent.
     */
    const kind: Discovered['kind'] = msg.txType === 'migrate' ? 'migration' : 'new';

    const dedupKey = `${kind}:${mint}`;
    if (this.seen.has(dedupKey)) return;
    this.seen.add(dedupKey);

    this.emit('token', {
      mint,
      name: (msg.name as string) ?? null,
      symbol: (msg.symbol as string) ?? null,
      creator: (msg.traderPublicKey as string) ?? null,
      kind,
      // On a migration this names the market the token moved to; on a create it
      // names the launchpad, which is what `launchpad` below reads.
      poolAddress: kind === 'migration' ? ((msg.poolAddress as string) ?? null) : null,
      launchpad: launchpadOf(msg.pool as string | undefined),
      uri: typeof msg.uri === 'string' ? msg.uri : null,
    } satisfies Discovered);
  }
}

/**
 * The launchpad, from the stream's `pool`.
 *
 * It is a real safety fact rather than a label: these launchpads deploy a FIXED
 * mint configuration — no mint authority, no freeze authority, no transfer hook
 * — so a token provably out of one has had its entire contract surface decided
 * by code that can be read. `scoreSafety` credits it for exactly that reason.
 */
function launchpadOf(pool: string | undefined): string {
  switch (pool) {
    case 'pump':
    case 'pump-amm':
      return 'pumpfun';
    case 'bonk':
      return 'bonk';
    case 'raydium':
    case 'raydium-cpmm':
      return 'raydium';
    case 'launchlab':
      return 'launchlab';
    default:
      // Named rather than guessed. An unknown launchpad earns no safety bonus,
      // which is the correct outcome for a mint whose provenance we cannot
      // establish.
      return 'unknown';
  }
}
