import { type NextRequest } from 'next/server';
import { avatar, checkOrigin, jsonBody, owner, privateFailure, privateJson, updateIcon } from '@/server/muse/private';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try { return await avatar((await owner(request)).profile); } catch (error) { return privateFailure(error); }
}
export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request, true);
    const { profile } = await owner(request), body = await jsonBody(request, 1_500_000);
    return privateJson({ iconVersion: await updateIcon(profile, body.image) });
  } catch (error) { return privateFailure(error); }
}
