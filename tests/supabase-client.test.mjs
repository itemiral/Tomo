import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedClient } from '../src/utils/supabase/shared.ts';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const clients = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.removeAllChannels()));
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey;
});

function fixture() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://workspace.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fixture';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers), cache: options.cache });
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  };
  return {
    requests,
    client(getToken) {
      const client = createAuthenticatedClient(getToken);
      clients.push(client);
      return client;
    },
  };
}

test('database requests use refreshed Clerk tokens and never cache private responses', async () => {
  const { client, requests } = fixture();
  let token = 'first-session-token';
  const supabase = client(async () => token);
  assert.equal((await supabase.from('boards').select('id')).error, null);
  token = 'refreshed-session-token';
  assert.equal((await supabase.from('boards').select('id')).error, null);
  assert.deepEqual(requests.map(request => request.headers.get('Authorization')), [
    'Bearer first-session-token', 'Bearer refreshed-session-token',
  ]);
  assert.ok(requests.every(request => request.headers.get('apikey') === 'sb_publishable_fixture'));
  assert.ok(requests.every(request => request.cache === 'no-store'));
});

test('separate owners keep independent credentials during concurrent queries', async () => {
  const { client, requests } = fixture();
  const a = client(async () => 'owner-a-token');
  const b = client(async () => 'owner-b-token');
  await Promise.all([a.from('notes').select('id'), b.from('notes').select('id')]);
  assert.deepEqual(requests.map(request => request.headers.get('Authorization')).sort(), [
    'Bearer owner-a-token', 'Bearer owner-b-token',
  ]);
});

test('an expired Clerk session stops queries before sending an anonymous request', async () => {
  const { client, requests } = fixture();
  let token = 'signed-in-token';
  const supabase = client(async () => token);
  await supabase.from('notes').select('id');
  requests.length = 0;
  token = null;
  const result = await supabase.from('notes').select('id');
  assert.match(result.error.message, /Sign in to access your workspace/);
  assert.equal(requests.length, 0);
});

test('missing configuration fails before contacting a database', () => {
  const { requests } = fixture();
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert.throws(() => createAuthenticatedClient(async () => 'token'), /Supabase is not configured/);
  assert.equal(requests.length, 0);
});
