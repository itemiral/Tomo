import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=await mkdtemp(join(tmpdir(),'muse-preferences-'));process.env.MUZE_PRIVATE_DIR=join(dir,'private');process.env.MODEL_API_KEY='test-only-not-a-real-key';
const bundle=await build({entryPoints:['src/server/muse/model.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'server-test',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'empty',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));b.onResolve({filter:/\.mjs$/},args=>({path:resolve(args.resolveDir,args.path),external:true}));}}]});await writeFile(join(dir,'model.mjs'),bundle.outputFiles[0].text);
const {askMuse}=await import(pathToFileURL(join(dir,'model.mjs')));const {readMuseCanvas,saveMuseCanvas}=await import('../scripts/muse-canvas.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
test('ordinary-board model requests include current saved notebook preferences across threads and isolate owners',async()=>{
 const owner='synthetic-preference-owner';let snapshot=await readMuseCanvas(owner);snapshot.board.pages[0].objects.find(o=>o.id==='muse-name').text='Hello, my name is Miso.';snapshot.board.pages[0].objects.push({type:'MuzeNote',id:'cat-preference',text:'Please sound like a cat. Meow occasionally.',left:400,top:700,width:320,boxHeight:210});await saveMuseCanvas(owner,snapshot);
 const original=globalThis.fetch;let captured;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.meta.ai/v1/chat/completions');captured=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'Mock reply',cards:[],updates:[]})}}]}),{status:200});};
 const ask=async(who,thread)=>{await askMuse(who,{thread,message:'Hello',board:JSON.stringify({board:'Ordinary workspace',page:'Page 1',objects:[]})},new AbortController().signal);return captured.messages[0].content;};
 try{
  let context=await ask(owner,'ordinary:page-one');assert.match(context,/saved name is \"Miso\"/);assert.match(context,/Please sound like a cat/);assert.match(context,/sticky notes/);assert.doesNotMatch(await ask('different-owner','ordinary:page-one'),/Please sound like a cat/);assert.match(await ask(owner,'different:page-two'),/Please sound like a cat/);
  snapshot=await readMuseCanvas(owner);snapshot.board.pages[0].objects.find(o=>o.id==='cat-preference').text='Please use short sentences.';await saveMuseCanvas(owner,snapshot);context=await ask(owner,'ordinary:page-one');assert.match(context,/Please use short sentences/);assert.doesNotMatch(context,/Please sound like a cat/);
  snapshot=await readMuseCanvas(owner);snapshot.board.pages[0].objects=snapshot.board.pages[0].objects.filter(o=>o.id!=='cat-preference');await saveMuseCanvas(owner,snapshot);assert.doesNotMatch(await ask(owner,'ordinary:page-one'),/Please use short sentences/);assert.doesNotMatch(await ask('different-owner','ordinary:page-one'),/Please use short sentences|Please sound like a cat/);
 }finally{globalThis.fetch=original;}
});
