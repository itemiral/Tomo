import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  create schema realtime;
  create function realtime.topic() returns text language sql stable as
    $$ select nullif(current_setting('realtime.topic', true), '')::text $$;
  create table realtime.messages (
    id uuid primary key default gen_random_uuid(), topic text not null,
    extension text not null, payload jsonb, event text, private boolean default false
  );
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to anon, authenticated;
  grant execute on function realtime.topic() to anon, authenticated;
  grant select, insert on realtime.messages to anon, authenticated;
`);
const migrations = new URL('../supabase/migrations/', import.meta.url);
for (const suffix of ['_private_muse_storage.sql', '_shared_board_invitations.sql', '_board_conflict_responses.sql', '_shared_board_presence.sql']) {
  const name = (await readdir(migrations)).find(name => name.endsWith(suffix));
  assert.ok(name);
  await db.exec(await readFile(new URL(name, migrations), 'utf8'));
}
after(() => db.close());

function asUser(id, topic, run, role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims', $1, true),set_config('realtime.topic', $2, true)", [JSON.stringify({ sub: id, role }), topic || '']);
    return run(tx);
  });
}
const scene = () => ({ id: randomUUID(), name: 'Presence test', activePage: 'page', pages: [{ id: 'page', name: 'Page 1', objects: [], viewport: [1, 0, 0, 1, 0, 0] }] });
async function room(owner, guest) {
  const created = await asUser(owner, '', tx => tx.query("select public.write_shared_board('create',null,$1) as snapshot", [JSON.stringify(scene())]));
  const board = created.rows[0].snapshot.board, token = randomBytes(32).toString('base64url');
  await asUser(owner, '', tx => tx.query("select public.write_shared_board('invite',$1,null,null,$2)", [board.id, token]));
  if (guest) await asUser(guest, '', tx => tx.query("select public.write_shared_board('join',$1,null,null,$2)", [board.id, token]));
  return { id: board.id, topic: 'board:' + board.id };
}
const insert = (user, topic, extension = 'broadcast', messageTopic = topic, role) => asUser(user, topic,
  tx => tx.query("insert into realtime.messages(topic,extension,event,payload,private) values ($1,$2,'cursor','{}',true) returning id", [messageTopic, extension]), role);
const read = (user, topic, role) => asUser(user, topic, tx => tx.query('select topic,extension from realtime.messages'), role);

test('owners and invited members can receive and send presence and cursor broadcasts', async () => {
  const board = await room('owner-presence', 'guest-presence');
  for (const user of ['owner-presence', 'guest-presence']) {
    for (const extension of ['broadcast', 'presence']) await insert(user, board.topic, extension);
    const rows = (await read(user, board.topic)).rows;
    assert.ok(rows.some(row => row.extension === 'broadcast'));
    assert.ok(rows.some(row => row.extension === 'presence'));
    assert.ok(rows.every(row => row.topic === board.topic));
  }
});

test('nonmembers and anonymous users cannot subscribe or send to a private board', async () => {
  const board = await room('private-room-owner');
  await insert('private-room-owner', board.topic);
  for (const extension of ['broadcast', 'presence']) {
    await assert.rejects(insert('outsider', board.topic, extension), { code: '42501' });
    await assert.rejects(insert(null, board.topic, extension, board.topic, 'anon'), { code: '42501' });
  }
  assert.equal((await read('outsider', board.topic)).rows.length, 0);
  assert.equal((await read(null, board.topic, 'anon')).rows.length, 0);
  assert.equal((await read(null, board.topic)).rows.length, 0);
});

test('a member of two boards cannot use one topic authorization to read or write the other', async () => {
  const a = await room('owner-both', 'guest-both'), b = await room('owner-both', 'guest-both');
  await insert('owner-both', a.topic); await insert('owner-both', b.topic);
  assert.deepEqual((await read('guest-both', a.topic)).rows.map(row => row.topic), [a.topic]);
  await assert.rejects(insert('guest-both', a.topic, 'broadcast', b.topic), { code: '42501' });
  await assert.rejects(insert('guest-both', b.topic, 'presence', a.topic), { code: '42501' });
});

test('unrelated channels, private Muse topics, malformed UUIDs and other extensions stay denied', async () => {
  const board = await room('topic-owner');
  for (const topic of ['', 'muse-private', 'muse:topic-owner', 'board:muse-private', 'board:not-a-uuid', 'board:' + board.id + ':private', 'public:' + board.id, 'board:' + randomUUID()]) {
    assert.equal((await read('topic-owner', topic)).rows.length, 0);
    await assert.rejects(insert('topic-owner', topic), { code: '42501' });
  }
  await assert.rejects(insert('topic-owner', board.topic, 'postgres_changes'), { code: '42501' });
  await assert.rejects(asUser('topic-owner', board.topic, tx => tx.query("update realtime.messages set payload='{}'")), { code: '42501' });
});

test('removing membership revokes authorization at the next channel check', async () => {
  const board = await room('revocation-owner', 'revocation-guest');
  await insert('revocation-guest', board.topic);
  await db.query('delete from public.shared_board_members where board_id=$1 and user_id=$2', [board.id, 'revocation-guest']);
  assert.equal((await read('revocation-guest', board.topic)).rows.length, 0);
  await assert.rejects(insert('revocation-guest', board.topic), { code: '42501' });
  assert.ok((await read('revocation-owner', board.topic)).rows.length > 0);
});
