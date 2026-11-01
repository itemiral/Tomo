'use client';

import { useSession } from '@clerk/nextjs';
import { useEffect, useMemo, useRef } from 'react';
import { createAuthenticatedClient, type GetSessionToken } from './shared';

export function createClient(getToken: GetSessionToken) {
  return createAuthenticatedClient(getToken);
}

export function useSupabaseClient() {
  const { session } = useSession();
  const latestSession=useRef(session);latestSession.current=session;
  const sessionId=session?.id,userId=session?.user.id;
  const client = useMemo(
    () => sessionId&&userId ? createClient(async () => {
      const current=latestSession.current;
      if(current?.id!==sessionId||current.user.id!==userId)return null;
      const token=await current.getToken();
      return latestSession.current?.id===sessionId&&latestSession.current.user.id===userId?token:null;
    }) : null,
    [sessionId,userId],
  );

  useEffect(() => () => {
    // Close the previous owner's subscriptions when the account changes.
    if (client) void client.removeAllChannels();
  }, [client]);

  return client;
}
