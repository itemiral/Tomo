import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'muze-chat-stream-'));
const output = join(directory, 'chat.mjs');
await build({ entryPoints: ['src/components/muse/chat-request.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, define: { 'process.env.NODE_ENV': '"test"' } });
const { sendMuseChat } = await import(pathToFileURL(output));
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
function streaming(chunks, cancelled = () => {}) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk); controller.close(); }, cancel: cancelled }), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

test('fragmented UTF-8 events emit known statuses and return one complete result', async () => {
  const expected = { messages: [{ content: '你好 👋' }], actions: { cards: [], updates: [] } };
  const bytes = encoder.encode(JSON.stringify({ type: 'progress', phase: 'vision', thought: 'private reasoning' }) + '\n' + JSON.stringify({ type: 'progress', phase: 'unknown thought' }) + '\n' + JSON.stringify({ type: 'result', result: expected }));
  let request;
  globalThis.fetch = async (url, init) => { request = { url, init }; return streaming(Array.from(bytes, byte => Uint8Array.of(byte))); };
  const phases = []; const result = await sendMuseChat({ message: 'Inspect the drawing' }, signal(), phase => phases.push(phase));
  assert.deepEqual(result, expected); assert.deepEqual(phases, ['vision']);
  assert.equal(request.url, '/api/muse/chat'); assert.equal(request.init.headers.Accept, 'application/x-ndjson');
  assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.credentials, 'same-origin');
});

test('legacy JSON responses and HTTP errors retain their status', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ actions: { cards: [] } }), { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await sendMuseChat({}, signal(), () => assert.fail('JSON has no progress')), { actions: { cards: [] } });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Sign in again.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(sendMuseChat({}, signal(), () => {}), error => error.status === 401 && error.message === 'Sign in again.');
});

test('a result followed by an error never becomes a successful turn', async () => {
  globalThis.fetch = async () => streaming(['{"type":"result","result":{"partial":true}}\n', '{"type":"error","status":409,"error":"The board changed."}\n']);
  await assert.rejects(sendMuseChat({}, signal(), () => {}), error => error.status === 409 && error.message === 'The board changed.');
});

test('empty, interrupted and malformed streams fail instead of fabricating a reply', async () => {
  for (const chunks of [[], ['{"type":"progress","phase":"thinking"}\n'], ['not valid json\n']]) {
    globalThis.fetch = async () => streaming(chunks);
    await assert.rejects(sendMuseChat({}, signal(), () => {}));
  }
});

test('excessive stream output is cancelled before parsing or applying it', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('x'.repeat(4_000_001))); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  await assert.rejects(sendMuseChat({}, signal(), () => {}), error => error.status === 502 && /too much data/.test(error.message));
  assert.equal(cancelled, true);
});

test('aborting the response propagates cancellation and never returns an earlier partial result', async () => {
  const controller = new AbortController(), reason = new DOMException('Cancelled', 'AbortError');
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(encoder.encode('{"type":"result","result":{"partial":true}}\n'));
    init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true });
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const request = sendMuseChat({}, controller.signal, () => {}); controller.abort(reason);
  await assert.rejects(request, error => error === reason);
});
