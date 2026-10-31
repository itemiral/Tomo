import { type NextRequest } from 'next/server';
import { checkOrigin, jsonBody, note, noteKey, owner, privateFailure, privateJson, updateNote } from '@/server/muse/private';

export const runtime = 'nodejs';
type Context = { params: Promise<{ note: string }> };
export async function GET(request: NextRequest, context: Context) {
  try { const { profile } = await owner(request); return privateJson(await note(profile, noteKey((await context.params).note))); }
  catch (error) { return privateFailure(error); }
}
export async function PUT(request: NextRequest, context: Context) {
  try {
    checkOrigin(request, true);
    const { profile } = await owner(request), key = noteKey((await context.params).note), body = await jsonBody(request, 3_100_000);
    return privateJson(await updateNote(profile, key, body.content, body.revision));
  } catch (error) { return privateFailure(error); }
}
