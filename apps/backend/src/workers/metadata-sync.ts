import { prisma } from '../clients/prisma.js';
import { IntervalTask } from '../infra/interval.js';
import { errField, logger, type Logger } from '../infra/logger.js';
import { fetchCoin } from '../sources/pumpfun.js';
import { fetchImage, normalizeUri, readMetadataBatch } from '../sources/token-metadata.js';

/**
 * NAMES AND ARTWORK, for the tokens nothing else knows about.
 *
 * MOST OF THE INDEX HAS NO DEXSCREENER ENTRY at any given moment — a mint
 * discovered ninety seconds ago has no market — so without this the screener's
 * newest rows have no name, no symbol and no picture, which is most of what a
 * row is. The metadata account is a deterministic PDA that any RPC serves for
 * nothing, so this costs one account read per token, once.
 *
 * THREE PASSES BECAUSE THEY FAIL DIFFERENTLY. The account read is an RPC call
 * that either answers or does not; the image is an HTTP fetch of somebody
 * else's IPFS pin, which can be slow, gone, or enormous; the pump.fun pass is a
 * third party's web API with its own rate limit. Splitting them means a dead
 * pin cannot stop the name from landing.
 *
 * THE THIRD PASS EXISTS BECAUSE THE FIRST ONE CANNOT WORK FOR pump.fun, which
 * is most of this index. pump.fun creates no Metaplex metadata account — this
 * was checked against the chain, not assumed — so the on-chain pass honestly
 * records "read, nothing there" and the image pass never sees those rows,
 * because it keys off a URI that will never arrive. Without this, the screener
 * shows a blank circle for four tokens in five and there is nothing in the
 * database to explain it.
 *
 * IT NEVER OVERWRITES A NAME THAT IS ALREADY THERE. The launchpad's own name
 * for a token, and DexScreener's, are both fine; this fills gaps rather than
 * arbitrating between sources, because a sync that rewrote the column every
 * pass would flip a name back and forth between two spellings forever.
 */
export class MetadataSync {
  private readonly accountTask: IntervalTask;
  private readonly imageTask: IntervalTask;
  private readonly pumpTask: IntervalTask;
  private readonly log: Logger;

  constructor(log: Logger = logger) {
    this.log = log.child({ module: 'metadata-sync' });
    this.accountTask = new IntervalTask('metadata-account', 2_000, () => this.readAccounts(), this.log);
    this.imageTask = new IntervalTask('metadata-image', 3_000, () => this.readImages(), this.log);
    this.pumpTask = new IntervalTask('metadata-pumpfun', 2_000, () => this.readPumpfun(), this.log);
  }

  start(): void {
    this.accountTask.start(true);
    this.imageTask.start(false);
    this.pumpTask.start(false);
  }

  stop(): void {
    this.accountTask.stop();
    this.imageTask.stop();
    this.pumpTask.stop();
  }

