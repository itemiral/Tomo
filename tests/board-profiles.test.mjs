import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { participantData, selectedMuseAppearance, sharedMuseImage, clerkAvatarUrl } from '../src/server/boards/profile-data.ts';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
`);
const migrations = new URL('../supabase/migrations/', import.meta.url);
for (const suffix of ['_private_muse_storage.sql', '_shared_board_invitations.sql', '_board_conflict_responses.sql', '_shared_board_profiles.sql']) {
  const file = (await readdir(migrations)).find(file => file.endsWith(suffix)); assert.ok(file);
  await db.exec(await readFile(new URL(file, migrations), 'utf8'));
}

function asUser(id, run, role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role })]);
    return run(tx);
  });
}
async function board(owner, guest) {
  const scene = { id: randomUUID(), name: 'Profile sharing', activePage: 'page', pages: [{ id: 'page', name: 'Page 1', objects: [], viewport: [1, 0, 0, 1, 0, 0] }] };
  const created = await asUser(owner, tx => tx.query("select public.write_shared_board('create',null,$1) as snapshot", [JSON.stringify(scene)]));
  const id = created.rows[0].snapshot.board.id;
  if (guest) {
    const token = randomBytes(32).toString('base64url');
    await asUser(owner, tx => tx.query("select public.write_shared_board('invite',$1,null,null,$2)", [id, token]));
    await asUser(guest, tx => tx.query("select public.write_shared_board('join',$1,null,null,$2)", [id, token]));
  }
  return id;
}
const insert = (actor, id, user = actor, role) => asUser(actor, tx => tx.query(
  "insert into public.shared_board_profiles(board_id,user_id,name,avatar_url,muse_name,muse_avatar,muse_avatar_version,muse_sheet,muse_poses) values($1,$2,$3,$4,$5,null,null,false,9) returning user_id",
  [id, user, user + ' public name', 'https://img.clerk.com/fixture.png', 'Kumo'],
), role);
const read = (actor, id, role) => asUser(actor, tx => tx.query('select * from public.shared_board_profiles where board_id=$1 order by user_id', [id]), role);

// Endpoint tests use real SQL/RLS through a small PostgREST-shaped adapter;
// identity and owner-only file readers are fixtures, never live accounts.
function endpointClient(actor) {
  return { from(table) {
    assert.ok(['shared_boards', 'shared_board_profiles'].includes(table));
    let columns = '*', filters = [], operation = 'select', body, order = '', limit = '';
    const run = async single => {
      try {
        if (operation === 'update') await globalThis.__boardProfiles.beforeUpdate?.();
        const result = await asUser(actor, tx => {
          const values = filters.map(([, value]) => value), where = filters.length ? ' where ' + filters.map(([key], i) => `${key}=$${i + 1}`).join(' and ') : '';
          if (operation === 'select') return tx.query(`select ${columns} from public.${table}${where}${order}${limit}`, values);
          const keys = Object.keys(body);
          if (operation === 'insert') return tx.query(`insert into public.${table} (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning ${columns}`, keys.map(key => body[key]));
          return tx.query(`update public.${table} set ${keys.map((key, i) => `${key}=$${values.length + i + 1}`).join(',')}${where} returning ${columns}`, [...values, ...keys.map(key => body[key])]);
        });
        return { data: single ? result.rows[0] || null : result.rows, error: null };
      } catch (error) { return { data: null, error }; }
    };
    const query = { select(value) { columns = value; return this; }, eq(key, value) { filters.push([key, value]); return this; }, order(key) { order = ' order by ' + key; return this; }, limit(count) { limit = ' limit ' + count; return this; }, insert(value) { operation = 'insert'; body = value; return this; }, update(value) { operation = 'update'; body = value; return this; }, maybeSingle() { return run(true); }, then(resolve, reject) { return run(false).then(resolve, reject); } };
    return query;
  } };
}
const endpointDirectory = await mkdtemp(join(tmpdir(), 'muze-board-profiles-')), require = createRequire(import.meta.url);
const modules = {
  'server-only': '',
  '@clerk/nextjs/server': "export const auth=async()=>({userId:globalThis.__boardProfiles.actor,getToken:async()=>'fixture'});export const currentUser=async()=>globalThis.__boardProfiles.user;",
  '@/utils/supabase/session': 'export const serverSessionToken=(_user,_session,getToken)=>getToken;',
  '@/utils/supabase/shared': 'export const createAuthenticatedClient=()=>globalThis.__boardProfiles.client;',
  '@/server/muse/private': `export {PrivateError} from '${resolve('src/server/muse/error.ts')}';export const checkOrigin=()=>{};export const withOwner=async(_request,run)=>run({ownerId:globalThis.__boardProfiles.actor});`,
  'muse-store.mjs': "export const ensureMuse=async owner=>{globalThis.__boardProfiles.reads.push(['identity',owner]);return {name:globalThis.__boardProfiles.museName||'Kumo'};};export const readMuseIcon=async owner=>{globalThis.__boardProfiles.reads.push(['icon',owner]);return null;};",
  'muse-avatar.mjs': "export const readAvatar=async owner=>{globalThis.__boardProfiles.reads.push(['avatar',owner]);return globalThis.__boardProfiles.avatar;};",
  './api': "export const boardJson=data=>Response.json(data,{headers:{'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'}});",
  'next/server': 'export class NextResponse extends Response {}',
};
const compiled = await build({ entryPoints: ['src/server/boards/profiles.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'endpoint-fixtures', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    const key = args.path.endsWith('/muse-store.mjs') ? 'muse-store.mjs' : args.path.endsWith('/muse-avatar.mjs') ? 'muse-avatar.mjs' : args.path;
    if (Object.hasOwn(modules, key)) return { path: key, namespace: 'fixture' };
    if (args.path === 'sharp') return { path: require.resolve('sharp'), external: true };
  });
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'ts', resolveDir: resolve('.') }));
} }] });
await writeFile(join(endpointDirectory, 'profiles.cjs'), compiled.outputFiles[0].text);
const endpoint = require(join(endpointDirectory, 'profiles.cjs'));
after(async () => { delete globalThis.__boardProfiles; await rm(endpointDirectory, { recursive: true, force: true }); });
const request = (id, version) => ({ url: `https://workspace.example/api/boards/${id}/participants`, nextUrl: new URL(`https://workspace.example/avatar${version ? '?v=' + version : ''}`), body: { userId: 'forged-user', soul: 'PRIVATE_INJECTED' } });
function endpointActor(actor, avatar = null) { globalThis.__boardProfiles = { actor, client: endpointClient(actor), user: actor ? { id: actor, firstName: 'Ada', imageUrl: 'https://img.clerk.com/ada.png' } : null, reads: [], avatar }; }


test('board members see one public profile per owner and can update only their own profile', async () => {
  const id = await board('profile-owner', 'profile-guest');
  await insert('profile-owner', id); await insert('profile-guest', id);
  assert.deepEqual((await read('profile-guest', id)).rows.map(row => row.user_id), ['profile-guest', 'profile-owner']);
  const changed = await asUser('profile-guest', tx => tx.query("update public.shared_board_profiles set muse_name='Pip' where board_id=$1 and user_id='profile-guest' returning muse_name", [id]));
  assert.equal(changed.rows[0].muse_name, 'Pip');
  await assert.rejects(insert('profile-guest', id, 'profile-owner'), { code: '42501' });
  assert.equal((await asUser('profile-guest', tx => tx.query("update public.shared_board_profiles set muse_name='Forged' where board_id=$1 and user_id='profile-owner' returning user_id", [id]))).rows.length, 0);
  assert.equal((await asUser('profile-guest', tx => tx.query("delete from public.shared_board_profiles where board_id=$1 and user_id='profile-owner' returning user_id", [id]))).rows.length, 0);
  await assert.rejects(asUser('profile-guest', tx => tx.query("update public.shared_board_profiles set user_id='someone-else' where board_id=$1 and user_id='profile-guest'", [id])), { code: '42501' });
  assert.equal((await asUser('profile-guest', tx => tx.query("delete from public.shared_board_profiles where board_id=$1 and user_id='profile-guest' returning user_id", [id]))).rows.length, 1);
});

test('nonmembers and anonymous users cannot read or publish board profiles', async () => {
  const id = await board('profile-private'); await insert('profile-private', id);
  assert.equal((await read('outsider', id)).rows.length, 0);
  await assert.rejects(insert('outsider', id), { code: '42501' });
  assert.equal((await read(null, id)).rows.length, 0);
  await assert.rejects(insert(null, id, 'spoofed-user'), { code: '42501' });
  await assert.rejects(read(null, id, 'anon'), { code: '42501' });
  await assert.rejects(insert(null, id, 'spoofed-user', 'anon'), { code: '42501' });
});

test('a member cannot copy a profile into another board or keep access after membership removal', async () => {
  const shared = await board('profile-room-owner', 'profile-room-guest'), other = await board('another-room-owner');
  await insert('profile-room-guest', shared); await insert('another-room-owner', other);
  assert.equal((await read('profile-room-guest', other)).rows.length, 0);
  await assert.rejects(insert('profile-room-guest', other), { code: '42501' });
  await assert.rejects(asUser('profile-room-guest', tx => tx.query("update public.shared_board_profiles set board_id=$1 where board_id=$2 and user_id='profile-room-guest'", [other, shared])), { code: '42501' });
  await db.query('delete from public.shared_board_members where board_id=$1 and user_id=$2', [shared, 'profile-room-guest']);
  assert.equal((await read('profile-room-guest', shared)).rows.length, 0);
  assert.equal((await asUser('profile-room-guest', tx => tx.query("update public.shared_board_profiles set muse_name='Changed' where board_id=$1 returning user_id", [shared]))).rows.length, 0);
  await assert.rejects(insert('profile-room-guest', shared), { code: '42501' });
});

test('deleting a shared board cascades its public profiles', async () => {
  const id = await board('profile-cascade-owner', 'profile-cascade-guest');
  await insert('profile-cascade-owner', id); await insert('profile-cascade-guest', id);
  await db.query('delete from public.shared_boards where id=$1', [id]);
  assert.equal((await db.query('select user_id from public.shared_board_profiles where board_id=$1', [id])).rows.length, 0);
});

test('profile sharing never opens private Soul, Memory, chat or avatar source records', async () => {
  const owner = 'profile-secret-owner', guest = 'profile-secret-guest', id = await board(owner, guest);
  for (const name of ['soul.md', 'memory.md', 'chat-' + 'a'.repeat(64) + '.json', 'avatar.json']) {
    await asUser(owner, tx => tx.query('insert into public.muse_private_files(owner_id,name,content) values($1,$2,$3)', [owner, name, Buffer.from('PRIVATE_' + name).toString('base64')]));
  }
  await insert(owner, id);
  assert.equal((await read(guest, id)).rows.length, 1);
  assert.equal((await asUser(guest, tx => tx.query('select * from public.muse_private_files where owner_id=$1', [owner]))).rows.length, 0);
  assert.equal((await asUser(guest, tx => tx.query("update public.muse_private_files set content='' where owner_id=$1 returning name", [owner]))).rows.length, 0);
  await assert.rejects(asUser(guest, tx => tx.query("insert into public.muse_private_files(owner_id,name,content) values($1,'icon.png','')", [owner])), { code: '42501' });
  assert.equal((await asUser(owner, tx => tx.query('select name from public.muse_private_files where owner_id=$1', [owner]))).rows.length, 4);
  assert.doesNotMatch(JSON.stringify((await read(guest, id)).rows), /PRIVATE_|soul\.md|memory\.md|chat-/);
});

test('profile DTO exposes only public fields and board-scoped avatar URLs', () => {
  const id = randomUUID(), version = 'a'.repeat(64);
  const value = participantData({ user_id: 'user_ada', name: 'Ada', avatar_url: 'https://img.clerk.com/ada.png', muse_name: 'Kumo', muse_avatar_version: version, muse_sheet: true, muse_poses: 9, muse_avatar: 'PRIVATE_IMAGE_BYTES', soul: 'PRIVATE_SOUL', memory: 'PRIVATE_MEMORY', chat: ['PRIVATE_CHAT'] }, id);
  assert.deepEqual(Object.keys(value).sort(), ['avatarUrl', 'museAvatarUrl', 'museAvatarVersion', 'museName', 'musePoses', 'museSheet', 'name', 'userId'].sort());
  assert.equal(value.museAvatarUrl, `/api/boards/${id}/participants/user_ada/avatar?v=${version}`);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|muse_avatar|soul|memory|chat/);
  for (const url of ['http://img.clerk.com/a', 'https://tracker.example/a', 'https://img.clerk.com.evil.test/a', 'https://name@img.clerk.com/a', 'https://img.clerk.com:444/a', 'data:image/png;base64,AA==']) assert.equal(clerkAvatarUrl(url), null);
  const defaults = participantData({ user_id: 'user_default', name: 'User', avatar_url: null, muse_name: 'Muse', muse_avatar_version: null, muse_sheet: false, muse_poses: 9 }, id);
  assert.equal(defaults.museAvatarUrl, '/muse/default-gaze-15.png?v=fluffyblob-v1'); assert.equal(defaults.musePoses, 15); assert.equal(defaults.museSheet, true);
});

