'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * One client for the whole app, created once.
 *
 * `useState` rather than a module constant: a module-level client is shared
 * across requests on the server, which in a streamed render leaks one reader's
 * data into another's. The delay is deliberate too — a tooltip that fires
 * instantly on a dense feed row turns a scroll into a flicker of popovers.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 4_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={250} skipDelayDuration={400}>
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
