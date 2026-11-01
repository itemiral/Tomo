import { type NextRequest, NextResponse } from 'next/server';
import { avatar, checkOrigin, jsonBody, withOwner, privateFailure, privateJson, updateIcon } from '@/server/muse/private';
import { readAvatar, uploadAvatar, activateAvatar, replaceAvatar, avatarOperation } from '../../../../../scripts/muse-avatar.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    return await withOwner(request, async profile => {
    const operation=request.nextUrl.searchParams.get('operation');if(operation)return privateJson(await avatarOperation(profile.ownerId,operation));
    const saved = await readAvatar(profile.ownerId);
    if (!saved) return await avatar(profile);
    const sheet = request.nextUrl.searchParams.get('sheet') === 'true';
    const bytes = sheet ? (request.nextUrl.searchParams.get('v') === saved.activeVersion ? saved.activeSheet : saved.candidate) : saved.preview;
    if (!bytes) return privateJson({ error: 'No generated preview yet.' }, 404);
    return new NextResponse(Buffer.from(bytes, 'base64'), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } });
    });
  } catch (error) { return privateFailure(error); }
}
export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request, true);
    return await withOwner(request, async profile => {
    const body = await jsonBody(request, 4_000_000);
    if (body.action === 'activate') return privateJson(await activateAvatar(profile.ownerId, body.version));
    if (body.source) return privateJson(await uploadAvatar(profile.ownerId, body.source));
    return privateJson({ iconVersion: await updateIcon(profile, body.image) });
    });
  } catch (error) { return privateFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request, true);
    return await withOwner(request, async profile => {
    const body = await jsonBody(request, 4_000_000);
    if(body.action==='replace')return privateJson(await replaceAvatar(profile.ownerId,body,request.signal));
    return privateJson({error:'Choose Replace image to generate and apply an avatar.'},400);
    });
  } catch (error) { return privateFailure(error); }
}
