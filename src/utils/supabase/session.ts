import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';
import { refreshingSessionToken } from '../../../scripts/muse-session.mjs';
import { SupabaseSessionError, type GetSessionToken } from './shared';

export function serverSessionToken(userId: string, sessionId: string | null, getToken: GetSessionToken) {
  return refreshingSessionToken({
    userId,
    sessionId,
    initialToken: getToken,
    async refreshToken() {
      if (!sessionId) throw new SupabaseSessionError();
      try {
        const client = await clerkClient();
        return (await client.sessions.getToken(sessionId)).jwt;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) throw new SupabaseSessionError();
        throw error;
      }
    },
  });
}
