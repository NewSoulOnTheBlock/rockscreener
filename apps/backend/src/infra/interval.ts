import { errField, type Logger } from './logger.js';

/**
 * A repeating task that CANNOT OVERLAP ITSELF.
 *
 * `setInterval` is the wrong primitive for every loop in this codebase: when a
 * pass takes longer than the interval — and an RPC pass eventually will — it
 * starts another one on top, and two entry ticks running concurrently will
 * happily open the same position twice against the same budget. This schedules
 * the NEXT run only once the current one has finished.
 *
 * A THROW NEVER STOPS THE LOOP. It is logged and the next tick is scheduled, so
 * one bad token, one timeout or one malformed response cannot take an engine
 * offline while it holds open positions.
 */
export class IntervalTask {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly run: () => Promise<void>,
    private readonly log: Logger
  ) {}

  start(immediate = true): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info({ task: this.name, intervalMs: this.intervalMs }, 'task started');
    if (immediate) void this.tick();
    else this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const started = Date.now();
    try {
      await this.run();
    } catch (err) {
      this.log.error({ task: this.name, err: errField(err) }, 'task failed');
    } finally {
      this.running = false;
      const took = Date.now() - started;
      // A pass that outruns its own interval is not an error, but it is the
      // thing that turns a 6s loop into a 40s one without anybody noticing.
      if (took > this.intervalMs * 3) {
        this.log.warn({ task: this.name, took }, 'task is running far behind its interval');
      }
      this.schedule();
    }
  }
}

/**
 * A rate limiter that is one number and a promise.
 *
 * Every external source here publishes a request ceiling and answers 429 past
 * it, and a 429 costs more than the wait would have. This spaces calls out at
 * the source rather than retrying into the wall.
 */
export class Spacer {
  private last = 0;
  private backoffUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  /** Serialises callers, so two concurrent workers cannot both slip through. */
  async wait(): Promise<void> {
    const mine = this.chain.then(async () => {
      const now = Date.now();
      const until = Math.max(this.last + this.minIntervalMs, this.backoffUntil);
      if (until > now) await sleep(until - now);
      this.last = Date.now();
    });
    this.chain = mine.catch(() => undefined);
    return mine;
  }

  /** Exponential, capped. Called on a 429 rather than on any failure. */
  backoff(): void {
    const now = Date.now();
    const current = Math.max(0, this.backoffUntil - now);
    this.backoffUntil = now + Math.min(60_000, Math.max(5_000, current * 2));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
