'use client';

import { useSession } from '@clerk/nextjs';
import { useEffect, useMemo } from 'react';
import { createAuthenticatedClient, type GetSessionToken } from './shared';

export function createClient(getToken: GetSessionToken) {
  return createAuthenticatedClient(getToken);
}

export function useSupabaseClient() {
  const { session } = useSession();
  const client = useMemo(
    () => session ? createClient(() => session.getToken()) : null,
    [session],
  );

  useEffect(() => () => {
    // Close the previous owner's subscriptions when the account changes.
    if (client) void client.removeAllChannels();
  }, [client]);

  return client;
}
