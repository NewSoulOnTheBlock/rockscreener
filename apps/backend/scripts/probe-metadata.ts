import { metadataAddress, readMetadata } from '../src/sources/token-metadata.js';
import { rpc } from '../src/clients/solana.js';

/**
 * A one-off probe for the metadata account, kept because it is how the empty
 * `uri` was diagnosed and it is the fastest way to check the layout again if
 * Metaplex ever changes it.
 *
 *   pnpm exec tsx --env-file=../../.env scripts/probe-metadata.ts <mint>
 */
async function main(): Promise<void> {
  const mint = process.argv[2];
  if (!mint) throw new Error('give a mint');

  const pda = metadataAddress(mint);
  console.log('PDA        ', pda?.toBase58());

  const account = await rpc().getAccountInfo(pda!, 'confirmed');
  console.log('account    ', account !== null, '| bytes:', account?.data.length, '| owner:', account?.owner.toBase58());

  if (account) {
    // The raw field widths, so a layout change shows up as obvious nonsense
    // rather than as an empty string.
    const d = account.data;
    console.log('name len   ', d.readUInt32LE(65));
    console.log('symbol len ', d.readUInt32LE(65 + 4 + 32));
    console.log('uri len    ', d.readUInt32LE(65 + 4 + 32 + 4 + 10));
  }

  console.log('parsed     ', JSON.stringify(await readMetadata(mint)));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
