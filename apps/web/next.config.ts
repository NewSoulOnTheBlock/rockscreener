import type { NextConfig } from 'next';

const config: NextConfig = {
  // Standalone so the runtime image carries the server and the traced subset of
  // node_modules rather than the whole workspace.
  output: 'standalone',
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
