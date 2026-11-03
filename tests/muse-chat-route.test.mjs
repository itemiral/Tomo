import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'muze-chat-route-'));
process.env.MUZE_PRIVATE_DIR = join(directory, 'private');
process.env.MUZE_STORAGE = 'supabase';
const scope = new AsyncLocalStorage(), queries = [];
const fixture = globalThis.muzeRouteFixture = {
  scope,
  ask: async () => ({ messages: [], actions: { cards: [], updates: [] } }),
  client(ownerId) {
    return { from(table) {
      assert.equal(table, 'muse_private_files'); const filters = {};
      return { select() { return this; }, eq(key, value) { filters[key] = value; return this; }, async maybeSingle() {
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(filters.owner_id, ownerId); queries.push({ ownerId, ...filters });
        return { data: { name: filters.name, content: Buffer.from('memory-for-' + ownerId).toString('base64'), version: 'fixture', updated_at: '2026-11-01' }, error: null };
      } };
    } };
  },
};
const mocks = {
  '@clerk/nextjs/server': `export async function auth() { const userId=globalThis.muzeRouteFixture.scope.getStore(); return {userId,sessionId:'fixture-session',getToken:async()=>'fixture-token'}; }`,
  '@/utils/supabase/shared': `export function createAuthenticatedClient() { return globalThis.muzeRouteFixture.client(globalThis.muzeRouteFixture.scope.getStore()); }`,
  '@/utils/supabase/session': `export function serverSessionToken(_owner,_session,getToken) { return getToken; }`,
  '@/server/muse/model': `export function askMuse(...args) { return globalThis.muzeRouteFixture.ask(...args); }`,
};
const bundle = await build({ stdin: { contents: `export {POST} from './src/app/api/muse/chat/route'; export {PrivateError} from './src/server/muse/private';`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'route-boundaries', setup(builder) {
  builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'empty', namespace: 'route-test' }));
  builder.onResolve({ filter: /^(?:@clerk\/nextjs\/server|@\/utils\/supabase\/(?:shared|session)|@\/server\/muse\/model)$/ }, args => ({ path: args.path, namespace: 'route-test' }));
  builder.onLoad({ filter: /.*/, namespace: 'route-test' }, args => ({ contents: mocks[args.path] || '' }));
  builder.onResolve({ filter: /^(?:sharp|next\/server)$/ }, args => ({ path: require.resolve(args.path), external: true }));
  builder.onResolve({ filter: /\.mjs$/ }, args => ({ path: resolve(args.resolveDir, args.path), external: true }));
} }] });
const output = join(directory, 'route.mjs'); await writeFile(output, bundle.outputFiles[0].text);
const { POST, PrivateError } = await import(pathToFileURL(output));
const { readFile } = await import('../scripts/muse-storage.mjs');
const { museDirectory } = await import('../scripts/muse-store.mjs');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Route tests must not make real network requests');
after(async () => { globalThis.fetch = originalFetch; delete globalThis.muzeRouteFixture; await rm(directory, { recursive: true, force: true }); });
function request(options = {}) {
  return new Request('http://localhost:3201/api/muse/chat', { method: 'POST', headers: { Host: 'localhost:3201', Origin: 'http://localhost:3201', 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...options.headers }, body: JSON.stringify({ thread: 'board:page', message: 'A useful request' }), signal: options.signal });
}
const post = (owner, options) => scope.run(owner, () => POST(request(options)));
const events = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('streaming keeps private no-store headers and emits progress before its atomic result', async () => {
  const gate = deferred(); let finished = false;
  fixture.ask = async (_owner, _body, _signal, _effort, progress) => {
    progress('context'); await gate.promise; progress('thinking'); progress('saving'); finished = true;
    return { messages: [{ id: 'answer', role: 'assistant', content: 'One useful result.' }], actions: { cards: [], updates: [] } };
  };
  const response = await post('owner-one');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('vary'), /Cookie.*Authorization/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const reader = response.body.getReader(), first = await reader.read();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)), { type: 'progress', phase: 'context' });
  assert.equal(finished, false); gate.resolve();
  const remaining = []; while (true) { const chunk = await reader.read(); if (chunk.done) break; remaining.push(new TextDecoder().decode(chunk.value)); }
  const values = remaining.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(values.map(event => event.type), ['progress', 'progress', 'result']);
  assert.deepEqual(values.slice(0, 2), [{ type: 'progress', phase: 'thinking' }, { type: 'progress', phase: 'saving' }]);
  assert.equal(values.at(-1).result.messages[0].content, 'One useful result.');
});

test('stream errors contain only the safe error and never a partial result', async () => {
  for (const [error, status, text] of [[new PrivateError(503, 'Muse is busy. Try again.'), 503, 'Muse is busy. Try again.'], [new Error('PRIVATE_DATABASE_DETAILS'), 500, 'Could not open your Muse files. Try again.']]) {
    fixture.ask = async (_owner, _body, _signal, _effort, progress) => { progress('thinking'); throw error; };
    const result = await events(await post('owner-one'));
    assert.deepEqual(result, [{ type: 'progress', phase: 'thinking' }, { type: 'error', status, error: text }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DATABASE_DETAILS|stack/);
  }
});

test('consumer cancellation aborts generation and finishes the stream task', async () => {
  const stopped = deferred(); let seenSignal;
  fixture.ask = async (_owner, _body, signal, _effort, progress) => {
    seenSignal = signal; progress('thinking');
    try { await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    finally { stopped.resolve(); }
  };
  const response = await post('owner-one'), reader = response.body.getReader(); await reader.read();
  await reader.cancel(); await stopped.promise; assert.equal(seenSignal.aborted, true);
});

test('concurrent streamed requests preserve real owner storage scopes after awaiting', async () => {
  const gates = { 'owner-one': deferred(), 'owner-two': deferred() }; queries.length = 0;
  fixture.ask = async (owner, _body, _signal, _effort, progress) => {
    progress('context'); await gates[owner].promise;
    const memory = await readFile(join(museDirectory(owner), 'memory.md'), 'utf8');
    const otherOwner = owner === 'owner-one' ? 'owner-two' : 'owner-one';
    await assert.rejects(readFile(join(museDirectory(otherOwner), 'memory.md'), 'utf8'), error => error.status === 403);
    progress('saving'); return { messages: [{ content: memory }], actions: { cards: [], updates: [] } };
  };
  const [first, second] = await Promise.all([post('owner-one'), post('owner-two')]);
  gates['owner-two'].resolve(); const secondEvents = await events(second);
  gates['owner-one'].resolve(); const firstEvents = await events(first);
  assert.equal(firstEvents.at(-1).result.messages[0].content, 'memory-for-owner-one');
  assert.equal(secondEvents.at(-1).result.messages[0].content, 'memory-for-owner-two');
  assert.deepEqual(queries.map(query => query.owner_id), ['owner-two', 'owner-one']);
});

test('authentication, origin and JSON compatibility remain outside the progress stream', async () => {
  let calls = 0; fixture.ask = async () => { calls++; return { messages: [], actions: { cards: [], updates: [] } }; };
  const signedOut = await post(null); assert.equal(signedOut.status, 401); assert.match(signedOut.headers.get('content-type'), /application\/json/);
  const foreign = await post('owner-one', { headers: { Origin: 'https://unrelated.example' } }); assert.equal(foreign.status, 403);
  assert.equal(calls, 0);
  const response = await post('owner-one', { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { messages: [], actions: { cards: [], updates: [] } }); assert.equal(calls, 1);
});