test('appearance sharing selects the active image and never a pending candidate or raw upload', async () => {
  const active = Buffer.from('approved image'), preview = Buffer.from('current visible icon'), candidate = Buffer.from('private pending candidate'), icon = Buffer.from('legacy icon');
  const appearance = selectedMuseAppearance({ active: false, activeVersion: 'approved', activeSheet: active.toString('base64'), preview: preview.toString('base64'), candidateVersion: 'pending', candidate: candidate.toString('base64'), source: 'PRIVATE_RAW_SOURCE' }, { bytes: icon });
  assert.deepEqual(appearance.bytes, active); assert.equal(appearance.sheet, true);
  const inactive = selectedMuseAppearance({ active: false, preview: preview.toString('base64'), candidateVersion: 'pending', candidate: candidate.toString('base64'), source: 'PRIVATE_RAW_SOURCE' }, { bytes: icon });
  assert.deepEqual(inactive.bytes, preview); assert.equal(inactive.sheet, false);
  assert.deepEqual(selectedMuseAppearance({ candidate: candidate.toString('base64'), source: 'PRIVATE_RAW_SOURCE' }, { bytes: icon }).bytes, icon);
  assert.equal(selectedMuseAppearance({ candidate: candidate.toString('base64'), source: 'PRIVATE_RAW_SOURCE' }, null).bytes, null);
  const png = await sharp({ create: { width: 768, height: 768, channels: 4, background: '#538cfa' } }).png().toBuffer();
  for (const sheet of [true, false]) {
    const encoded = await sharedMuseImage({ bytes: png, sheet, version: 'fixture' });
    assert.ok(encoded.length <= 400_000);
    const metadata = await sharp(Buffer.from(encoded, 'base64')).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, sheet ? 384 : 128); assert.equal(metadata.height, sheet ? 384 : 128);
  }
});

