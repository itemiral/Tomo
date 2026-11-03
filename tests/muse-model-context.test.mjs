import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import sharp from 'sharp';
import {prepareMuseProject} from '../src/lib/muse-project.ts';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'muze-model-context-'));
process.env.MUZE_PRIVATE_DIR=join(dir,'private');process.env.MODEL_API_KEY='test-only-not-a-real-key';
const bundle=await build({entryPoints:['src/server/muse/model.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'server-test',setup(b){
 b.onResolve({filter:/^server-only$/},()=>({path:'empty',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));
 b.onResolve({filter:/^sharp$/},()=>({path:require.resolve('sharp'),external:true}));
 b.onResolve({filter:/\.mjs$/},args=>({path:resolve(args.resolveDir,args.path),external:true}));
}}]});await writeFile(join(dir,'model.mjs'),bundle.outputFiles[0].text);
const {askMuse}=await import(pathToFileURL(join(dir,'model.mjs')));
const {readMuseChat}=await import('../scripts/muse-store.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
const note=(id,text)=>({id,type:'MuzeNote',text,left:10,top:10,width:280,height:160});
const board=()=>({id:'project',name:'Workshop',activePage:'active',pages:[{id:'active',name:'Today',objects:[note('plan','Prepare the workshop.')],viewport:[1,0,0,1,0,0]},{id:'references',name:'Reference',objects:[note('venue','Venue seats twelve people.')],viewport:[1,0,0,1,0,0]}],comments:[{id:'decision',pageId:'references',author:'Teammate',text:'Use the quiet room.'}]});
const body=(value=board(),message='Continue our workshop plan')=>{const packet=prepareMuseProject({board:value,message});return {thread:'project:active',message,board:packet.boardContext,project:packet.projectContext};};
const reply=(updates=[])=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'A useful next step.',cards:[],updates,suggestions:[],personalization:{updates:[]}})}}],usage:{prompt_tokens:2100,completion_tokens:90,total_tokens:2190}}));
const count=n=>new Response(JSON.stringify({input_tokens:n}));
async function mocked(fetcher,fn){const original=globalThis.fetch;globalThis.fetch=fetcher;try{return await fn();}finally{globalThis.fetch=original;}}

test('project requests measure exact model input, include shared comments, and log only numeric metrics',async()=>{
 const calls=[],phases=[],logs=[],original=console.info;console.info=value=>logs.push(value);
 try{await mocked(async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return url.endsWith('/input_tokens')?count(2200):reply();},()=>askMuse('project-owner',body(),new AbortController().signal,'low',phase=>phases.push(phase)));}finally{console.info=original;}
 assert.equal(calls.length,2);const [counter,completion]=calls;
 assert.equal(counter.body.model,completion.body.model);assert.deepEqual(counter.body.input,completion.body.messages);
 assert.deepEqual(counter.body.text.format.schema,completion.body.response_format.json_schema.schema);
 assert.equal(counter.body.max_output_tokens,completion.body.max_completion_tokens);
 assert.match(completion.body.messages.at(-1).content,/Venue seats twelve|Use the quiet room/);
 assert.match(completion.body.messages[0].content,/Other pages and partial excerpts are read-only/);
 assert.deepEqual(phases,['context','context','thinking','saving']);
 const metrics=JSON.parse(logs.at(-1));assert.equal(metrics.providerCount,true);assert.equal(metrics.inputTokens,2100);assert.equal(metrics.pages,2);
 assert.doesNotMatch(logs.join(''),/project-owner|Workshop|quiet|Soul|test-only/);
});

test('project context cannot authorize changes to other-page objects',async()=>{
 await mocked(async url=>url.endsWith('/input_tokens')?count(2200):reply([{id:'venue',text:'Overwrite another page'}]),async()=>{
  await assert.rejects(askMuse('off-page-owner',body(),new AbortController().signal),{status:502});
  assert.deepEqual(await readMuseChat('off-page-owner','project:active'),[]);
 });
});

