import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureMuse, MuseStoreError, readMuseIcon, readMuseNote, saveMuseIcon, saveMuseNote, validNoteKey } from '../../../scripts/muse-store.mjs';
import { readAvatar, avatarSummary } from '../../../scripts/muse-avatar.mjs';
import { PrivateError } from './error';
import { createAuthenticatedClient } from '@/utils/supabase/shared';
import { serverSessionToken } from '@/utils/supabase/session';
import { StorageError, usesCloudStorage, withMuseStorage, withMuseProfileSnapshot } from '../../../scripts/muse-storage.mjs';
import { sharedMuseImage } from '@/server/boards/profile-data';
export { PrivateError } from './error';
export type NoteKey = 'soul' | 'memory';
type Profile = { ownerId: string };
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
export function privateJson(data: unknown, status = 200) { return NextResponse.json(data, { status, headers }); }
export function privateFailure(error: unknown) {
  const known = error instanceof PrivateError || error instanceof MuseStoreError || error instanceof StorageError;
  return privateJson({ error: known ? error.message : 'Could not open your Muse files. Try again.' }, known ? error.status : 500);
}

export function checkOrigin(request: NextRequest, mutation = false) {
  const host = request.headers.get('host'), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  const url = new URL(request.url);
  if (!host || /[\s\\/@]/.test(host)) throw new PrivateError(403, 'Open Muse from your workspace.');
  // Use the browser's actual Host; NextRequest normalizes loopback names.
  const expected = new URL(url.protocol + '//' + host).origin;
  if ((mutation && !origin) || (origin && origin !== expected) || (site && site !== 'same-origin' && site !== 'none')) throw new PrivateError(403, 'Open Muse from your workspace.');
  return expected;
}

export async function owner(request: NextRequest): Promise<{ profile: Profile }> {
  checkOrigin(request);
  const { userId } = await auth();
  if (!userId) throw new PrivateError(401, 'Sign in to open your Muse.');
  return { profile: { ownerId: userId } };
}

export async function withOwner<T>(request: NextRequest, operation: (profile: Profile) => Promise<T>): Promise<T> {
  checkOrigin(request);
  const { userId, sessionId, getToken } = await auth();
  if (!userId) throw new PrivateError(401, 'Sign in to open your Muse.');
  const profile = { ownerId: userId };
  if (!usesCloudStorage()) return operation(profile);
  const client = createAuthenticatedClient(serverSessionToken(userId, sessionId, () => getToken()));
  return withMuseStorage(userId, client, () => operation(profile));
}

export async function jsonBody(request: NextRequest, limit: number): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PrivateError(415, 'Send a JSON request.');
  if (Number(request.headers.get('content-length')) > limit) throw new PrivateError(413, 'That file is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new PrivateError(400, 'The request is empty.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new PrivateError(413, 'That file is too large.'); }
    chunks.push(value);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid object');
    return data;
  } catch { throw new PrivateError(400, 'The request could not be read.'); }
}

export async function publicProfile(profile: Profile) {
  // withOwner has already verified the session. This display profile does not
  // need an additional account lookup before the avatar can start loading.
  const stored = await withMuseProfileSnapshot(async () => {
    const identity = await ensureMuse(profile.ownerId);
    const [icon, appearance] = await Promise.all([readMuseIcon(profile.ownerId), readAvatar(profile.ownerId)]);
    return { ...identity, iconVersion: icon?.version || null, ...avatarSummary(appearance) };
  });
  return { ownerId: profile.ownerId, ownerName: 'You', muse: stored };
}
export async function avatarImage(bytes: Uint8Array | string, sheet = false, portrait = false) {
  const original = Buffer.from(bytes);
  const body = portrait ? Buffer.from((await sharedMuseImage({ bytes: original, sheet, version: null }))!, 'base64') : original;
  return new NextResponse(body, { headers: { ...headers, 'Content-Type': portrait ? 'image/webp' : 'image/png', 'Content-Length': String(body.length) } });
}
export async function avatar(profile: Profile, portrait = false) {
  const icon = await readMuseIcon(profile.ownerId);
  if (!icon) throw new PrivateError(404, 'No icon has been added.');
  return avatarImage(icon.bytes, false, portrait);
}
export const noteKey = (value: string): NoteKey => validNoteKey(value) as NoteKey;
export const note = (profile: Profile, key: NoteKey) => readMuseNote(profile.ownerId, key);
export const updateNote = (profile: Profile, key: NoteKey, content: unknown, revision: unknown) => saveMuseNote(profile.ownerId, key, content, revision);
export const updateIcon = (profile: Profile, image: unknown) => saveMuseIcon(profile.ownerId, image);
