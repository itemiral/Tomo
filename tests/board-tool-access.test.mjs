import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create schema auth; create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$; grant usage on schema auth to anon,authenticated; grant execute on function auth.jwt() to anon,authenticated;`);
for (const file of ['20261101191930_private_muse_storage.sql', '20261101195930_shared_board_invitations.sql', '20261103004650_validate_shared_board_scenes.sql', '20261104040138_board_tool_access.sql']) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
after(() => db.close());
const asUser = (user, action, role = 'authenticated') => db.transaction(async tx => {await tx.exec('set local role ' + role); await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: user})]); return action(tx);});
const token = () => 'muze_' + randomBytes(32).toString('base64url');
const scene = () => ({id: randomUUID(), name: 'Shared only', activePage: 'page', pages: [{id: 'page', name: 'Page 1', objects: [{id: 'note', type: 'MuzeNote', text: 'Board content'}], viewport: [1, 0, 0, 1, 0, 0]}]});
const create = async owner => (await asUser(owner, tx => tx.query("select public.write_shared_board('create',null,$1) value", [JSON.stringify(scene())]))).rows[0].value;
const manage = async (user, operation, id, secret = null) => (await asUser(user, tx => tx.query('select public.manage_board_tool_access($1,$2,$3) value', [operation, id, secret]))).rows[0].value;
const read = async (id, secret) => (await asUser('', tx => tx.query('select public.read_board_for_tool($1,$2) value', [id, secret]), 'anon')).rows[0].value;

test('a scoped token exposes only the current shared scene; only its hash is stored', async () => {
  const saved = await create('owner'), secret = token(), id = saved.board.id;
  const status = await manage('owner', 'create', id, secret);
  assert.equal(status.enabled, true); assert.deepEqual(Object.keys(status).sort(), ['createdAt', 'enabled']);
  assert.deepEqual((await read(id, secret)).board, saved.board);
  const stored = (await db.query('select * from muze_board_internal.board_tool_access where board_id=$1', [id])).rows[0];
  assert.equal(stored.token_hash, createHash('sha256').update(secret).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(secret));
  assert.deepEqual(Object.keys(await read(id, secret)).sort(), ['board', 'revision', 'updatedAt']);
  await assert.rejects(read((await create('other')).board.id, secret), {code: '42501'});
  await assert.rejects(read(id, token()), {code: '42501'});
});

test('board editors, outsiders and anonymous callers cannot manage or inspect tokens', async () => {
  const saved = await create('owner'), id = saved.board.id, secret = token();
  await db.query('insert into public.shared_board_members(board_id,user_id) values($1,$2)', [id, 'editor']);
  await manage('owner', 'create', id, secret);
  for (const user of ['editor', 'outsider', '']) for (const operation of ['status', 'create', 'revoke']) await assert.rejects(manage(user, operation, id, secret), {code: '42501'});
  await assert.rejects(asUser('', tx => tx.query("select public.manage_board_tool_access('status',$1)", [id]), 'anon'), {code: '42501'});
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asUser('owner', tx => tx.query('select * from muze_board_internal.board_tool_access'), role), {code: '42501'});
    await assert.rejects(asUser('owner', tx => tx.query('update muze_board_internal.board_tool_access set owner_id=$1', ['attacker']), role), {code: '42501'});
  }
  await assert.rejects(asUser('', tx => tx.query('select * from public.shared_boards'), 'anon'), {code: '42501'});
});

test('rotation, revocation, ownership changes and deletion invalidate access immediately', async () => {
  const id = (await create('owner')).board.id, first = token(), second = token();
  await manage('owner', 'create', id, first); await manage('owner', 'create', id, second);
  await assert.rejects(read(id, first), {code: '42501'}); await read(id, second);
  assert.equal((await manage('owner', 'revoke', id)).enabled, false); await assert.rejects(read(id, second), {code: '42501'});
  await manage('owner', 'create', id, second);
  await db.query('update public.shared_boards set owner_id=$1 where id=$2', ['next-owner', id]);
  await assert.rejects(read(id, second), {code: '42501'}); await assert.rejects(manage('owner', 'create', id, first), {code: '42501'});
  await manage('next-owner', 'create', id, first); await read(id, first);
  await db.query('delete from public.shared_boards where id=$1', [id]);
  await assert.rejects(read(id, first), {code: '42501'});
  assert.equal((await db.query('select count(*)::int count from muze_board_internal.board_tool_access where board_id=$1', [id])).rows[0].count, 0);
});

test('database RPC rejects malformed tokens and has narrowly scoped execute grants', async () => {
  const id = (await create('owner')).board.id;
  for (const secret of [null, '', 'short', 'muze_' + 'a'.repeat(42), 'muze_' + '/'.repeat(43)]) {
    await assert.rejects(manage('owner', 'create', id, secret), {code: '22023'});
    await assert.rejects(read(id, secret), {code: '42501'});
  }
  const functions = (await db.query("select proname,prosecdef,proconfig,proacl::text acl from pg_proc where proname in ('manage_tool_access','read_tool_board','manage_board_tool_access','read_board_for_tool')")).rows;
  assert.equal(functions.length, 4);
  for (const fn of functions) {assert.ok(fn.proconfig.includes('search_path=""')); assert.ok(!fn.acl.includes('{=X/'));}
  assert.equal((await db.query("select has_function_privilege('anon','public.manage_board_tool_access(text,uuid,text)','EXECUTE') value")).rows[0].value, false);
  assert.equal((await db.query("select has_function_privilege('authenticated','public.read_board_for_tool(uuid,text)','EXECUTE') value")).rows[0].value, false);
});
