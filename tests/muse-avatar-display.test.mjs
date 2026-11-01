import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import sharp from 'sharp';

const directory = await mkdtemp(join(tmpdir(), 'muze-avatar-display-'));
const require = createRequire(import.meta.url);
const modules = {
  'server-only': '',
  '@clerk/nextjs/server': 'export const auth=async()=>({userId:globalThis.__avatarDisplay.owner});export const currentUser=async()=>({id:globalThis.__avatarDisplay.owner});',
  '@/utils/supabase/shared': 'export const createAuthenticatedClient=()=>{throw new Error("Unexpected cloud client");};',
  '@/utils/supabase/session': 'export const serverSessionToken=()=>{};',
  'next/server': 'export class NextResponse extends Response {}',
  'muse-storage.mjs': 'export class StorageError extends Error{};export const usesCloudStorage=()=>false;export const withMuseStorage=()=>{};export const withMuseProfileSnapshot=async run=>{globalThis.__avatarDisplay.snapshots++;return run();};',
  'muse-store.mjs': `export class MuseStoreError extends Error{};
    export const ensureMuse=async()=>({id:'fixture',name:'Muse'});
    export const readMuseIcon=async owner=>{globalThis.__avatarDisplay.readOwners.push(owner);return globalThis.__avatarDisplay.icon;};
    export const readMuseNote=()=>{};export const saveMuseIcon=()=>{};export const saveMuseNote=()=>{};export const validNoteKey=key=>key;`,
  'muse-avatar.mjs': `export const readAvatar=async owner=>{globalThis.__avatarDisplay.readOwners.push(owner);return globalThis.__avatarDisplay.avatar;};
    export const avatarSummary=()=>({});export const uploadAvatar=()=>{};export const activateAvatar=()=>{};export const replaceAvatar=()=>{};
    export const avatarOperation=async owner=>{globalThis.__avatarDisplay.readOwners.push(owner);return {status:'pending'};};`,
};
const compiled = await build({ entryPoints: ['src/app/api/muse/avatar/route.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'private-avatar-fixtures', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    const key = ['muse-storage.mjs', 'muse-store.mjs', 'muse-avatar.mjs'].find(name => args.path.endsWith('/' + name)) || args.path;
    if (Object.hasOwn(modules, key)) return { path: key, namespace: 'fixture' };
    if (args.path === 'sharp') return { path: require.resolve('sharp'), external: true };
  });
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'ts', resolveDir: resolve('.') }));
} }] });
await writeFile(join(directory, 'route.cjs'), compiled.outputFiles[0].text);
const { GET } = require(join(directory, 'route.cjs'));
after(async () => { delete globalThis.__avatarDisplay; await rm(directory, { recursive: true, force: true }); });

const colors = [[220, 40, 40], [40, 190, 40], [40, 40, 220], [220, 170, 40], [170, 40, 220], [40, 180, 200], [220, 100, 100], [100, 170, 100], [100, 100, 190]];
const tiles = await Promise.all(colors.map(async (color, index) => ({
  input: await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: color[0], g: color[1], b: color[2], alpha: 1 } } }).png().toBuffer(),
  left: index % 3 * 256 + 64, top: Math.floor(index / 3) * 256 + 64,
})));
const png = await sharp({ create: { width: 768, height: 768, channels: 4, background: '#00000000' } }).composite(tiles).png().toBuffer();
function fixture(avatar = { activeVersion: 'active', activeSheet: png.toString('base64'), preview: png.toString('base64') }, icon = null) {
  globalThis.__avatarDisplay = { owner: 'owner_fixture', avatar, icon, snapshots: 0, readOwners: [] };
}
function request(search = '', headers = {}) {
  const url = 'https://workspace.example/api/muse/avatar' + search;
  return { url, nextUrl: new URL(url), headers: new Headers({ host: 'workspace.example', ...headers }) };
}
function privateHeaders(response) {
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(response.headers.get('vary'), 'Cookie, Authorization');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('the default avatar endpoint retains the original PNG and owner-only response headers', async () => {
  fixture();
  const response = await GET(request('?sheet=true&v=active'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  privateHeaders(response);
  assert.equal(globalThis.__avatarDisplay.snapshots, 1);
  assert.deepEqual(globalThis.__avatarDisplay.readOwners, ['owner_fixture']);
});

test('portrait sheets keep all nine poses and transparency in a small 384px WebP', async () => {
  fixture();
  const response = await GET(request('?sheet=true&v=active&display=portrait'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  privateHeaders(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length <= 300_000);
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 384); assert.equal(info.height, 384);
  assert.equal(data[3], 0, 'transparent background is preserved');
  for (let index = 0; index < colors.length; index++) {
    const x = index % 3 * 128 + 64, y = Math.floor(index / 3) * 128 + 64;
    const pixel = data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4);
    assert.equal(pixel[3], 255);
    colors[index].forEach((color, channel) => assert.ok(Math.abs(pixel[channel] - color) < 16, 'pose ' + index + ' remains in its original cell'));
  }
});

test('legacy icons and avatar previews use 128px portrait images', async () => {
  for (const legacy of [false, true]) {
    fixture(legacy ? null : { preview: png.toString('base64') }, legacy ? { bytes: png, version: 'icon' } : null);
    const response = await GET(request('?display=portrait'));
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 128); assert.equal(metadata.height, 128); assert.equal(metadata.hasAlpha, true);
    assert.ok(bytes.length <= 300_000);
    privateHeaders(response);
  }
});

test('portrait requests reject anonymous and cross-origin readers before private storage', async () => {
  fixture(); globalThis.__avatarDisplay.owner = null;
  assert.equal((await GET(request('?display=portrait'))).status, 401);
  assert.equal(globalThis.__avatarDisplay.snapshots, 0);
  assert.deepEqual(globalThis.__avatarDisplay.readOwners, []);
  fixture();
  assert.equal((await GET(request('?display=portrait', { origin: 'https://other.example' }))).status, 403);
  assert.equal(globalThis.__avatarDisplay.snapshots, 0);
  assert.deepEqual(globalThis.__avatarDisplay.readOwners, []);
});

test('operation-status polling bypasses the image snapshot and portrait conversion', async () => {
  fixture();
  const response = await GET(request('?operation=pending&display=portrait'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'pending' });
  assert.equal(globalThis.__avatarDisplay.snapshots, 0);
  privateHeaders(response);
});
