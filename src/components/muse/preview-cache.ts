import type { MuseProfile } from './shared';

export const MUSE_PREVIEW_KEY = 'muze:muse-preview:v1';
export const MUSE_PREVIEW_MAX_AGE = 6 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 300_000;
const MAX_RECORD_CHARS = 410_000;
type Preview = { version: 1; ownerId: string; savedAt: number; profile: MuseProfile; source: string; image?: string };
type ReadyImage = { image: HTMLImageElement; data: string };
let activeOwner: string | null = null, generation = 0;
let current: Preview | null = null;
const ready = new Map<string, ReadyImage>();
const pending = new Map<string, { promise: Promise<HTMLImageElement>; abort: AbortController }>();
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const version = (value: unknown) => value === null || value === undefined || identifier(value);

function profileFor(ownerId: string, value: unknown): MuseProfile | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as MuseProfile;
  if (candidate.ownerId !== ownerId || !candidate.muse || !identifier(candidate.muse.id)
    || !text(candidate.ownerName, 160) || !text(candidate.muse.name, 160)
    || !version(candidate.muse.iconVersion) || !version(candidate.muse.gazeVersion) || !version(candidate.muse.candidateVersion)) return null;
  // Deliberately project display metadata. Future session fields must not turn
  // this small browser preview into a cache of private notes or conversations.
  return { ownerId, ownerName: candidate.ownerName, muse: { id: candidate.muse.id, name: candidate.muse.name, iconVersion: candidate.muse.iconVersion || null, gazeVersion: candidate.muse.gazeVersion || null, candidateVersion: candidate.muse.candidateVersion || null } };
}

export function musePortraitSource(profile: MuseProfile) {
  const { iconVersion, gazeVersion } = profile.muse;
  return iconVersion ? '/api/muse/avatar?' + (gazeVersion ? 'sheet=true&v=' + gazeVersion : 'v=' + iconVersion) + '&display=portrait' : '/muse/default-gaze-15.png?v=hybrid-15';
}

function privateSource(source: string) {
  return /^\/api\/muse\/avatar\?(?:sheet=true&)?v=[A-Za-z0-9_-]{1,128}&display=portrait$/.test(source);
}

function validImage(data: unknown): data is string {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 30) return false;
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[2].length % 4) return false;
  try {
    const head = atob(match[2].slice(0, 32));
    return match[1] === 'png' ? head.startsWith('\x89PNG\r\n\x1a\n') : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  } catch { return false; }
}

