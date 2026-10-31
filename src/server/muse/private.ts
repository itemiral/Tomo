import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { ensureMuse, MuseStoreError, readMuseIcon, readMuseNote, saveMuseIcon, saveMuseNote, validNoteKey } from '../../../scripts/muse-store.mjs';
import { PrivateError } from './error';
export { PrivateError } from './error';
export type NoteKey = 'soul' | 'memory';
type Profile = { ownerId: string };
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
export function privateJson(data: unknown, status = 200) { return NextResponse.json(data, { status, headers }); }
export function privateFailure(error: unknown) {
  const known = error instanceof PrivateError || error instanceof MuseStoreError;
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
  const user = await currentUser();
  if (!user || user.id !== profile.ownerId) throw new PrivateError(401, 'Sign in to open your Muse.');
  const identity = await ensureMuse(profile.ownerId), icon = await readMuseIcon(profile.ownerId);
  return { ownerId: profile.ownerId, ownerName: user.firstName || user.username || 'You', muse: { ...identity, iconVersion: icon?.version || null } };
}
export async function avatar(profile: Profile) {
  const icon = await readMuseIcon(profile.ownerId);
  if (!icon) throw new PrivateError(404, 'No icon has been added.');
  return new NextResponse(icon.bytes, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(icon.bytes.length) } });
}
export const noteKey = (value: string): NoteKey => validNoteKey(value) as NoteKey;
export const note = (profile: Profile, key: NoteKey) => readMuseNote(profile.ownerId, key);
export const updateNote = (profile: Profile, key: NoteKey, content: unknown, revision: unknown) => saveMuseNote(profile.ownerId, key, content, revision);
export const updateIcon = (profile: Profile, image: unknown) => saveMuseIcon(profile.ownerId, image);
