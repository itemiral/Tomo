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
const {readMuseNote,saveMuseNote}=await import('../scripts/muse-store.mjs');
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
test('a requested generation becomes a real image action in one chat round with no invented sources',async()=>{
 const original=globalThis.fetch,calls=[],png=await sharp({create:{width:100,height:100,channels:3,background:'#88c'}}).png().toBuffer();
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  if(body.response_format?.json_schema?.name==='MuzeToolPlan')return reply({action:'image_generate',query:'A moonlit garden in watercolor',explicitImageRequest:true});
  if(url.endsWith('/images/generations'))return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  assert.match(JSON.stringify(body.messages),/Prepared 1 images.*Generated with Muse/);
  return reply({reply:'A moonlit garden for your board.',cards:[],updates:[],suggestions:[]});
 };
 try{
  const result=await askMuse('image-tools',{thread:'garden:one',message:'Generate an image of a moonlit garden in watercolor',board:JSON.stringify(board)},new AbortController().signal);
  assert.equal(calls.length,3);assert.equal(calls[1].url,'https://api.meta.ai/v1/images/generations');assert.equal(result.actions.images.length,1);assert.match(result.actions.images[0].src,/^data:image\/webp;base64,/);assert.equal(result.actions.images[0].sourceUrl,undefined);assert.doesNotMatch(result.messages.at(-1).content,/Sources:/);
 }finally{globalThis.fetch=original;}
});