test('participant endpoints reject anonymous and nonmember requests before reading private files', async () => {
  const id = await board('api-profile-owner');
  for (const [actor, status] of [[null, 401], ['api-outsider', 404]]) {
    endpointActor(actor);
    await assert.rejects(endpoint.listParticipants(request(id), id), { status });
    await assert.rejects(endpoint.publishParticipant(request(id), id), { status });
    await assert.rejects(endpoint.participantAvatar(request(id), id, 'api-profile-owner'), { status });
    assert.deepEqual(globalThis.__boardProfiles.reads, []);
  }
});

test('publishing snapshots only the authenticated profile and serves its activated WebP to members', async () => {
  const owner = 'api-visible-owner', guest = 'api-visible-guest', id = await board(owner, guest);
  const png = await sharp({ create: { width: 768, height: 768, channels: 4, background: '#4077dd' } }).png().toBuffer();
  endpointActor(owner, { activeVersion: 'current', activeSheet: png.toString('base64'), candidate: Buffer.from('PRIVATE_CANDIDATE').toString('base64'), candidateVersion: 'pending', source: 'PRIVATE_SOURCE', soul: 'PRIVATE_SOUL' });
  const published = await (await endpoint.publishParticipant(request(id), id)).json();
  assert.equal(published.participants[0].userId, owner); assert.equal(published.participants[0].museName, 'Kumo');
  assert.deepEqual(globalThis.__boardProfiles.reads.map(([, id]) => id), [owner, owner, owner]);
  assert.doesNotMatch(JSON.stringify(published), /PRIVATE_|forged-user|muse_avatar|soul|memory|chat/);
  const stored = (await db.query('select * from public.shared_board_profiles where board_id=$1', [id])).rows[0];
  assert.equal(stored.user_id, owner); assert.equal((await sharp(Buffer.from(stored.muse_avatar, 'base64')).metadata()).format, 'webp');
  endpointActor(guest);
  const listed = await endpoint.listParticipants(request(id), id); assert.match(listed.headers.get('cache-control'), /no-store/);
  assert.equal((await listed.json()).participants[0].userId, owner); assert.deepEqual(globalThis.__boardProfiles.reads, []);
  const image = await endpoint.participantAvatar(request(id, stored.muse_avatar_version), id, owner);
  assert.equal(image.headers.get('content-type'), 'image/webp'); assert.match(image.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(stored.muse_avatar, 'base64'));
  await assert.rejects(endpoint.participantAvatar(request(id, 'stale-version'), id, owner), { status: 404 });
  endpointActor('api-avatar-outsider');
  await assert.rejects(endpoint.participantAvatar(request(id, stored.muse_avatar_version), id, owner), { status: 404 });
});

