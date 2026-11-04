import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import sharp from 'sharp';
const require=createRequire(import.meta.url),dir=await mkdtemp(join(tmpdir(),'muse-tool-orchestration-'));
process.env.MUZE_PRIVATE_DIR=join(dir,'private');process.env.MODEL_API_KEY='synthetic-test-key';
const bundle=await build({entryPoints:['src/server/muse/model.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'test',setup(b){b.onResolve({filter:/^sharp$/},()=>({path:require.resolve('sharp'),external:true}));b.onResolve({filter:/^server-only$/},()=>({path:'empty',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));b.onResolve({filter:/\.mjs$/},args=>({path:resolve(args.resolveDir,args.path),external:true}));}}]});
await writeFile(join(dir,'model.mjs'),bundle.outputFiles[0].text);
const {askMuse}=await import(pathToFileURL(join(dir,'model.mjs')));
const {readMuseNote,saveMuseNote,saveMuseChat}=await import('../scripts/muse-store.mjs');
const {readMuseLearning}=await import('../scripts/muse-learning.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
const reply=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const board={board:'Visit',page:'Garden',selectedIds:['garden'],objects:[{id:'garden',type:'MuzeNote',text:'San Francisco Botanical Garden',editable:true}]};
test('a contextual multilingual question plans a public query then includes cited evidence in the final answer',async()=>{
 const original=globalThis.fetch,calls=[],owner='contextual-tools';
 const soul=await readMuseNote(owner,'soul');await saveMuseNote(owner,'soul','# Soul\nPrivate notebook marker: PERSONAL-NOTE-777',soul.revision);
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  if(body.response_format?.json_schema?.name==='MuzeToolPlan')return reply({action:'research',query:'San Francisco Botanical Garden Sunday opening hours',explicitImageRequest:false});
  if(url.endsWith('/responses'))return new Response(JSON.stringify({status:'completed',output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'Open on Sundays.',annotations:[{type:'url_citation',url:'https://example.org/hours',title:'Garden hours',start_index:0,end_index:16}]}]}]}));
  return reply({reply:'Open on Sundays.',cards:[],updates:[],suggestions:[]});
 };
 try{
  const result=await askMuse(owner,{thread:'visit:garden',message:'查一下这里周日的开放时间',board:JSON.stringify(board)},new AbortController().signal);
  assert.equal(calls.length,3);assert.doesNotMatch(JSON.stringify(calls[0].body),/PERSONAL-NOTE-777/);
  assert.equal(calls[1].body.input[1].content,'San Francisco Botanical Garden Sunday opening hours');assert.doesNotMatch(JSON.stringify(calls[1].body),/PERSONAL-NOTE-777|selectedIds|recent/);
  assert.match(JSON.stringify(calls[2].body),/Open on Sundays/);assert.match(result.messages.at(-1).content,/Garden hours.*https:\/\/example.org\/hours/);
 }finally{globalThis.fetch=original;}
});
test('a request to draw a banana produces decoded WebP pixels in the chat response even without the word image',async()=>{
 const original=globalThis.fetch,calls=[],png=await sharp({create:{width:100,height:100,channels:3,background:'#eecc33'}}).png().toBuffer();
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  if(body.response_format?.json_schema?.name==='MuzeToolPlan'){
   assert.equal(JSON.parse(body.messages[1].content).request,'Draw a banana with a face');
   return reply({action:'image_generate',query:'A banana with a friendly face',explicitImageRequest:true});
  }
  if(url.endsWith('/images/generations')){
   assert.equal(body.model,'muse-image-1.0');assert.equal(body.prompt,'A banana with a friendly face');
   return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  }
  assert.match(JSON.stringify(body.messages),/Prepared 1 images.*Generated with Muse/);
  return reply({reply:'A banana with a face for your board.',cards:[],updates:[],suggestions:[]});
 };
 try{
  const result=await askMuse('image-tools',{thread:'garden:one',message:'Draw a banana with a face',board:JSON.stringify(board)},new AbortController().signal);
  assert.equal(calls.length,3);assert.equal(calls[1].url,'https://api.meta.ai/v1/images/generations');assert.equal(result.actions.images.length,1);assert.match(result.actions.images[0].src,/^data:image\/webp;base64,/);assert.equal(result.actions.images[0].sourceUrl,undefined);assert.doesNotMatch(result.messages.at(-1).content,/Sources:/);
  const image=await sharp(Buffer.from(result.actions.images[0].src.split(',')[1],'base64')).metadata();
  assert.equal(image.format,'webp');assert.equal(image.width,100);assert.equal(image.height,100);
 }finally{globalThis.fetch=original;}
});

