import { PublicKey, rpc } from '../clients/solana.js';
import { Spacer } from '../infra/interval.js';
import { errField, logger } from '../infra/logger.js';

/**
 * A TOKEN'S NAME, SYMBOL AND ARTWORK — read from the chain.
 *
 * WHY NOT JUST USE DEXSCREENER. Because it only knows about tokens that have a
 * PAIR, and most of the index at any moment does not: a mint discovered ninety
 * seconds ago has no market, so it has no DexScreener entry, so it had no name
 * and no picture — which is most of a screener row. Reading the metadata
 * account fixes that for every SPL token that exists, whether or not anybody
 * has ever traded it.
 *
 * WHY NOT AN INDEXING SERVICE. Helius's DAS API answers this in one call and
 * needs a key; the Metaplex metadata account is a deterministic PDA that any
 * RPC will serve for nothing. A paid dependency for a public account read is a
 * dependency that turns into a bill and an outage.
 *
 * TWO HOPS, AND THE SECOND ONE IS UNTRUSTED. The account holds a URI, usually
 * pointing at IPFS; the JSON behind it holds the image. That JSON is written by
 * whoever launched the token, so everything taken from it is treated as
 * arbitrary attacker-supplied content: lengths are capped, only http(s) and
 * ipfs URLs survive, and nothing from it is ever executed or trusted as a fact
 * about the token.
 */

const log = logger.child({ source: 'token-metadata' });
const spacer = new Spacer(60);

/** Metaplex Token Metadata. The account is a PDA under it. */
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface OnChainMetadata {
  name: string;
  symbol: string;
  /** Where the JSON lives. Empty when the token published none. */
  uri: string;
}

export function metadataAddress(mint: string): PublicKey | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
      METADATA_PROGRAM
    );
    return pda;
  } catch {
    return null;
  }
}

/**
 * Reads the metadata account.
 *
 * THE LAYOUT IS BORSH WITH FIXED-WIDTH PADDED STRINGS, and it is parsed by hand
 * for the same reason the bonding curve is: pulling in the Metaplex SDK to read
 * three strings at known offsets would add a large dependency, and a
 * version-coupling to a program we do not control, for two hundred bytes of
 * `readUInt32LE` and `subarray`.
 *
 *   1   key
 *   32  update authority
 *   32  mint
 *   4+32  name    (u32 length, then a 32-byte field)
 *   4+10  symbol
 *   4+200 uri
 *
 * The declared length is CLAMPED to the field width. It is written by the token
 * creator, and a length longer than the field is either a different program
 * version or somebody trying to read past the buffer.
 */
/**
 * MANY MINTS, ONE ROUND TRIP.
 *
 * This is the difference between the metadata pass being useful and being
 * theatre. The PDA is derived locally from the mint, so a hundred of them cost
 * a hundred lines of arithmetic and ONE `getMultipleAccountsInfo` — against one
 * request each, which at a polite request spacing meant eleven thousand tokens
 * took half an hour to name. The screener's newest rows are exactly the ones
 * nobody has named yet, so half an hour is the whole useful life of the row.
 *
 * A HUNDRED IS THE RPC'S CEILING on that method, not a guess.
 *
 * The result is keyed by MINT rather than returned as an array, because a
 * derivation can fail for a malformed address and a positional array would then
 * silently shift every subsequent token's metadata onto the wrong row.
 */
const MAX_ACCOUNTS_PER_CALL = 100;

export async function readMetadataBatch(
  mints: string[]
): Promise<Map<string, OnChainMetadata | null>> {
  const out = new Map<string, OnChainMetadata | null>();
  if (mints.length === 0) return out;

  const derived: { mint: string; address: PublicKey }[] = [];
  for (const mint of mints.slice(0, MAX_ACCOUNTS_PER_CALL)) {
    const address = metadataAddress(mint);
    // A mint whose PDA cannot be derived is not a mint. Recorded as read with
    // nothing found, so the worker does not return to it forever.
    if (!address) out.set(mint, null);
    else derived.push({ mint, address });
  }
  if (derived.length === 0) return out;

  try {
    await spacer.wait();
    const accounts = await rpc().getMultipleAccountsInfo(
      derived.map((d) => d.address),
      'confirmed'
    );

    derived.forEach((d, i) => {
      const account = accounts[i];
      // No account: the token has no Metaplex metadata at all, which is
      // unusual but legal. Nothing to read, and not an error.
      out.set(d.mint, account ? parseMetadata(account.data) : null);
    });
  } catch (err) {
    log.debug({ count: derived.length, err: errField(err) }, 'metadata batch read failed');
    // Nothing is recorded on a failure, so the caller leaves those rows
    // untouched and tries again rather than marking them unreadable.
  }
  return out;
}

/** One account, for the rare caller that has exactly one. */
export async function readMetadata(mint: string): Promise<OnChainMetadata | null> {
  return (await readMetadataBatch([mint])).get(mint) ?? null;
}

function parseMetadata(data: Buffer): OnChainMetadata | null {
  if (data.length < 1 + 32 + 32 + 4) return null;

  let offset = 1 + 32 + 32;
  const name = readPaddedString(data, offset, 32);
  offset += 4 + 32;
  const symbol = readPaddedString(data, offset, 10);
  offset += 4 + 10;
  const uri = readPaddedString(data, offset, 200);

  return { name, symbol, uri };
}

function readPaddedString(data: Buffer, offset: number, width: number): string {
  if (offset + 4 + width > data.length) return '';
  const declared = data.readUInt32LE(offset);
  const length = Math.min(declared, width);
  return data
    .subarray(offset + 4, offset + 4 + length)
    .toString('utf8')
    // Metaplex pads with NULs and the strings arrive with them attached; a
    // symbol rendered with trailing NULs breaks every layout it lands in.
    .replace(/\0/g, '')
    .trim();
}

/**
 * The image, from the JSON the URI points at.
 *
 * EVERYTHING HERE IS ARBITRARY ATTACKER-SUPPLIED CONTENT. The URI is chosen by
 * whoever launched the token and the JSON behind it is whatever they uploaded,
 * so: the request is bounded by a timeout and a response-size cap, only
 * http(s) and ipfs schemes are followed, and the returned image URL is
 * re-validated rather than trusted because it came back from a fetch we made.
 *
 * `data:` URLs are refused deliberately — a multi-megabyte base64 image in a
 * database column that sixty screener rows then carry is a denial of service
 * with a picture on it.
 */
export async function fetchImage(uri: string): Promise<string | null> {
  const url = normalizeUri(uri);
  if (!url) return null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;

    // Token metadata is a few hundred bytes. Anything a hundred times that is
    // not metadata, and it is not being read into memory to find out.
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > 64_000) return null;

    const body = (await res.json()) as Record<string, unknown>;
    const image = typeof body.image === 'string' ? body.image : null;
    return image ? normalizeUri(image) : null;
  } catch (err) {
    log.debug({ uri, err: errField(err) }, 'metadata json fetch failed');
    return null;
  }
}

/**
 * An IPFS pointer made fetchable, or null for anything not worth following.
 *
 * ONE GATEWAY, NAMED. Resolving `ipfs://` requires choosing a gateway, and the
 * choice is a real one: it is a third party that sees which token every reader
 * is looking at. This is stated rather than hidden behind a default, and the
 * URL it produces is fetched by the SERVER here — the browser only ever
 * receives an already-resolved https URL.
 */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export function normalizeUri(raw: string): string | null {
  const uri = raw.trim();
  if (uri === '' || uri.length > 2_000) return null;

  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAY + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  // `data:` is refused: see the note on `fetchImage`.
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}
