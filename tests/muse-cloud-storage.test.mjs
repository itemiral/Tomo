import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readDiskFile, readdir, mkdtemp, rm, writeFile as writeDiskFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
const localDirectory = await mkdtemp(join(tmpdir(), 'muze-cloud-test-'));
process.env.MUZE_PRIVATE_DIR = localDirectory;
const { withMuseStorage, withStorageTransaction, withMuseLease, readFile, writeFile, usesCloudStorage, migrateLocalMuse } = await import('../scripts/muse-storage.mjs');
const { museDirectory, readMuseNote, saveMuseNote, ensureMuse } = await import('../scripts/muse-store.mjs');
const { readMuseCanvas, saveMuseCanvas } = await import('../scripts/muse-canvas.mjs');
const { replaceAvatar, readAvatar, uploadAvatar } = await import('../scripts/muse-avatar.mjs');

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
  await db.exec(await readDiskFile(new URL(name, migrations), 'utf8'));
}
after(async () => { await db.close(); await rm(localDirectory, { recursive: true, force: true }); });

function asUser(ownerId, operation, role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role })]);
    return operation(tx);
  });
}

function client(ownerId) {
  return {
    from(table) {
      assert.equal(table, 'muse_private_files');
      const conditions = {};
      const query = {
        select() { return query; },
        eq(key, value) { conditions[key] = value; return query; },
        async maybeSingle() {
          const result = await asUser(ownerId, tx => tx.query(
            'select name,content,version,updated_at from public.muse_private_files where owner_id=$1 and name=$2',
            [conditions.owner_id, conditions.name],
          ));
          return { data: result.rows[0] || null, error: null };
        },
      };
      return query;
    },
    async rpc(name, args) {
      try {
        const result = await asUser(ownerId, tx => name === 'commit_muse_files'
          ? tx.query('select public.commit_muse_files($1::jsonb,$2::jsonb) as result', [JSON.stringify(args.changes), JSON.stringify(args.held_leases || [])])
          : tx.query(`select public.${name}($1::text,$2::uuid) as result`, [args.resource, args.lease_token]));
        return { data: result.rows[0]?.result, error: null };
      } catch (error) { return { data: null, error }; }
    },
  };
}

const cloud = (owner, operation) => withMuseStorage(owner, client(owner), operation);

test('initial Muse creation retries a bounded application conflict', async () => {
  const owner = 'user_initial_conflict', connection = client(owner);
  const original = connection.rpc;
  let commits = 0;
  connection.rpc = async (name, args) => {
    if (name === 'commit_muse_files' && ++commits === 1) return { data: null, error: { code: 'PT409', message: 'Document changed' } };
    return original(name, args);
  };
  await withMuseStorage(owner, connection, () => ensureMuse(owner));
  assert.equal(commits, 2);
  assert.ok((await cloud(owner, () => readMuseNote(owner, 'soul'))).content.length);
});

test('cloud notebooks survive requests and keep each owner’s canonical files private', async () => {
  const first = await cloud('user_alice', () => readMuseCanvas('user_alice'));
  first.board.pages[0].objects.find(o => o.id === 'muse-file-memory').markdown = '# Memory\nPrivate preference';
  await cloud('user_alice', () => saveMuseCanvas('user_alice', first));
  const reloaded = await cloud('user_alice', () => readMuseNote('user_alice', 'memory'));
  assert.equal(reloaded.content, '# Memory\nPrivate preference');
  const bob = await cloud('user_bob', () => readMuseCanvas('user_bob'));
  assert.doesNotMatch(JSON.stringify(bob), /Private preference/);
  await assert.rejects(cloud('user_bob', () => readFile(join(museDirectory('user_alice'), 'memory.md'), 'utf8')), { status: 403 });
  const visible = await asUser('user_bob', tx => tx.query('select distinct owner_id from public.muse_private_files'));
  assert.deepEqual(visible.rows, [{ owner_id: 'user_bob' }]);
});

test('RLS rejects ownership reassignment and anonymous access, including direct API writes', async () => {
  await assert.rejects(asUser('user_bob', tx => tx.query("update public.muse_private_files set owner_id='user_alice' where name='memory.md'")), { code: '42501' });
  await assert.rejects(asUser('user_bob', tx => tx.query("insert into public.muse_private_files(owner_id,name,content) values ('user_alice','icon.png','')")), { code: '42501' });
  await assert.rejects(asUser(null, tx => tx.query('select * from public.muse_private_files'), 'anon'), { code: '42501' });
  await assert.rejects(asUser(null, tx => tx.query("select public.commit_muse_files('[]'::jsonb)"), 'anon'), { code: '42501' });
  const deleted = await asUser('user_bob', tx => tx.query("delete from public.muse_private_files where owner_id='user_alice' returning name"));
  assert.equal(deleted.rows.length, 0);
});

