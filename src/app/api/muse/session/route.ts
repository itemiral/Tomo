import { type NextRequest } from 'next/server';
import { owner, privateFailure, privateJson, publicProfile } from '@/server/muse/private';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try { const { profile } = await owner(request); return privateJson(await publicProfile(profile)); }
  catch (error) { return privateFailure(error); }
}