test('failed or unusable generation cannot reach a success reply or persist one in chat history',async()=>{
 const original=globalThis.fetch;
 for(const failure of [
  {owner:'image-provider-failed',response:()=>new Response(JSON.stringify({error:{message:'Unavailable'}}),{status:503}),error:/could not generate/},
  {owner:'image-result-missing',response:()=>new Response(JSON.stringify({data:[]})),error:/no usable image/},
  {owner:'image-pixels-invalid',response:()=>new Response(JSON.stringify({data:[{b64_json:Buffer.from('not image pixels').toString('base64')}]})),error:/could not be decoded/},
 ]){
  const calls=[];
  globalThis.fetch=async(url,options)=>{
   const body=JSON.parse(options.body);calls.push(url);
   if(body.response_format?.json_schema?.name==='MuzeToolPlan')return reply({action:'image_generate',query:'A banana with a friendly face',explicitImageRequest:true});
   if(url.endsWith('/images/generations'))return failure.response();
   assert.fail('Do not ask the completion model to describe an image that was never prepared.');
  };
  try{
   await assert.rejects(askMuse(failure.owner,{thread:'banana:one',message:'Draw a banana with a face',board:JSON.stringify(board)},new AbortController().signal),failure.error);
   assert.equal(calls.length,2);assert.equal(calls.filter(url=>url.endsWith('/images/generations')).length,1);
   assert.deepEqual((await readMuseLearning(failure.owner,'banana:one')).messages,[]);
  }finally{globalThis.fetch=original;}
 }
});

test('a skipped explicit generation stops before a text-only success reply',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,options)=>{
  calls++;const body=JSON.parse(options.body);
  assert.equal(body.response_format?.json_schema?.name,'MuzeToolPlan');
  return reply({action:'none',query:'',explicitImageRequest:false});
 };
 try{
  await assert.rejects(askMuse('image-skipped',{thread:'banana:one',message:'can you generate me an image of banana with face',board:JSON.stringify(board)},new AbortController().signal),/did not prepare an image/);
  assert.equal(calls,1);assert.deepEqual((await readMuseLearning('image-skipped','banana:one')).messages,[]);
 }finally{globalThis.fetch=original;}
});

test('style answers and explicit retries carry the recent image request into tool planning',async()=>{
 const original=globalThis.fetch,png=await sharp({create:{width:80,height:80,channels:3,background:'#eecc33'}}).png().toBuffer();
 const prior=[{id:'image-request',role:'user',content:'can you generate me an image of banana with face'},{id:'image-style',role:'assistant',content:'What style would you like: cute cartoon or realistic?'}];
 for(const [index,message] of ['Cute cartoon banana with a happy face','Try generating the cute banana again'].entries()){
  const owner='image-followup-'+index;await saveMuseChat(owner,'banana:one',prior);
  let generations=0;
  globalThis.fetch=async(url,options)=>{
   const body=JSON.parse(options.body);
   if(body.response_format?.json_schema?.name==='MuzeToolPlan'){
    const sent=JSON.parse(body.messages[1].content);
    assert.equal(sent.request,message);assert.deepEqual(sent.context.recent,prior.map(({role,content})=>({role,content})));
    assert.match(body.messages[0].content,/Do not require the user to repeat the word image/);
    return reply({action:'image_generate',query:'A cute cartoon banana with a happy face',explicitImageRequest:true});
   }
   if(url.endsWith('/images/generations')){generations++;assert.equal(body.prompt,'A cute cartoon banana with a happy face');return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}
   assert.match(JSON.stringify(body.messages),/Prepared 1 images/);
   return reply({reply:'A happy banana for your board.',cards:[],updates:[],suggestions:[]});
  };
  try{
   const result=await askMuse(owner,{thread:'banana:one',message,board:JSON.stringify(board)},new AbortController().signal);
   assert.equal(generations,1);assert.equal(result.actions.images.length,1);assert.match(result.actions.images[0].src,/^data:image\/webp;base64,/);
  }finally{globalThis.fetch=original;}
 }
});