  /** The on-chain half: name, symbol and the URI, from the metadata PDA. */
  private async readAccounts(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { metadataReadAt: null },
      // Newest first: a row somebody is looking at right now matters more than
      // one that scrolled past an hour ago.
      orderBy: { firstSeenAt: 'desc' },
      select: { mint: true, name: true, symbol: true },
      /*
       * A HUNDRED PER PASS, which is one RPC request — the ceiling for
       * `getMultipleAccounts`. At twelve, naming eleven thousand tokens took
       * half an hour, and a screener's newest rows are exactly the ones nobody
       * has named yet: half an hour is the entire useful life of such a row.
       */
      take: 100,
    });

    const batch = await readMetadataBatch(tokens.map((t) => t.mint));

    for (const token of tokens) {
      try {
        // Absent from the map means the batch itself failed. The row is left
        // untouched so it is retried rather than marked unreadable.
        if (!batch.has(token.mint)) continue;
        const meta = batch.get(token.mint) ?? null;

        /*
         * STAMPED EVEN WHEN NOTHING WAS FOUND. A mint with no metadata account
         * is legal, and without the timestamp the worker would re-read the same
         * unreadable mints forever and never reach the ones behind them.
         */
        await prisma.token.update({
          where: { mint: token.mint },
          data: {
            metadataReadAt: new Date(),
            ...(meta?.uri ? { metadataUri: normalizeUri(meta.uri) } : {}),
            // Gaps only — see the note at the top.
            ...(meta?.name && !token.name ? { name: meta.name } : {}),
            ...(meta?.symbol && !token.symbol ? { symbol: meta.symbol, nameState: 'named' } : {}),
            ...(meta && !meta.symbol && !token.symbol ? { nameState: 'unreadable' } : {}),
          },
        });
      } catch (err) {
        this.log.debug({ mint: token.mint, err: errField(err) }, 'metadata account read failed');
      }
    }
  }

  /** The off-chain half: the picture the URI points at. */
  private async readImages(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: { imageUrl: null, metadataUri: { not: null } },
      orderBy: { firstSeenAt: 'desc' },
      select: { mint: true, metadataUri: true },
      /*
       * Smaller than the account pass and deliberately so: each of these is a
       * separate HTTP fetch of somebody else's IPFS pin, which can be slow or
       * dead. They run CONCURRENTLY, so the pass costs about one slow pin
       * rather than the same number in series.
       */
      take: 40,
    });

    await Promise.all(tokens.map((token) => this.readImage(token.mint, token.metadataUri!)));
  }

  private async readImage(mint: string, uri: string): Promise<void> {
    {
      try {
        const image = await fetchImage(uri);
        /*
         * A DEAD PIN CLEARS THE URI rather than being retried forever. IPFS
         * content that nobody is pinning is gone, and a worker that keeps
         * asking is one that never gets to the tokens whose art is actually
         * there. The name and symbol from the same metadata are already saved.
         */
        await prisma.token.update({
          where: { mint },
          data: image ? { imageUrl: image } : { metadataUri: null },
        });
      } catch (err) {
        this.log.debug({ mint, err: errField(err) }, 'image fetch failed');
      }
    }
  }

  /**
   * The pump.fun half: everything the chain does not hold.
   *
   * ORDERED BY LAST TRADE, NULLS LAST — not by tier. With a nine-thousand-row
   * backlog and one HTTP call per row, the order of this queue decides whether
   * the backfill is useful in an hour or in a day, and the rows worth doing
   * first are the ones somebody is looking at: a token that traded a minute ago
   * is on somebody's screen, and a mint that has never traded at all may never
   * be. Sorting on `tier` would have worked by alphabetical accident — ACTIVE
   * happens to precede SEEDED — which is not a thing to build a queue on.
   *
   * IT NEVER OVERWRITES. Same rule as the on-chain pass: this fills gaps. A
   * token that already has a name from DexScreener keeps it, because two
   * sources disagreeing about capitalisation should not make the column flicker
   * between them forever.
   */
  private async readPumpfun(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: {
        launchpad: 'pumpfun',
        imageUrl: null,
        pumpReadAt: null,
      },
      orderBy: [{ lastActivityAt: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'desc' }],
      select: { mint: true, name: true, symbol: true, description: true, creator: true },
      /*
       * It runs CONCURRENTLY inside the pass — but the `Spacer` in the source
       * serialises the actual requests, so this number buys PIPELINING, NOT A
       * BURST: sixty in flight against a 110ms floor still means one request
       * every 110ms, and the pass simply cannot finish in under 6.6s. The
       * limiter stays in charge of the rate; this only decides how much of each
       * pass is spent waiting on the slowest response rather than on the floor.
       */
      take: 60,
    });

    await Promise.all(tokens.map((t) => this.readCoin(t)));
  }

  private async readCoin(token: {
    mint: string;
    name: string;
    symbol: string;
    description: string | null;
    creator: string | null;
  }): Promise<void> {
    try {
      const { coin, definitive } = await fetchCoin(token.mint);
      /*
       * A TIMEOUT LEAVES THE ROW ALONE. Only a definitive answer — the coin, or
       * a 404 saying it is not a pump.fun mint — earns the stamp, so a bad
       * minute on their side costs a retry rather than a permanently blank
       * picture.
       */
      if (!definitive) return;

      await prisma.token.update({
        where: { mint: token.mint },
        data: {
          pumpReadAt: new Date(),
          ...(coin?.imageUrl ? { imageUrl: coin.imageUrl } : {}),
          ...(coin?.metadataUri ? { metadataUri: coin.metadataUri } : {}),
          // Gaps only — see the note above.
          ...(coin?.name && !token.name ? { name: coin.name } : {}),
          ...(coin?.symbol && !token.symbol ? { symbol: coin.symbol, nameState: 'named' } : {}),
          ...(coin?.description && !token.description ? { description: coin.description } : {}),
          ...(coin?.creator && !token.creator ? { creator: coin.creator } : {}),
          /*
           * SOCIALS ARE GAP-FILLED TOO, and they are not cosmetic: `hasSocials`
           * is read by the screener and a token whose links exist but were
           * never fetched reads as a token with no links at all.
           */
          ...(coin?.websiteUrl ? { websiteUrl: coin.websiteUrl } : {}),
          ...(coin?.twitterUrl ? { twitterUrl: coin.twitterUrl } : {}),
          ...(coin?.telegramUrl ? { telegramUrl: coin.telegramUrl } : {}),
        },
      });
    } catch (err) {
      this.log.debug({ mint: token.mint, err: errField(err) }, 'pump.fun metadata read failed');
    }
  }
}