function storage() {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

function removeStored() { try { storage()?.removeItem(MUSE_PREVIEW_KEY); } catch { /* Storage may be unavailable. */ } }
function persist() {
  if (!current || current.ownerId !== activeOwner) return;
  try { const value = JSON.stringify(current); if (value.length <= MAX_RECORD_CHARS) storage()?.setItem(MUSE_PREVIEW_KEY, value); } catch { /* Memory-only previews still work. */ }
}

function readStored(ownerId: string): Preview | null {
  try {
    const raw = storage()?.getItem(MUSE_PREVIEW_KEY);
    if (!raw) return null;
    if (raw.length > MAX_RECORD_CHARS) { removeStored(); return null; }
    const value = JSON.parse(raw) as Preview;
    const profile = profileFor(ownerId, value.profile);
    if (value.version !== 1 || value.ownerId !== ownerId || !profile || !Number.isFinite(value.savedAt)
      || value.savedAt > Date.now() || Date.now() - value.savedAt > MUSE_PREVIEW_MAX_AGE
      || value.source !== musePortraitSource(profile) || (value.image !== undefined && !validImage(value.image))) {
      removeStored(); return null;
    }
    return { version: 1, ownerId, savedAt: value.savedAt, profile, source: value.source, ...(value.image ? { image: value.image } : {}) };
  } catch { removeStored(); return null; }
}

/** Call only after authentication identifies the owner, or confirms sign-out. */
export function setMusePreviewOwner(ownerId: string | null) {
  const next = ownerId && identifier(ownerId) ? ownerId : null;
  if (next === activeOwner) { if (!next) removeStored(); return; }
  generation++;
  for (const item of pending.values()) item.abort.abort();
  pending.clear(); ready.clear(); current = null;
  activeOwner = next;
  if (next) current = readStored(next);
  else removeStored();
}

export function clearMusePreview(ownerId: string) {
  if (activeOwner !== ownerId) return;
  generation++;
  for (const item of pending.values()) item.abort.abort();
  pending.clear(); ready.clear(); current = null; removeStored();
}

export function readMusePreview(ownerId: string): MuseProfile | null {
  if (activeOwner !== ownerId) return null;
  if (current && Date.now() - current.savedAt > MUSE_PREVIEW_MAX_AGE) { clearMusePreview(ownerId); return null; }
  return current ? profileFor(ownerId, current.profile) : null;
}

export const musePreviewOwnerMatches = (ownerId: string) => activeOwner === ownerId;

export function saveMusePreview(ownerId: string, value: MuseProfile) {
  if (activeOwner !== ownerId) return;
  const profile = profileFor(ownerId, value);
  if (!profile) return;
  const source = musePortraitSource(profile);
  const image = ready.get(source)?.data || (current?.source === source ? current.image : undefined);
  current = { version: 1, ownerId, profile, source, savedAt: Date.now(), ...(image ? { image } : {}) };
  persist();
}

export function cachedMusePreviewImage(ownerId: string, source: string) {
  return activeOwner === ownerId ? ready.get(source)?.image || null : null;
}

export class MusePreviewError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

async function imageData(response: Response) {
  if (!response.ok) throw new MusePreviewError('Could not load your Muse avatar.', response.status);
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/webp'].includes(mime || '') || Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) throw new MusePreviewError('That avatar could not be read.');
  const reader = response.body?.getReader();
  if (!reader) throw new MusePreviewError('That avatar could not be read.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new MusePreviewError('That avatar is too large.'); }
    chunks.push(value);
  }
  let binary = '';
  for (const bytes of chunks) for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  const data = `data:${mime};base64,${btoa(binary)}`;
  if (!validImage(data)) throw new MusePreviewError('That avatar could not be read.');
  return data;
}

function decodeImage(data: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new MusePreviewError('That avatar could not be read.'));
    image.src = data;
  });
}

export function loadMusePreviewImage(ownerId: string, source: string, fetcher: typeof fetch = fetch): Promise<HTMLImageElement> {
  if (activeOwner !== ownerId || !privateSource(source)) return Promise.reject(new MusePreviewError('This avatar belongs to another session.'));
  const image = cachedMusePreviewImage(ownerId, source);
  if (image) return Promise.resolve(image);
  const underway = pending.get(source);
  if (underway) return underway.promise;
  const epoch = generation, abort = new AbortController();
  const active = () => activeOwner === ownerId && epoch === generation && !abort.signal.aborted;
  const task = (async () => {
    try {
      const data = current?.source === source && current.image ? current.image : await imageData(await fetcher(source, { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Muze-Owner': ownerId }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) }));
      if (!active()) throw new MusePreviewError('This avatar belongs to another session.');
      const image = await decodeImage(data);
      if (!active()) throw new MusePreviewError('This avatar belongs to another session.');
      ready.set(source, { image, data });
      while (ready.size > 2) ready.delete(ready.keys().next().value!);
      if (current?.source === source) { current.image = data; persist(); }
      return image;
    } catch (error) {
      if (active() && error instanceof MusePreviewError && [401, 403].includes(error.status)) {
        clearMusePreview(ownerId);
        window.dispatchEvent(new CustomEvent('muse-preview-denied', { detail: { ownerId } }));
      } else if (active() && current?.source === source) { delete current.image; persist(); }
      throw error;
    } finally {
      if (pending.get(source)?.abort === abort) pending.delete(source);
    }
  })();
  pending.set(source, { promise: task, abort });
  return task;
}
