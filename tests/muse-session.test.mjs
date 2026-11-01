import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { refreshingSessionToken } from '../scripts/muse-session.mjs';
import { withMuseStorage, withMuseLease, writeFile } from '../scripts/muse-storage.mjs';
import { museDirectory } from '../scripts/muse-store.mjs';

function token(sub, sid, expires) {
  return 'header.' + Buffer.from(JSON.stringify({ sub, sid, exp: expires })).toString('base64url') + '.signature';
}

function fixture() {
  let time = 1_000_000, initialCalls = 0, refreshCalls = 0;
  const first = token('owner-a', 'session-a', time / 1000 + 60);
  const options = {
    userId: 'owner-a', sessionId: 'session-a', now: () => time,
    initialToken: async () => { initialCalls++; return first; },
    refreshToken: async () => { refreshCalls++; return token('owner-a', 'session-a', time / 1000 + 60); },
  };
  return { options, first, advance: ms => { time += ms; }, counts: () => ({ initialCalls, refreshCalls }) };
}

test('a long private operation refreshes its token before saving and releasing its lease', async () => {
  const f = fixture(), credentials = [];
  const getToken = refreshingSessionToken(f.options);
  const sdk = createClient('https://workspace.example.test', 'public-test-key', {
    accessToken: getToken, db: { retry: false },
    global: { fetch: async (url, init) => {
      credentials.push(new Headers(init.headers).get('Authorization'));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/acquire_muse_lease')) return Response.json(true);
      if (path.endsWith('/muse_private_files')) return Response.json(null);
      if (path.endsWith('/commit_muse_files')) {
        const body = JSON.parse(init.body);
        assert.equal(body.changes[0].name, 'avatar.json');
        assert.equal(body.held_leases[0].resource, 'avatar');
      }
      return new Response(null, { status: 204 });
    } },
  });
  await withMuseStorage('owner-a', sdk, () => withMuseLease('owner-a', 'avatar', async () => {
    f.advance(90_000);
    await writeFile(join(museDirectory('owner-a'), 'avatar.json'), '{"preview":"generated"}');
  }));
  assert.equal(credentials[0], 'Bearer ' + f.first);
  assert.notEqual(credentials[1], credentials[0]);
  assert.equal(new Set(credentials.slice(1)).size, 1);
  assert.deepEqual(f.counts(), { initialCalls: 1, refreshCalls: 1 });
});

test('concurrent requests within one operation share a refresh, and separate owners never share tokens', async () => {
  const f = fixture(), getToken = refreshingSessionToken(f.options);
  await getToken();
  f.advance(50_000);
  const values = await Promise.all(Array.from({ length: 12 }, getToken));
  assert.equal(new Set(values).size, 1);
  assert.deepEqual(f.counts(), { initialCalls: 1, refreshCalls: 1 });
  const other = refreshingSessionToken({ ...f.options, userId: 'owner-b', sessionId: 'session-b', initialToken: async () => token('owner-b', 'session-b', 1100) });
  assert.notEqual(await other(), values[0]);
});

test('missing, wrong-owner, expired, or revoked credentials cannot authorize a write', async () => {
  for (const initial of [null, 'invalid', token('other-owner', 'session-a', 1100), token('owner-a', 'other-session', 1100)]) {
    const f = fixture();
    await assert.rejects(refreshingSessionToken({ ...f.options, initialToken: async () => initial })(), { status: 401 });
  }
  const f = fixture();
  const revoked = refreshingSessionToken({ ...f.options, refreshToken: async () => null });
  await revoked();
  f.advance(90_000);
  await assert.rejects(revoked(), { status: 401 });
  const expired = refreshingSessionToken({ ...f.options, refreshToken: async () => f.first });
  await assert.rejects(expired(), { status: 401 });
});

test('a failed refresh never falls back to an expired token', async () => {
  const f = fixture();
  const getToken = refreshingSessionToken({ ...f.options, refreshToken: async () => { throw new Error('Authentication temporarily unavailable'); } });
  await getToken();
  f.advance(90_000);
  await assert.rejects(getToken(), /temporarily unavailable/);
});

test('the SDK session-error wrapper still produces a sign-in error without a database request', async () => {
  const sdk = createClient('https://workspace.example.test', 'public-test-key', {
    accessToken: refreshingSessionToken({ ...fixture().options, initialToken: async () => null }),
    global: { fetch: async () => { throw new Error('Must not send an anonymous request'); } },
  });
  await assert.rejects(withMuseStorage('owner-a', sdk, () => withMuseLease('owner-a', 'avatar', async () => {})), { status: 401 });
});
