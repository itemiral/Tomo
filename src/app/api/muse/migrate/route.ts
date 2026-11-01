import { type NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { checkOrigin, privateFailure, privateJson, PrivateError } from '@/server/muse/private';
import { createAuthenticatedClient } from '@/utils/supabase/shared';
import { migrateLocalMuse } from '../../../../../scripts/muse-storage.mjs';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try {
    if (process.env.VERCEL || process.env.NODE_ENV !== 'development') throw new PrivateError(404, 'Not found.');
    const origin = new URL(checkOrigin(request, true));
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new PrivateError(403, 'Open the local workspace to migrate your Muse.');
    const { userId, getToken } = await auth();
    if (!userId) throw new PrivateError(401, 'Sign in to open your Muse.');
    const result = await migrateLocalMuse(userId, createAuthenticatedClient(() => getToken()));
    return privateJson(result);
  } catch (error) { return privateFailure(error); }
}
