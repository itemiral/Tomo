import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {prepareMuseProject} from '../src/lib/muse-project.ts';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'muze-chat-route-'));
process.env.MUZE_PRIVATE_DIR = join(directory, 'private');
process.env.MUZE_STORAGE = 'supabase';
const scope = new AsyncLocalStorage(), queries = [];
const fixture = globalThis.muzeRouteFixture = {
  scope,
  leaseCalls: [],
  leaseAction: async () => ({data:{expiresAt:new Date(Date.now()+90000).toISOString()},error:null}),
  sharedScene: null,
  ask: async () => ({ messages: [], actions: { cards: [], updates: [] } }),
  cancel: async () => {},
  client(ownerId) {
    return { async rpc(name,args) { assert.equal(name,'shared_board_lease');fixture.leaseCalls.push({ownerId,...args});return fixture.leaseAction(args); }, from(table) {
      if(table==='shared_boards')return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{scene:fixture.sharedScene},error:null};}};
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
  '@/utils/supabase/shared': `export class SupabaseSessionError extends Error {} export function createAuthenticatedClient() { return globalThis.muzeRouteFixture.client(globalThis.muzeRouteFixture.scope.getStore()); }`,
  '@/utils/supabase/session': `export function serverSessionToken(_owner,_session,getToken) { return getToken; }`,
  '@/server/muse/model': `export function askMuse(...args) { return globalThis.muzeRouteFixture.ask(...args); } export function cancelMuseChat(...args) { return globalThis.muzeRouteFixture.cancel(...args); }`,
};
const bundle = await build({ stdin: { contents: `export {POST,DELETE} from './src/app/api/muse/chat/route'; export {PrivateError} from './src/server/muse/private';`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'route-boundaries', setup(builder) {
  builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'empty', namespace: 'route-test' }));
  builder.onResolve({ filter: /^(?:@clerk\/nextjs\/server|@\/utils\/supabase\/(?:shared|session)|@\/server\/muse\/model)$/ }, args => ({ path: args.path, namespace: 'route-test' }));
  builder.onLoad({ filter: /.*/, namespace: 'route-test' }, args => ({ contents: mocks[args.path] || '' }));
  builder.onResolve({ filter: /^(?:sharp|next\/server)$/ }, args => ({ path: require.resolve(args.path), external: true }));
  builder.onResolve({ filter: /\.mjs$/ }, args => ({ path: resolve(args.resolveDir, args.path), external: true }));
} }] });
const output = join(directory, 'route.mjs'); await writeFile(output, bundle.outputFiles[0].text);
const { POST, DELETE, PrivateError } = await import(pathToFileURL(output));
const { readFile } = await import('../scripts/muse-storage.mjs');
const { museDirectory } = await import('../scripts/muse-store.mjs');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Route tests must not make real network requests');
after(async () => { globalThis.fetch = originalFetch; delete globalThis.muzeRouteFixture; await rm(directory, { recursive: true, force: true }); });
function request(options = {}) {
  return new Request('http://localhost:3201/api/muse/chat', { method: 'POST', headers: { Host: 'localhost:3201', Origin: 'http://localhost:3201', 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...options.headers }, body: JSON.stringify({ thread: 'board:page', message: 'A useful request',...options.body }), signal: options.signal });
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

test('explicit cancellation requires the owner session and same origin, and awaits the exact request release', async () => {
  const gate=deferred(),calls=[],requestId='4a468f80-a4fe-4027-b6cd-a663df1095d5';
  fixture.cancel=async(owner,id)=>{calls.push({owner,id});await gate.promise;};
  const stop=(owner,origin='http://localhost:3201')=>scope.run(owner,()=>DELETE(new Request('http://localhost:3201/api/muse/chat',{method:'DELETE',headers:{Host:'localhost:3201',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({requestId})})));
  assert.equal((await stop(null)).status,401);assert.equal((await stop('owner-one','https://unrelated.example')).status,403);
  assert.equal(calls.length,0);
  let completed=false;const result=stop('owner-two').then(response=>{completed=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(completed,false);assert.deepEqual(calls,[{owner:'owner-two',id:requestId}]);
  gate.resolve();const response=await result;assert.equal(response.status,200);assert.deepEqual(await response.json(),{stopped:true});assert.match(response.headers.get('cache-control'),/private.*no-store/);
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

const sharedBody=()=>({thread:'1d6e0a20-9095-4bd3-a826-f53c6d9cd480:page',sharedBoardId:'1d6e0a20-9095-4bd3-a826-f53c6d9cd480',requestId:'4a468f80-a4fe-4027-b6cd-a663df1095d5',board:JSON.stringify({board:'Shared',page:'Page',objects:[{id:'note',type:'MuzeNote',text:'Shared task',editable:true}],selectedIds:['note']})});
test('the first planning turn on empty and blank-note shared boards reaches the owner Muse and streams its cards',async()=>{
 const message='can you help me make a trip to Tokyo for 2 people, me and my girlfriend';
 for(const objects of [[],[{id:'blank-note',type:'MuzeNote',text:'',editable:true}]]){
  const body={...sharedBody(),message,board:JSON.stringify({board:'Trip to Tokyo',page:'Page',objects,selectedIds:[]})};
  fixture.leaseCalls.length=0;fixture.leaseAction=async()=>({data:{},error:null});queries.length=0;
  const cards=[{id:'tokyo-first',title:'Tokyo together',body:'Start with your dates and the pace you want.'}];
  fixture.ask=async(owner,received,signal,effort,progress)=>{
   assert.equal(owner,'owner-two');assert.equal(scope.getStore(),'owner-two');
   assert.equal(received.message,message);assert.equal(received.thread,body.thread);
   assert.deepEqual(JSON.parse(received.board).objects,objects);
   assert.equal(effort,'low');assert.equal(signal.aborted,false);
   assert.deepEqual(fixture.leaseCalls.map(call=>call.operation),['acquire']);
   progress('context');
   const memory=await readFile(join(museDirectory(owner),'memory.md'),'utf8');
   assert.equal(memory,'memory-for-owner-two');
   progress('thinking');
   return {messages:[{id:'first-answer',role:'assistant',content:'A starting point for your Tokyo trip.'}],actions:{cards,updates:[]}};
  };
  const response=await post('owner-two',{body});
  assert.equal(response.status,200);
  const result=await events(response);
  assert.deepEqual(result.map(event=>event.type),['progress','progress','result']);
  assert.deepEqual(result.at(-1).result.actions.cards,cards);
  assert.deepEqual(queries.map(query=>query.owner_id),['owner-two']);
  assert.deepEqual(fixture.leaseCalls.map(call=>[call.ownerId,call.operation]),[['owner-two','acquire'],['owner-two','renew']]);
  assert.deepEqual(fixture.leaseCalls[0].objects,objects.map(object=>({pageId:'page',objectId:object.id})));
  assert(fixture.leaseCalls.every(call=>call.board_id===body.sharedBoardId&&call.request_id===body.requestId));
  assert.doesNotMatch(JSON.stringify(fixture.leaseCalls),/Tokyo|girlfriend|memory-for-|soul\.md/);
 }
});
test('shared requests acquire protection before model use and renew it through browser application',async()=>{
 fixture.leaseCalls.length=0;fixture.leaseAction=async()=>({data:{},error:null});
 fixture.ask=async()=>{assert.deepEqual(fixture.leaseCalls.map(call=>call.operation),['acquire']);return {messages:[],actions:{cards:[],updates:[]}};};
 const result=await events(await post('owner-one',{body:sharedBody()}));assert.equal(result.at(-1).type,'result');assert.deepEqual(fixture.leaseCalls.map(call=>call.operation),['acquire','renew']);
 assert.deepEqual(fixture.leaseCalls[0].objects,[{pageId:'page',objectId:'note'}]);assert.doesNotMatch(JSON.stringify(fixture.leaseCalls),/Shared task|memory-for-|soul\.md/);
});
test('failed model requests release shared protection and missing notes prevent model invocation',async()=>{
 fixture.leaseCalls.length=0;fixture.ask=async()=>{throw new PrivateError(503,'Muse is busy.');};
 let result=await events(await post('owner-one',{body:sharedBody()}));assert.equal(result.at(-1).type,'error');assert.deepEqual(fixture.leaseCalls.map(call=>call.operation),['acquire','release']);
 fixture.leaseCalls.length=0;fixture.leaseAction=async()=>({data:null,error:{code:'PT409',message:'Some notes changed before Muse started. Reading the board again.'}});fixture.ask=async()=>assert.fail('Missing referenced notes must stop the model call');
 result=await events(await post('owner-one',{body:sharedBody()}));assert.equal(result.at(-1).status,409);assert.deepEqual(fixture.leaseCalls.map(call=>call.operation),['acquire']);fixture.leaseAction=async()=>({data:{},error:null});
});
test('stream cancellation releases only the current owner request lease',async()=>{
 fixture.leaseCalls.length=0;const stopped=deferred();
 fixture.ask=async(_owner,_body,signal,_effort,progress)=>{progress('thinking');try{await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}finally{stopped.resolve();}};
 const response=await post('owner-two',{body:sharedBody()}),reader=response.body.getReader();await reader.read();await reader.cancel();await stopped.promise;
 await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(fixture.leaseCalls.map(call=>[call.ownerId,call.operation]),[['owner-two','acquire'],['owner-two','release']]);
});

test('visual previews protect their full page beyond the text limit without locking other pages',async()=>{
 const body=sharedBody();const scene={id:body.sharedBoardId,name:'Shared',activePage:'page',pages:[{id:'page',name:'Page',objects:Array.from({length:160},(_,index)=>({id:'shape-'+index,type:'MuzeShape',left:index*30,top:0,width:20,height:20})),viewport:[1,0,0,1,0,0]},{id:'unrelated',name:'Other page',objects:[{id:'unrelated-note',type:'MuzeNote',text:'Different task'}],viewport:[1,0,0,1,0,0]}]};
 const prepared=prepareMuseProject({board:scene,message:'Look at this diagram'}),project=JSON.parse(prepared.projectContext);project.images=[{pageId:'page',objectId:'scene-preview',selected:false,reason:'visual-region',kind:'scene'}];project.coverage.images={total:1,included:1,omitted:0};project.excerpts=[];project.coverage.objects.excerpts=0;
 fixture.sharedScene=scene;fixture.leaseCalls.length=0;fixture.ask=async()=>({messages:[],actions:{cards:[],updates:[]}});
 const result=await events(await post('owner-one',{body:{...body,board:prepared.boardContext,project:JSON.stringify(project)}}));assert.equal(result.at(-1).type,'result');
 assert.equal(fixture.leaseCalls[0].objects.length,160);assert(fixture.leaseCalls[0].objects.some(item=>item.objectId==='shape-159'));assert(fixture.leaseCalls[0].objects.every(item=>item.pageId==='page'));fixture.sharedScene=null;
});
