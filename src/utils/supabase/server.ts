import 'server-only';

import { auth } from '@clerk/nextjs/server';
import { createAuthenticatedClient, SupabaseSessionError } from './shared';

// Each request uses the current Clerk session and Supabase's row permissions.
export async function createClient() {
  const { userId, getToken } = await auth();
  if (!userId) throw new SupabaseSessionError();
  return createAuthenticatedClient(() => getToken());
}
