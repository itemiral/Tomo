import { type NextRequest } from 'next/server';
import { withOwner, privateFailure, privateJson, publicProfile } from '@/server/muse/private';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try { return await withOwner(request, async profile => privateJson(await publicProfile(profile))); }
  catch (error) { return privateFailure(error); }
}