test('a stale multi-file save rolls back every document', async () => {
  const owner = 'user_atomic';
  await cloud(owner, () => ensureMuse(owner));
  const original = await cloud(owner, () => readMuseNote(owner, 'soul'));
  await assert.rejects(cloud(owner, () => withStorageTransaction(async () => {
    const path = join(museDirectory(owner), 'soul.md');
    await readFile(path, 'utf8');
    await asUser(owner, tx => tx.query("update public.muse_private_files set content=$1,version=gen_random_uuid() where name='soul.md'", [Buffer.from('Newer edit').toString('base64')]));
    await writeFile(path, 'Stale edit');
    await writeFile(join(museDirectory(owner), 'memory.md'), 'Must not commit');
  })), { status: 409, code: 'PT409' });
  assert.equal((await cloud(owner, () => readMuseNote(owner, 'soul'))).content, 'Newer edit');
  assert.doesNotMatch((await cloud(owner, () => readMuseNote(owner, 'memory'))).content, /Must not commit/);
  await assert.rejects(cloud(owner, () => saveMuseNote(owner, 'soul', 'Old revision', original.revision)), { status: 409 });
});

test('an interrupted transaction writes nothing and a new request gets a fresh snapshot', async () => {
  const owner = 'user_rollback';
  await cloud(owner, () => ensureMuse(owner));
  await assert.rejects(cloud(owner, () => withStorageTransaction(async () => {
    await writeFile(join(museDirectory(owner), 'memory.md'), 'Not committed');
    throw new Error('Interrupted');
  })), /Interrupted/);
  assert.doesNotMatch((await cloud(owner, () => readMuseNote(owner, 'memory'))).content, /Not committed/);
});

test('leases coordinate separate workers and prevent an expired worker from committing', async () => {
  const owner = 'user_lease';
  await cloud(owner, () => ensureMuse(owner));
  await cloud(owner, () => withMuseLease(owner, 'avatar', async () => {
    await assert.rejects(cloud(owner, () => withMuseLease(owner, 'avatar', async () => {})), { status: 409 });
    await db.query("update public.muse_private_leases set expires_at=now()-interval '1 second' where owner_id=$1", [owner]);
    const replacement = randomUUID();
    const next = await client(owner).rpc('acquire_muse_lease', { resource: 'avatar', lease_token: replacement });
    assert.equal(next.data, true);
    await assert.rejects(writeFile(join(museDirectory(owner), 'avatar.json'), '{}'), { status: 409 });
  }));
  const held = await db.query('select token from public.muse_private_leases where owner_id=$1', [owner]);
  assert.equal(held.rows.length, 1, 'old worker must not release the new worker’s lease');
});

