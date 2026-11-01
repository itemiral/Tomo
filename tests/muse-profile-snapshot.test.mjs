import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile as diskRead, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const directory = await mkdtemp(join(tmpdir(), 'muze-profile-snapshot-'));
process.env.MUZE_PRIVATE_DIR = directory;
const { withMuseStorage, withMuseProfileSnapshot, readFile, writeFile } = await import('../scripts/muse-storage.mjs');
const { ensureMuse, readMuseIcon, museDirectory } = await import('../scripts/muse-store.mjs');
const { readAvatar } = await import('../scripts/muse-avatar.mjs');
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
  const file = (await readdir(migrations)).find(file => file.endsWith(suffix));
  assert.ok(file);
  await db.exec(await diskRead(new URL(file, migrations), 'utf8'));
}
after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });

function asOwner(owner, operation) {
  return db.transaction(async transaction => {
    await transaction.exec('set local role authenticated');
    await transaction.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })]);
    return operation(transaction);
  });
}
function client(owner) {
  const connection = {
    queries: [], commits: [],
    from(table) {
      assert.equal(table, 'muse_private_files');
      const filter = {};
      const run = async single => {
        connection.queries.push(structuredClone(filter));
        const names = filter.names || [filter.name];
        const result = await asOwner(owner, tx => tx.query(
          'select name,content,version,updated_at from public.muse_private_files where owner_id=$1 and name=any($2::text[])',
          [filter.owner_id, names],
        ));
        return { data: single ? result.rows[0] || null : result.rows, error: null };
      };
      return {
        select(columns) { assert.equal(columns, 'name,content,version,updated_at'); return this; },
        eq(key, value) { filter[key] = value; return this; },
        in(key, values) { assert.equal(key, 'name'); filter.names = values; return this; },
        maybeSingle() { return run(true); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
    },
    async rpc(name, args) {
      assert.equal(name, 'commit_muse_files');
      connection.commits.push(structuredClone(args));
      try {
        const result = await asOwner(owner, tx => tx.query('select public.commit_muse_files($1::jsonb,$2::jsonb) as result', [JSON.stringify(args.changes), JSON.stringify(args.held_leases || [])]));
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error }; }
    },
  };
  return connection;
}
const cloud = (owner, operation, connection = client(owner)) => withMuseStorage(owner, connection, operation);
const snapshot = (owner, connection = client(owner)) => cloud(owner, () => withMuseProfileSnapshot(async () => {
  const identity = await ensureMuse(owner);
  const [avatar, icon] = await Promise.all([readAvatar(owner), readMuseIcon(owner)]);
  return { identity, avatar, icon };
}), connection);
const metadata = owner => asOwner(owner, async tx => (await tx.query('select name,version from public.muse_private_files where owner_id=$1 order by name', [owner])).rows);

test('an existing Muse profile uses one bounded owner query and makes no database writes', async () => {
  const owner = 'snapshot_existing';
  await cloud(owner, async () => {
    await ensureMuse(owner);
    await writeFile(join(museDirectory(owner), 'avatar.json'), JSON.stringify({ version: 'current', preview: 'fixture' }));
    await writeFile(join(museDirectory(owner), 'chat-' + 'a'.repeat(64) + '.json'), '["Private conversation"]');
  });
  const before = await metadata(owner), connection = client(owner);
  const result = await snapshot(owner, connection);
  assert.equal(result.avatar.version, 'current');
  assert.equal(result.icon, null);
  assert.deepEqual(connection.queries, [{ owner_id: owner, names: ['identity.json', 'soul.md', 'memory.md', 'canvas.json', 'avatar.json', 'icon.png'] }]);
  assert.equal(connection.commits.length, 0);
  assert.deepEqual(await metadata(owner), before);
});

test('profile snapshots see fresh writes across requests and cannot cross owner boundaries', async () => {
  const alice = 'snapshot_alice', bob = 'snapshot_bob';
  await Promise.all([snapshot(alice), snapshot(bob)]);
  await cloud(alice, () => writeFile(join(museDirectory(alice), 'avatar.json'), JSON.stringify({ version: 'alice-v1' })));
  await cloud(bob, () => writeFile(join(museDirectory(bob), 'avatar.json'), JSON.stringify({ version: 'bob-only' })));
  const first = await Promise.all([snapshot(alice), snapshot(bob)]);
  assert.equal(first[0].avatar.version, 'alice-v1');
  assert.equal(first[1].avatar.version, 'bob-only');
  assert.notEqual(first[0].identity.id, first[1].identity.id);
  await cloud(alice, () => writeFile(join(museDirectory(alice), 'avatar.json'), JSON.stringify({ version: 'alice-v2' })));
  assert.equal((await snapshot(alice)).avatar.version, 'alice-v2');
  await assert.rejects(cloud(bob, () => withMuseProfileSnapshot(() => readFile(join(museDirectory(alice), 'soul.md'), 'utf8'))), { status: 403 });
  const direct = await asOwner(bob, tx => tx.query('select name from public.muse_private_files where owner_id=$1', [alice]));
  assert.equal(direct.rows.length, 0);
});

test('concurrent initialization retries a fresh snapshot and returns the winning identity', async () => {
  const owner = 'snapshot_initial_race', connection = client(owner), commit = connection.rpc;
  let winner, intercepted = false;
  connection.rpc = async (name, args) => {
    if (!intercepted) {
      intercepted = true;
      winner = await cloud(owner, () => ensureMuse(owner));
    }
    return commit(name, args);
  };
  const result = await snapshot(owner, connection);
  assert.deepEqual(result.identity, winner);
  assert.equal(connection.queries.length, 2, 'a conflict must discard the old cached rows');
  assert.equal(connection.commits.length, 1, 'the second snapshot finds complete files and needs no write');
  assert.equal(connection.commits[0].changes.find(change => change.name === 'identity.json').expected_version, null);
  assert.equal((await metadata(owner)).length, 3);
});

test('snapshot initialization keeps its conflict retries bounded', async () => {
  const owner = 'snapshot_repeated_conflict', connection = client(owner);
  let commits = 0;
  connection.rpc = async () => { commits++; return { data: null, error: { code: 'PT409' } }; };
  await assert.rejects(snapshot(owner, connection), { status: 409, code: 'PT409' });
  assert.equal(commits, 3);
  assert.equal(connection.queries.length, 3);
  assert.deepEqual(await metadata(owner), []);
});

test('a profile snapshot fails closed when its database credential expires', async () => {
  const owner = 'snapshot_expired';
  let called = false;
  const connection = { from() { return { select() { return this; }, eq() { return this; }, in() { return Promise.resolve({ data: null, error: { code: 'PGRST303' } }); } }; } };
  await assert.rejects(cloud(owner, () => withMuseProfileSnapshot(() => { called = true; }), connection), { status: 401 });
  assert.equal(called, false);
});
