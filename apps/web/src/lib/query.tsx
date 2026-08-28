'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from './api';

/**
 * React Query configuration.
 *
 * The retry policy is the part worth setting deliberately: retrying a 403 or a 404 is pure
 * noise — it will fail identically three more times — while retrying a 500 or a network blip
 * is genuinely useful. The default policy retries everything, which turns one permission error
 * into four log lines and a four-second spinner.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
                return false;
              }
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
