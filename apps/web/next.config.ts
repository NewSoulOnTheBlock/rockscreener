import type { NextConfig } from 'next';

const config: NextConfig = {
  /*
   * Standalone so the runtime image carries the server and the traced subset of
   * node_modules rather than the whole workspace — `apps/web/Dockerfile` copies
   * `.next/standalone` and runs its `server.js`, so this is load-bearing there.
   *
   * IT MUST BE OFF ON VERCEL. Vercel builds its own serverless output and
   * applies its own Next config on top; asking for standalone as well makes the
   * build look for a trace manifest that pipeline never writes, and it dies on
   * `ENOENT .next/next-server.js.nft.json`. The platform does not need it — the
   * whole point of standalone is producing a self-contained server to copy into
   * an image, which is exactly the job Vercel is doing instead.
   */
  output: process.env.VERCEL ? undefined : 'standalone',
  // Correct in both places: the workspace root is two levels up, and tracing
  // from anywhere below it would miss the shared package.
  outputFileTracingRoot: __dirname + '/../../',
  transpilePackages: ['@rockscreener/shared'],
  images: {
    // Token art comes from IPFS gateways and from whatever the launchpad
    // pointed at. None of it is trusted, so it is never optimised through our
    // own server — see `TokenAvatar` for the sandboxing this implies.
    unoptimized: true,
  },
};

export default config;