test('name-only publication keeps image bytes and stale profile updates cannot overwrite a newer snapshot', async () => {
  const owner = 'api-revision-owner', id = await board(owner);
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#5588dd' } }).png().toBuffer();
  endpointActor(owner, { preview: png.toString('base64') });
  await endpoint.publishParticipant(request(id), id);
  const row = async () => (await db.query('select muse_name,muse_avatar,revision from public.shared_board_profiles where board_id=$1', [id])).rows[0];
  const initial = await row();
  globalThis.__boardProfiles.museName = 'Pip';
  await endpoint.publishParticipant(request(id), id);
  const renamed = await row(); assert.equal(renamed.muse_name, 'Pip'); assert.equal(renamed.muse_avatar, initial.muse_avatar); assert.notEqual(renamed.revision, initial.revision);
  globalThis.__boardProfiles.museName = 'Stale rename';
  let injected = false;
  globalThis.__boardProfiles.beforeUpdate = async () => {
    assert.equal(injected, false); injected = true;
    await db.query("update public.shared_board_profiles set muse_name='Newer snapshot',revision=gen_random_uuid() where board_id=$1", [id]);
  };
  await assert.rejects(endpoint.publishParticipant(request(id), id), { status: 409 });
  const preserved = await row(); assert.equal(preserved.muse_name, 'Newer snapshot'); assert.equal(preserved.muse_avatar, initial.muse_avatar);
});

after(() => db.close());
