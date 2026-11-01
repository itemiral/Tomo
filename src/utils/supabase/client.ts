'use client';

import { useSession } from '@clerk/nextjs';
import { useEffect, useMemo, useRef } from 'react';
import { createAuthenticatedClient, type GetSessionToken } from './shared';

const tokenGetters=new WeakMap<ReturnType<typeof createAuthenticatedClient>,GetSessionToken>();
export function sessionTokenExpiration(token:string){try{const payload=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));return typeof payload.exp==='number'&&Number.isFinite(payload.exp)?payload.exp*1000:0;}catch{return 0;}}
export function createClient(getToken: GetSessionToken) {const client=createAuthenticatedClient(getToken);tokenGetters.set(client,getToken);return client;}
export function getClientSessionToken(client:ReturnType<typeof createAuthenticatedClient>){return tokenGetters.get(client)?.()??Promise.resolve(null);}

export function useSupabaseClient() {
  const { session } = useSession();
  const latestSession=useRef(session);latestSession.current=session;
  const sessionId=session?.id,userId=session?.user.id;
  const client = useMemo(
    () => {
      if(!sessionId||!userId)return null;
      let cached:string|null=null,inFlight:Promise<string|null>|null=null;
      const currentOwner=()=>latestSession.current?.id===sessionId&&latestSession.current.user.id===userId;
      return createClient(()=>{
        if(!currentOwner())return Promise.resolve(null);
        if(cached&&sessionTokenExpiration(cached)>Date.now()+35000)return Promise.resolve(cached);
        if(inFlight)return inFlight;
        inFlight=(async()=>{const token=await latestSession.current!.getToken({skipCache:true});if(!currentOwner())return null;if(token&&sessionTokenExpiration(token)<=Date.now()+25000)throw new Error('Session token expires too soon.');cached=token;return token;})();
        void inFlight.finally(()=>{inFlight=null;}).catch(()=>{});
        return inFlight;
      });
    },
    [sessionId,userId],
  );

  useEffect(() => () => {
    // Close the previous owner's subscriptions when the account changes.
    if (client) void client.removeAllChannels();
  }, [client]);

  return client;
}
