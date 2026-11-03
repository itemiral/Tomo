import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const directory=await mkdtemp(join(tmpdir(),'muze-board-request-'));
const output=join(directory,'request.cjs');
await build({entryPoints:['src/components/muze/use-shared-board.ts'],bundle:true,platform:'node',format:'cjs',outfile:output});
const {boardRequest}=createRequire(import.meta.url)(output);
after(()=>rm(directory,{recursive:true,force:true}));
const path='/1d6e0a20-9095-4bd3-a826-f53c6d9cd480';
const aborted=signal=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
async function fixture(fetcher,run){const original=globalThis.fetch,timeout=AbortSignal.timeout,controller=new AbortController();let limit;
 globalThis.fetch=fetcher;AbortSignal.timeout=milliseconds=>{limit=milliseconds;return controller.signal;};
 try{return await run(controller,()=>limit);}finally{globalThis.fetch=original;AbortSignal.timeout=timeout;}
}

test('a stalled board request times out instead of blocking all later saves',async()=>{
 await fixture(async(_url,{signal})=>aborted(signal),async(timeout,limit)=>{
  const request=boardRequest(path,{method:'PUT',body:'{}'});timeout.abort(new DOMException('Deadline','TimeoutError'));
  await assert.rejects(request,error=>error.status===504&&/took too long/.test(error.message));assert.equal(limit(),15000);
 });
});

test('owner cancellation remains cancellation rather than a timeout message',async()=>{
 await fixture(async(_url,{signal})=>aborted(signal),async()=>{
  const controller=new AbortController(),request=boardRequest(path,{signal:controller.signal});controller.abort();
  await assert.rejects(request,{name:'AbortError'});
 });
});

test('the timeout also covers a response whose JSON body stops arriving',async()=>{
 let started;
 const reading=new Promise(resolve=>started=resolve);
 await fixture(async(_url,{signal})=>({ok:true,json:()=>{started();return aborted(signal);}}),async timeout=>{
  const request=boardRequest(path);await reading;timeout.abort(new DOMException('Deadline','TimeoutError'));
  await assert.rejects(request,error=>error.status===504);
 });
});

test('malformed successful snapshots fail explicitly instead of leaving the board loading forever',async()=>{
 for(const body of ['{}','null','[]','not json'])await fixture(async()=>new Response(body),async()=>{
  await assert.rejects(boardRequest(path),/could not be read/);
 });
 await fixture(async()=>new Response('{}'),async()=>{await assert.rejects(boardRequest(''),/could not be read/);});
});
