import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

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
for (const suffix of ['_private_muse_storage.sql', '_shared_board_invitations.sql', '_board_conflict_responses.sql']) {
  const name = (await readdir(migrations)).find(name => name.endsWith(suffix));
  assert.ok(name);
  await db.exec(await readFile(new URL(name, migrations), 'utf8'));
}
after(() => db.close());
function asUser(id, run, role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role })]);
    return run(tx);
  });
}
const scene = () => ({ id: randomUUID(), name: 'A shared plan', activePage: 'page', pages: [{ id: 'page', name: 'Page 1', objects: [], viewport: [1, 0, 0, 1, 0, 0] }] });
async function action(user, operation, { id = null, board = null, revision = null, token = null } = {}, role) {
  const result = await asUser(user, tx => tx.query('select public.write_shared_board($1,$2,$3,$4,$5) as result', [operation, id, board && JSON.stringify(board), revision, token]), role);
  return result.rows[0].result;
}

test('boards are private until an authenticated person accepts an invitation', async () => {
  const created = await action('alice', 'create', { board: scene() });
  const id = created.board.id, token = randomBytes(32).toString('base64url');
  assert.equal(created.role, 'owner');
  const unseen = await asUser('bob', tx => tx.query('select id from public.shared_boards where id=$1', [id]));
  assert.equal(unseen.rows.length, 0);
  await assert.rejects(action('bob', 'save', { id, board: created.board, revision: created.revision }), { code: '42501' });
  await assert.rejects(action(null, 'join', { id, token }, 'anon'), { code: '42501' });
  await assert.rejects(action(null, 'create', { board: scene() }), { code: '42501' });
  await action('alice', 'invite', { id, token });
  await assert.rejects(action('bob', 'join', { id, token: randomBytes(32).toString('base64url') }), { code: '42501' });
  const joined = await action('bob', 'join', { id, token });
  assert.equal(joined.board.id, id);
  assert.equal(joined.role, 'editor');
  assert.equal((await asUser('bob', tx => tx.query('select id from public.shared_boards where id=$1', [id]))).rows.length, 1);
  const ownMemberships = await asUser('alice', tx => tx.query('select user_id from public.shared_board_members'));
  assert.ok(ownMemberships.rows.every(row => row.user_id === 'alice'));
});

test('only owners manage links, rotation and expiry stop new joins, and token plaintext is never stored', async () => {
  const created = await action('link-owner', 'create', { board: scene() });
  const id = created.board.id, token = randomBytes(32).toString('base64url');
  await action('link-owner', 'invite', { id, token });
  const stored = (await db.query('select token_hash from public.shared_board_invites where board_id=$1', [id])).rows[0];
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  await action('link-member', 'join', { id, token });
  for (const operation of ['invite', 'revoke']) await assert.rejects(action('link-member', operation, { id, token }), { code: '42501' });
  await assert.rejects(asUser('link-member', tx => tx.query('select * from public.shared_board_invites')), { code: '42501' });
  const nextToken = randomBytes(32).toString('base64url');
  await action('link-owner', 'invite', { id, token: nextToken });
  await assert.rejects(action('other-member', 'join', { id, token }), { code: '42501' });
  await db.query("update public.shared_board_invites set expires_at=now()-interval '1 minute' where board_id=$1", [id]);
  await assert.rejects(action('other-member', 'join', { id, token: nextToken }), { code: '42501' });
  await action('link-owner', 'invite', { id, token: nextToken });
  await action('link-owner', 'revoke', { id });
  await assert.rejects(action('other-member', 'join', { id, token: nextToken }), { code: '42501' });
  assert.equal((await action('link-member', 'join', { id, token })).role, 'editor', 'revoking links does not evict existing members');
});

test('stale saves fail without overwriting another member and direct writes cannot bypass revision checks', async () => {
  const created = await action('writer', 'create', { board: scene() });
  const id = created.board.id, token = randomBytes(32).toString('base64url');
  await action('writer', 'invite', { id, token });
  await action('co-writer', 'join', { id, token });
  const next = await action('co-writer', 'save', { id, revision: created.revision, board: { ...created.board, name: 'Newer title' } });
  assert.notEqual(next.revision, created.revision);
  assert.equal(next.role, 'editor');
  await assert.rejects(action('writer', 'save', { id, revision: created.revision, board: created.board }), { code: 'PT409' });
  const stored = (await asUser('writer', tx => tx.query('select name from public.shared_boards where id=$1', [id]))).rows[0];
  assert.equal(stored.name, 'Newer title');
  for (const sql of [
    "update public.shared_boards set owner_id='co-writer' where id=$1",
    "update public.shared_boards set revision=gen_random_uuid() where id=$1",
    'delete from public.shared_boards where id=$1',
    "insert into public.shared_board_members(board_id,user_id) values ($1,'intruder')",
    'delete from public.shared_board_invites where board_id=$1',
  ]) await assert.rejects(asUser('co-writer', tx => tx.query(sql, [id])), { code: '42501' });
});

test('sharing never grants access to another person’s Muse or private notebook cards', async () => {
  await asUser('private-owner', tx => tx.query("insert into public.muse_private_files(owner_id,name,content) values ('private-owner','memory.md','cHJpdmF0ZQ==')"));
  const created = await action('private-owner', 'create', { board: scene() });
  const id = created.board.id, token = randomBytes(32).toString('base64url');
  await action('private-owner', 'invite', { id, token });
  await action('private-guest', 'join', { id, token });
  assert.equal((await asUser('private-guest', tx => tx.query("select * from public.muse_private_files where owner_id='private-owner'"))).rows.length, 0);
  const board = scene(); board.pages[0].objects.push({ id: 'muse-file-memory', type: 'MuzeDocument', text: 'private' });
  await assert.rejects(action('private-owner', 'create', { board }), { code: '22023' });
  await assert.rejects(action('private-owner', 'create', { board: { ...scene(), name: 'x'.repeat(3_000_000) } }), { code: '22023' });
});

test('shared board ownership and anonymous function access stay closed', async () => {
  await assert.rejects(asUser(null, tx => tx.query('select * from public.shared_boards'), 'anon'), { code: '42501' });
  await assert.rejects(asUser(null, tx => tx.query("select muze_board_internal.write_board('create',null,'{}',null,null)"), 'anon'), { code: '42501' });
  await assert.rejects(action('outsider', 'nonsense'), { code: '22023' });
});