test('owner context cannot cross requests or write local files on a hosted runtime', async () => {
  const oldVercel = process.env.VERCEL, oldMode = process.env.MUZE_STORAGE;
  process.env.VERCEL = '1'; delete process.env.MUZE_STORAGE;
  try {
    assert.equal(usesCloudStorage(), true);
    await assert.rejects(readFile(join(museDirectory('unauthenticated'), 'soul.md')), { status: 401 });
    process.env.MUZE_STORAGE = 'local';
    assert.throws(usesCloudStorage, { status: 503 });
  } finally {
    if (oldVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = oldVercel;
    if (oldMode === undefined) delete process.env.MUZE_STORAGE; else process.env.MUZE_STORAGE = oldMode;
  }
});

test('concurrent requests keep separate owners and transactions', async () => {
  await Promise.all(['user_parallel_a', 'user_parallel_b'].map(owner => cloud(owner, async () => {
    const note = await readMuseNote(owner, 'memory');
    await saveMuseNote(owner, 'memory', 'Only for ' + owner, note.revision);
    assert.equal((await readMuseNote(owner, 'memory')).content, 'Only for ' + owner);
  })));
});

test('local migration preserves identity and operation history without overwriting either copy', async () => {
  const owner = 'user_migration';
  const identity = await ensureMuse(owner);
  const note = await readMuseNote(owner, 'soul');
  await saveMuseNote(owner, 'soul', 'My existing Muse', note.revision);
  const history = JSON.stringify([{ id: randomUUID(), status: 'failed-or-uncertain', reservedUsd: .01 }]);
  await writeDiskFile(join(museDirectory(owner), 'avatar-operations.json'), history);
  const result = await migrateLocalMuse(owner, client(owner));
  assert.equal(result.migrated, 4);
  assert.equal((await cloud(owner, () => ensureMuse(owner))).id, identity.id);
  assert.equal((await cloud(owner, () => readMuseNote(owner, 'soul'))).content, 'My existing Muse');
  assert.equal(await cloud(owner, () => readFile(join(museDirectory(owner), 'avatar-operations.json'), 'utf8')), history);
  assert.equal((await readMuseNote(owner, 'soul')).content, 'My existing Muse');
  await assert.rejects(migrateLocalMuse(owner, client(owner)), { status: 409 });
});

test('lease cleanup works with the real SDK query builder and preserves the operation result', async () => {
  const calls = [];
  const sdk = createClient('https://workspace.example', 'public-test-key', {
    accessToken: async () => 'test-session',
    global: { fetch: async input => {
      const name = new URL(String(input)).pathname.split('/').at(-1);
      calls.push(name);
      return new Response(JSON.stringify(name === 'acquire_muse_lease' ? true : null), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const result = await withMuseStorage('user_sdk', sdk, () => withMuseLease('user_sdk', 'chat', async () => 'Completed response'));
  assert.equal(result, 'Completed response');
  assert.deepEqual(calls, ['acquire_muse_lease', 'release_muse_lease']);
  await assert.rejects(withMuseStorage('user_sdk', sdk, () => withMuseLease('user_sdk', 'chat', async () => { throw new Error('Original failure'); })), /Original failure/);
});

test('a large avatar persists through one database timeout without repeating generation', async () => {
  process.env.MODEL_API_KEY = 'fixture-only-not-a-real-key';
  const owner = 'user_avatar_timeout', connection = client(owner), original = connection.rpc;
  const sourceBytes = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
  const sheet = await sharp(randomBytes(768 * 768 * 3), { raw: { width: 768, height: 768, channels: 3 } }).png().toBuffer();
  let commits = 0, generations = 0, initialArguments;
  connection.rpc = async (name, args) => {
    if (name === 'commit_muse_files' && args.changes.some(change => change.name === 'avatar.json')) {
      commits++;
      if (commits === 1) { initialArguments = JSON.stringify(args); return { error: { code: '57014', message: 'Statement timeout' } }; }
      assert.equal(JSON.stringify(args), initialArguments, 'retry must preserve the expected versions and lease');
    }
    return original(name, args);
  };
  const body = { source: 'data:image/png;base64,' + sourceBytes.toString('base64'), operationId: randomUUID(), confirmCost: true, maxCostUsd: .01, shareWithMeta: true };
  const result = await withMuseStorage(owner, connection, () => replaceAvatar(owner, body, new AbortController().signal, async () => {
    generations++;
    return { ok: true, json: async () => ({ data: [{ b64_json: sheet.toString('base64') }] }) };
  }));
  assert.equal(result.status, 'completed');
  assert.equal(commits, 2);
  assert.equal(generations, 1);
  const saved = await cloud(owner, () => readAvatar(owner));
  assert.equal(saved.source, body.source);
  assert.equal(saved.activeVersion, result.gazeVersion);
  assert.ok(saved.activeSheet.length > 1_000_000);
});

test('a second timeout stops the exact write retry and logs no private document contents', async () => {
  process.env.MODEL_API_KEY = 'fixture-only-not-a-real-key';
  const owner = 'user_timeout_bounded', connection = client(owner);
  const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: '#334455' } }).png().toBuffer();
  const source = 'data:image/png;base64,' + png.toString('base64');
  const previous = await cloud(owner, () => uploadAvatar(owner, source));
  let commits = 0, generations = 0;
  const original = connection.rpc, originalError = console.error, originalWarn = console.warn, logs = [];
  console.error = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  connection.rpc = async (name, args) => {
    if (name === 'commit_muse_files' && args.changes.some(change => change.name === 'avatar.json')) {
      commits++;
      return { error: { code: '57014', message: 'Private document text must not enter logs', details: args } };
    }
    return original(name, args);
  };
  try {
    await assert.rejects(withMuseStorage(owner, connection, () => replaceAvatar(owner, {
      source, operationId: randomUUID(), confirmCost: true, maxCostUsd: .01, shareWithMeta: true,
    }, new AbortController().signal, async () => {
      generations++;
      return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
    })), { status: 503, code: '57014' });
  } finally { console.error = originalError; console.warn = originalWarn; }
  assert.equal(commits, 2);
  assert.equal(generations, 1);
  const unchanged = await cloud(owner, () => readAvatar(owner));
  assert.equal(unchanged.version, previous.iconVersion);
  assert.equal(unchanged.active, false);
  assert.equal(unchanged.activeSheet, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /Private document|source-image|user_timeout/);
  assert.ok(logs.some(args => args[1]?.code === '57014'));
});

test('an uncertain transport failure is never retried', async () => {
  const owner = 'user_transport_unknown', connection = client(owner), original = connection.rpc;
  let commits = 0;
  connection.rpc = async (name, args) => {
    if (name === 'commit_muse_files') { commits++; return { error: { code: '', message: 'Connection lost after sending' } }; }
    return original(name, args);
  };
  await assert.rejects(withMuseStorage(owner, connection, () => writeFile(join(museDirectory(owner), 'avatar.json'), '{}')), { status: 503 });
  assert.equal(commits, 1);
});
