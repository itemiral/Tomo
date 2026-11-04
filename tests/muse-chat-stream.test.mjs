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
const { sendMuseChat, MuseStopError } = await import(pathToFileURL(output));
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

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const firstId='a64c57c3-610b-4ac5-a193-788abde6584d',nextId='baa1b698-b802-478a-9113-233e71cf34e0';
const emptyResult={messages:[],actions:{cards:[],updates:[]}};
function pendingStream(init,started){return new Response(new ReadableStream({start(controller){started(controller);init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}}),{headers:{'Content-Type':'application/x-ndjson'}});}

test('Stop releases the exact server request before a rapid next send starts',async()=>{
 const abort=new AbortController(),cancelGate=deferred(),calls=[];let firstSignal;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(init.body);calls.push({method:init.method,...body});
  if(init.method==='DELETE'){await cancelGate.promise;return new Response('{}');}
  if(body.requestId===firstId){firstSignal=init.signal;return pendingStream(init,stream=>stream.enqueue(encoder.encode('{"type":"progress","phase":"thinking"}\n')));}
  return streaming([JSON.stringify({type:'result',result:emptyResult})+'\n']);
 };
 const first=sendMuseChat({requestId:firstId},abort.signal,()=>{});const rejected=assert.rejects(first,{name:'AbortError'});await tick();abort.abort();
 const next=sendMuseChat({requestId:nextId},signal(),()=>{});await tick();
 assert.deepEqual(calls.map(call=>[call.method,call.requestId]),[['POST',firstId],['DELETE',firstId]]);
 assert.equal(firstSignal.aborted,false,'keep the transport until cancellation is acknowledged');
 cancelGate.resolve();await rejected;assert.deepEqual(await next,emptyResult);
 assert.equal(firstSignal.aborted,true);assert.equal(calls.at(-1).requestId,nextId);
});

test('Stop before first progress waits for acquisition without losing the acknowledgment reader',async()=>{
 const abort=new AbortController(),calls=[];let firstStream;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(init.body);calls.push({method:init.method,...body});
  if(init.method==='DELETE')return new Response('{}');
  if(body.requestId===firstId)return pendingStream(init,stream=>{firstStream=stream;});
  return streaming([JSON.stringify({type:'result',result:emptyResult})]);
 };
 const first=sendMuseChat({requestId:firstId},abort.signal,()=>assert.fail('Stopped progress is not visible'));const rejected=assert.rejects(first,{name:'AbortError'});await tick();abort.abort();
 const next=sendMuseChat({requestId:nextId},signal(),()=>{});await tick();assert.equal(calls.length,1);
 firstStream.enqueue(encoder.encode('{"type":"progress","phase":"context"}\n'));
 await rejected;assert.deepEqual(await next,emptyResult);
 assert.deepEqual(calls.map(call=>[call.method,call.requestId]),[['POST',firstId],['DELETE',firstId],['POST',nextId]]);
});

test('an authentication failure before acknowledgment does not leave the next send waiting',async()=>{
 const abort=new AbortController(),gate=deferred();let posts=0;
 globalThis.fetch=async(_url,init)=>{
  assert.equal(init.method,'POST');
  if(++posts===1){await gate.promise;return new Response('{"error":"Sign in again."}',{status:401,headers:{'Content-Type':'application/json'}});}
  return streaming([JSON.stringify({type:'result',result:emptyResult})]);
 };
 const first=sendMuseChat({requestId:firstId},abort.signal,()=>{});const rejected=assert.rejects(first);await tick();abort.abort();
 const next=sendMuseChat({requestId:nextId},signal(),()=>{});gate.resolve();await rejected;assert.deepEqual(await next,emptyResult);assert.equal(posts,2);
});

test('failed cancellation is factual and a following send retries the same token before starting',async()=>{
 const abort=new AbortController();let deletes=0,posts=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(init.body);
  if(init.method==='DELETE'){assert.equal(body.requestId,firstId);return new Response('{}',{status:++deletes===1?503:200});}
  if(++posts===1)return pendingStream(init,stream=>stream.enqueue(encoder.encode('{"type":"progress","phase":"context"}\n')));
  return streaming([JSON.stringify({type:'result',result:emptyResult})]);
 };
 const first=sendMuseChat({requestId:firstId},abort.signal,()=>{});const rejected=assert.rejects(first,error=>error instanceof MuseStopError);await tick();abort.abort();await rejected;
 assert.equal(posts,1);assert.equal(deletes,1);
 assert.deepEqual(await sendMuseChat({requestId:nextId},signal(),()=>{}),emptyResult);assert.equal(deletes,2);assert.equal(posts,2);
});

test('a missing acknowledgment has a bounded failure and still cancels safely when it eventually arrives',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const abort=new AbortController(),calls=[];let firstStream;
 globalThis.fetch=async(_url,init)=>{
  calls.push(init.method);
  if(init.method==='DELETE')return new Response('{}');
  return pendingStream(init,stream=>{firstStream=stream;});
 };
 const first=sendMuseChat({requestId:firstId},abort.signal,()=>{});const rejected=assert.rejects(first,error=>error instanceof MuseStopError);await tick();abort.abort();
 await tick();t.mock.timers.tick(8001);await rejected;assert.deepEqual(calls,['POST']);
 firstStream.enqueue(encoder.encode('{"type":"progress","phase":"context"}\n'));await tick();assert.deepEqual(calls,['POST','DELETE']);
 t.mock.timers.reset();
});
