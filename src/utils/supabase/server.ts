import 'server-only';

import { auth } from '@clerk/nextjs/server';
import { createAuthenticatedClient, SupabaseSessionError } from './shared';
import { serverSessionToken } from './session';

// Each request uses the current Clerk session and Supabase's row permissions.
export async function createClient() {
  const { userId, sessionId, getToken } = await auth();
  if (!userId) throw new SupabaseSessionError();
  return createAuthenticatedClient(serverSessionToken(userId, sessionId, () => getToken()));
}