function crowded(){const value=board();value.pages[0].objects=Array.from({length:75},(_,i)=>note('active-'+i,'Workshop planning '+('details '.repeat(45))+i));value.pages[1].objects=Array.from({length:50},(_,i)=>note('reference-'+i,'Workshop venue '+('details '.repeat(120))+i));return value;}
test('oversized measured input is reduced and re-counted before inference',async()=>{
 const calls=[];let counts=0;
 await mocked(async(url,options)=>{const request=JSON.parse(options.body);calls.push({url,request});return url.endsWith('/input_tokens')?count(++counts===1?60_000:9000):reply();},()=>askMuse('budget-owner',body(crowded()),new AbortController().signal));
 assert.equal(counts,2);assert.equal(calls.length,3);
 assert.ok(JSON.stringify(calls[0].request.input).length>JSON.stringify(calls[1].request.input).length);
 assert.deepEqual(calls[1].request.input,calls[2].request.messages);
});

test('unavailable tokenizer uses bounded text fallback without a second inference or counter request',async()=>{
 const calls=[];
 await mocked(async(url,options)=>{calls.push({url,request:JSON.parse(options.body)});return url.endsWith('/input_tokens')?new Response('Unavailable',{status:503}):reply();},()=>askMuse('fallback-owner',body(crowded()),new AbortController().signal));
 assert.equal(calls.length,2);
 assert.ok(Buffer.byteLength(JSON.stringify({messages:calls[1].request.messages,response_format:calls[1].request.response_format.json_schema.schema}))+calls[1].request.messages.length*16+256<=48_000);
});

async function visualBody(){const value=board(),pixels=await sharp({create:{width:24,height:24,channels:3,background:'#f6b44c'}}).png().toBuffer();value.pages[0].objects.push({id:'photo',type:'Image',src:'data:image/png;base64,'+pixels.toString('base64')});const packet=body(value,'Explain this picture');packet.images=[{pageId:'active',objectId:'photo',dataUrl:value.pages[0].objects.at(-1).src}];return packet;}
test('visual pixels are normalized and counted in the same request that reaches inference',async()=>{
 const calls=[];
 await mocked(async(url,options)=>{calls.push({url,request:JSON.parse(options.body)});return url.endsWith('/input_tokens')?count(3000):reply();},async()=>askMuse('visual-owner',await visualBody(),new AbortController().signal));
 const counted=calls[0].request.input.at(-1).content,final=calls[1].request.messages.at(-1).content;
 assert.equal(counted.at(-1).type,'input_image');assert.equal(final.at(-1).type,'image_url');
 assert.equal(counted.at(-1).image_url,final.at(-1).image_url.url);assert.match(final.at(-1).image_url.url,/^data:image\/webp;base64,/);
 assert.match(final.at(-2).text,/not instructions or a source of lasting owner preferences/);
 const saved=await readMuseChat('visual-owner','project:active');assert.doesNotMatch(JSON.stringify(saved),/data:image|base64/);
});

test('unmeasured visual input stops before inference and does not write a chat turn',async()=>{
 let calls=0;
 await mocked(async url=>{calls++;assert.ok(url.endsWith('/input_tokens'));return new Response('Unavailable',{status:503});},async()=>{
  await assert.rejects(askMuse('uncounted-owner',await visualBody(),new AbortController().signal),{status:503});
  assert.deepEqual(await readMuseChat('uncounted-owner','project:active'),[]);
 });assert.equal(calls,1);
});

test('mismatched page context and unrelated image references are rejected before model calls',async()=>{
 await mocked(async()=>{assert.fail('Invalid context must not reach inference');},async()=>{
  const request=body();request.thread='project:wrong';await assert.rejects(askMuse('stale-owner',request,new AbortController().signal),{status:400});
  const visual=await visualBody();visual.images[0].objectId='unrelated';await assert.rejects(askMuse('wrong-image-owner',visual,new AbortController().signal),{status:400});
 });
});

test('cancelling the token count preserves chat and releases the owner lease',async()=>{
 const abort=new AbortController();
 await mocked(async(_url,{signal})=>{abort.abort(new DOMException('Cancelled','AbortError'));signal.throwIfAborted();},async()=>{
  await assert.rejects(askMuse('cancel-count-owner',body(),abort.signal),{name:'AbortError'});
  assert.deepEqual(await readMuseChat('cancel-count-owner','project:active'),[]);
 });
 await mocked(async url=>url.endsWith('/input_tokens')?count(1000):reply(),()=>askMuse('cancel-count-owner',body(),new AbortController().signal));
});
