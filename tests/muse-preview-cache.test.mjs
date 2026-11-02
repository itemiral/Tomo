import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MUSE_PREVIEW_KEY, MUSE_PREVIEW_MAX_AGE, setMusePreviewOwner, readMusePreview, saveMusePreview, clearMusePreview, loadMusePreviewImage, cachedMusePreviewImage, musePortraitSource } from '../src/components/muse/preview-cache.ts';

const stored = new Map(), events = [];
const originalWindow = globalThis.window, originalImage = globalThis.Image;
globalThis.window = { sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }, dispatchEvent: event => { events.push(event); return true; } };
globalThis.Image = class { set src(value) { this.value = value; queueMicrotask(() => this.onload?.()); } };
after(() => { setMusePreviewOwner(null); globalThis.window = originalWindow; globalThis.Image = originalImage; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW6UAAAAASUVORK5CYII=', 'base64');
const profile = (owner = 'owner-a', version = 'version-a') => ({ ownerId: owner, ownerName: 'Owner', muse: { id: 'muse-id', name: 'My Muse', iconVersion: version, gazeVersion: version } });
const reset = () => { setMusePreviewOwner(null); stored.clear(); events.length = 0; };

test('preview stores only the authenticated owner’s display fields and clears on account switch', () => {
  reset();
  const own = profile();
  saveMusePreview(own.ownerId, own);
  assert.equal(readMusePreview(own.ownerId), null, 'cache cannot restore before an authenticated owner is set');
  setMusePreviewOwner(own.ownerId);
  saveMusePreview(own.ownerId, { ...own, soul: 'Never cache my notes', muse: { ...own.muse, memory: 'Also private' } });
  assert.equal(readMusePreview(own.ownerId).muse.name, 'My Muse');
  assert.doesNotMatch(stored.get(MUSE_PREVIEW_KEY), /Never cache|Also private|soul|memory/);
  assert.equal(readMusePreview('owner-b'), null);
  setMusePreviewOwner('owner-b');
  assert.equal(readMusePreview('owner-b'), null);
  assert.equal(readMusePreview('owner-a'), null);
  assert.equal(stored.has(MUSE_PREVIEW_KEY), false);
});

test('matching portraits deduplicate, bind requests to the owner and restore across a reload without fetching', async () => {
  reset(); setMusePreviewOwner('owner-a'); saveMusePreview('owner-a', profile());
  const source = musePortraitSource(profile()); let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(url, source); assert.equal(options.headers['X-Muze-Owner'], 'owner-a'); return new Response(png, { headers: { 'Content-Type': 'image/png' } }); };
  const [first, second] = await Promise.all([loadMusePreviewImage('owner-a', source, fetcher), loadMusePreviewImage('owner-a', source, fetcher)]);
  assert.equal(calls, 1); assert.equal(first, second); assert.equal(cachedMusePreviewImage('owner-a', source), first);
  assert.match(JSON.parse(stored.get(MUSE_PREVIEW_KEY)).image, /^data:image\/png;base64,/);
  const reloaded = await import('../src/components/muse/preview-cache.ts?preview-reload');
  assert.equal(reloaded.readMusePreview('owner-a'), null);
  reloaded.setMusePreviewOwner('owner-a'); assert.equal(reloaded.readMusePreview('owner-a').muse.name, 'My Muse');
  await reloaded.loadMusePreviewImage('owner-a', source, async () => { throw new Error('A cached portrait must not fetch'); });
  reloaded.setMusePreviewOwner(null);
});

test('expired, oversized, malformed and wrong-version records are rejected', () => {
  for (const mutate of [
    value => { value.savedAt = Date.now() - MUSE_PREVIEW_MAX_AGE - 1; },
    value => { value.source = '/api/muse/avatar?v=other&display=portrait'; },
    value => { value.image = 'data:image/svg+xml;base64,PHN2Zz4='; },
    value => { value.image = 'data:image/png;base64,' + 'a'.repeat(410_000); },
  ]) {
    reset(); setMusePreviewOwner('owner-a'); saveMusePreview('owner-a', profile());
    const value = JSON.parse(stored.get(MUSE_PREVIEW_KEY)); mutate(value);
    clearMusePreview('owner-a'); setMusePreviewOwner(null); stored.set(MUSE_PREVIEW_KEY, JSON.stringify(value));
    setMusePreviewOwner('owner-a'); assert.equal(readMusePreview('owner-a'), null); assert.equal(stored.has(MUSE_PREVIEW_KEY), false);
  }
});

test('old requests cannot cache a previous owner’s pixels under a new owner', async () => {
  reset(); setMusePreviewOwner('owner-a'); saveMusePreview('owner-a', profile());
  let release; const wait = new Promise(resolve => { release = resolve; });
  const attempt = loadMusePreviewImage('owner-a', musePortraitSource(profile()), async () => { await wait; return new Response(png, { headers: { 'Content-Type': 'image/png' } }); });
  const rejection = assert.rejects(attempt, /another session/);
  setMusePreviewOwner('owner-b'); saveMusePreview('owner-b', profile('owner-b'));
  release(); await rejection;
  assert.equal(cachedMusePreviewImage('owner-b', musePortraitSource(profile())), null);
  assert.equal(JSON.parse(stored.get(MUSE_PREVIEW_KEY)).ownerId, 'owner-b');
  assert.equal(JSON.parse(stored.get(MUSE_PREVIEW_KEY)).image, undefined);
});

test('forbidden images clear cached display data and unsupported formats are never persisted', async () => {
  reset(); setMusePreviewOwner('owner-a'); saveMusePreview('owner-a', profile());
  await assert.rejects(loadMusePreviewImage('owner-a', musePortraitSource(profile()), async () => new Response('', { status: 403 })), { status: 403 });
  assert.equal(readMusePreview('owner-a'), null); assert.equal(stored.has(MUSE_PREVIEW_KEY), false);
  assert.equal(events[0].type, 'muse-preview-denied'); assert.equal(events[0].detail.ownerId, 'owner-a');
  saveMusePreview('owner-a', profile());
  await assert.rejects(loadMusePreviewImage('owner-a', musePortraitSource(profile()), async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })), /could not be read/);
  assert.equal(JSON.parse(stored.get(MUSE_PREVIEW_KEY)).image, undefined);
  await assert.rejects(loadMusePreviewImage('owner-a', musePortraitSource(profile()), async () => new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': '300001' } })), /could not be read/);
});

test('a newer version can warm while the existing cached profile remains visible', async () => {
  reset(); setMusePreviewOwner('owner-a'); saveMusePreview('owner-a', profile());
  const fetcher = async () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
  await loadMusePreviewImage('owner-a', musePortraitSource(profile()), fetcher);
  const next = profile('owner-a', 'version-b');
  await loadMusePreviewImage('owner-a', musePortraitSource(next), fetcher);
  assert.equal(readMusePreview('owner-a').muse.gazeVersion, 'version-a');
  saveMusePreview('owner-a', next);
  const saved = JSON.parse(stored.get(MUSE_PREVIEW_KEY));
  assert.equal(saved.profile.muse.gazeVersion, 'version-b'); assert.ok(saved.image);
});
