import { type NextRequest } from 'next/server';
import { avatar, avatarImage, checkOrigin, jsonBody, withOwner, privateFailure, privateJson, updateIcon } from '@/server/muse/private';
import { readAvatar, uploadAvatar, activateAvatar, replaceAvatar, avatarOperation } from '../../../../../scripts/muse-avatar.mjs';
import { withMuseProfileSnapshot } from '../../../../../scripts/muse-storage.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    return await withOwner(request, async profile => {
      const expectedOwner = request.headers.get('x-muze-owner');
      if (expectedOwner && expectedOwner !== profile.ownerId) return privateJson({ error: 'Your Muse account changed. Reload to continue.' }, 403);
      const operation = request.nextUrl.searchParams.get('operation');
      if (operation) return privateJson(await avatarOperation(profile.ownerId, operation));
      return withMuseProfileSnapshot(async () => {
        const saved = await readAvatar(profile.ownerId);
        const portrait = request.nextUrl.searchParams.get('display') === 'portrait';
        if (!saved) return await avatar(profile, portrait);
        const sheet = request.nextUrl.searchParams.get('sheet') === 'true';
        const bytes = sheet ? (request.nextUrl.searchParams.get('v') === saved.activeVersion ? saved.activeSheet : saved.candidate) : saved.preview;
        if (!bytes) return privateJson({ error: 'No generated preview yet.' }, 404);
        return await avatarImage(Buffer.from(bytes, 'base64'), sheet, portrait);
      });
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
