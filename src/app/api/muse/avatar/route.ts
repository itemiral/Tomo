import { type NextRequest, NextResponse } from 'next/server';
import { avatar, checkOrigin, jsonBody, owner, privateFailure, privateJson, updateIcon } from '@/server/muse/private';
import { readAvatar, uploadAvatar, generateAvatar, activateAvatar } from '../../../../../scripts/muse-avatar.mjs';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const { profile } = await owner(request), saved = await readAvatar(profile.ownerId);
    if (!saved) return await avatar(profile);
    const sheet = request.nextUrl.searchParams.get('sheet') === 'true';
    const bytes = sheet ? (request.nextUrl.searchParams.get('v') === saved.activeVersion ? saved.activeSheet : saved.candidate) : saved.preview;
    if (!bytes) return privateJson({ error: 'No generated preview yet.' }, 404);
    return new NextResponse(Buffer.from(bytes, 'base64'), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  } catch (error) { return privateFailure(error); }
}
export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request, true);
    const { profile } = await owner(request), body = await jsonBody(request, 14_000_000);
    if (body.action === 'activate') return privateJson(await activateAvatar(profile.ownerId, body.version));
    if (body.source) return privateJson(await uploadAvatar(profile.ownerId, body.source));
    return privateJson({ iconVersion: await updateIcon(profile, body.image) });
  } catch (error) { return privateFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request, true);
    const { profile } = await owner(request), body = await jsonBody(request, 4096);
    return privateJson(await generateAvatar(profile.ownerId, body, request.signal));
  } catch (error) { return privateFailure(error); }
}
