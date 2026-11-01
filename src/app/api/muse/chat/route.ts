import { type NextRequest } from 'next/server';
import { checkOrigin, jsonBody, withOwner, privateFailure, privateJson } from '@/server/muse/private';
import { askMuse } from '@/server/muse/model';
import { readMuseChat, validThread } from '../../../../../scripts/muse-store.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    return await withOwner(request, async profile => {
      const thread = validThread(request.nextUrl.searchParams.get('thread'));
      return privateJson({ messages: await readMuseChat(profile.ownerId, thread) });
    });
  } catch (error) { return privateFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request, true);
    return await withOwner(request, async profile => {
      const body = await jsonBody(request, 100_000);
      return privateJson(await askMuse(profile.ownerId, body, request.signal));
    });
  } catch (error) { return privateFailure(error); }
}
