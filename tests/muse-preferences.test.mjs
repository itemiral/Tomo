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

test('normal chat runs real search orchestration with citations and no notebook in the search request',async()=>{
 delete process.env.MUSE_AGENT_ENABLED;const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{const request=JSON.parse(options.body);calls.push({url,request});if(url.endsWith('/responses'))return new Response(JSON.stringify({status:'completed',output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'A verified public finding.',annotations:[{type:'url_citation',url:'https://example.org/evidence',title:'Actual evidence',start_index:0,end_index:25}]}]}]}));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'Here is the finding.',cards:[],updates:[]})}}]}));};
 try{const result=await askMuse('chat-search-test',{thread:'board:search',message:'Search the web for public gardens',board:JSON.stringify({board:'Test',page:'One',objects:[]})},new AbortController().signal);assert.equal(calls.length,2);assert.equal(calls[0].request.input[1].content,'Search the web for public gardens');assert.doesNotMatch(JSON.stringify(calls[0].request),/Soul.md|Memory.md|Private Muse/);assert.match(calls[1].request.messages.at(-1).content,/A verified public finding/);assert.match(result.messages.at(-1).content,/Actual evidence.*https:\/\/example.org\/evidence/);}finally{globalThis.fetch=original;}
});

test('selected context reaches Muse and scoped suggestions stay outside saved chat and board actions',async()=>{
 const {readMuseChat}=await import('../scripts/muse-store.mjs');
 const original=globalThis.fetch;let captured,offScope=false;
 const board={board:'A shared plan',page:'Page 1',selectedIds:['one'],objects:[
  {id:'one',type:'MuzeNote',text:'Long first section',editable:true,bounds:{x:20,y:30,w:360,h:240}},
  {id:'two',type:'MuzeNote',text:'Keep this section',editable:true,bounds:{x:430,y:30,w:360,h:240}},
 ]};
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://api.meta.ai/v1/chat/completions');captured=JSON.parse(options.body);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'A shorter first section.',cards:[],updates:[{id:offScope?'two':'one',text:'Short first section'}],suggestions:['Identify the next step']})}}]}));
 };
 try{
  const request={thread:'focused:page',message:'Make this concise',board:JSON.stringify(board)};
  const result=await askMuse('selected-context-owner',request,new AbortController().signal);
  const content=captured.messages.at(-1).content;
  assert.match(content,/"selectedIds":\["one"\]/);
  assert.match(content,/"bounds":\{"x":20,"y":30,"w":360,"h":240\}/);
  assert.match(content,/Keep this section/);
  assert.deepEqual(result.actions.focusIds,['one']);
  assert.deepEqual(result.actions.updates,[{id:'one',text:'Short first section',expectedText:'Long first section'}]);
  assert.deepEqual(result.suggestions,['Identify the next step']);
  assert.equal(Object.hasOwn(result.actions,'suggestions'),false);
  const saved=await readMuseChat('selected-context-owner','focused:page');
  assert.equal(saved.length,2);assert.doesNotMatch(JSON.stringify(saved),/Identify the next step|selectedIds|bounds/);
  offScope=true;
  await assert.rejects(askMuse('selected-context-owner',request,new AbortController().signal),{status:502});
  assert.deepEqual(await readMuseChat('selected-context-owner','focused:page'),saved);
 }finally{globalThis.fetch=original;}
});

test('normal chat learns private style and project facts in one call, then scopes their context',async()=>{
 const {readMuseNote}=await import('../scripts/muse-store.mjs');
 const {readMuseLearning}=await import('../scripts/muse-learning.mjs');
 const original=globalThis.fetch;let captured,calls=0;
 const owner='adaptive-model-owner', message='I prefer detailed replies. Our workshop budget is $800.';
 globalThis.fetch=async(_url,options)=>{
  calls++;captured=JSON.parse(options.body);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'Let’s outline the workshop.',cards:[],updates:[],suggestions:[],personalization:calls===1?{updates:[
   {key:'detail',target:'soul',scope:'owner',text:'Give detailed replies.',evidence:'I prefer detailed replies',operation:'upsert'},
   {key:'budget',target:'memory',scope:'board',text:'Workshop budget: $800.',evidence:'Our workshop budget is $800',operation:'upsert'},
  ],summary:'Plan the workshop within $800.'}:{updates:[],summary:''}})}}]}));
 };
 const ask=(who,thread,prompt='Continue the plan')=>askMuse(who,{thread,message:prompt,board:JSON.stringify({board:'Workshop',page:'One',objects:[]})},new AbortController().signal);
 try{
  const result=await ask(owner,'workshop:one',message);
  assert.equal(calls,1);assert.equal(result.personalizationUpdated,true);
  assert.match((await readMuseNote(owner,'soul')).content,/Give detailed replies/);
  assert.match((await readMuseNote(owner,'memory')).content,/Workshop budget: \$800/);
  assert.equal(Object.hasOwn(result,'personalization'),false);
  await ask(owner,'workshop:two');assert.match(captured.messages[0].content,/Workshop budget: \$800/);assert.match(captured.messages[0].content,/Give detailed replies/);
  await ask(owner,'unrelated:one');assert.doesNotMatch(captured.messages[0].content,/Workshop budget: \$800/);assert.match(captured.messages[0].content,/Give detailed replies/);
  await ask('adaptive-other-owner','workshop:one');assert.doesNotMatch(captured.messages[0].content,/Give detailed replies|Workshop budget: \$800/);
  assert.equal((await readMuseLearning(owner,'workshop:one')).entries.length,2);
 }finally{globalThis.fetch=original;}
});

test('a manual Soul edit during generation wins over a stale learned change',async()=>{
 const {readMuseNote,saveMuseNote}=await import('../scripts/muse-store.mjs');
 const original=globalThis.fetch,owner='adaptive-stale-owner';
 globalThis.fetch=async()=>{
  const current=await readMuseNote(owner,'soul');
  await saveMuseNote(owner,'soul','# Soul\nMy own new working style.',current.revision);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'Understood.',cards:[],updates:[],personalization:{updates:[{key:'tone',target:'soul',scope:'owner',text:'Be playful.',evidence:'Please be playful',operation:'upsert'}],summary:''}})}}]}));
 };
 try{
  const result=await askMuse(owner,{thread:'draft:one',message:'Please be playful',board:JSON.stringify({board:'Draft',page:'One',objects:[]})},new AbortController().signal);
  assert.equal((await readMuseNote(owner,'soul')).content,'# Soul\nMy own new working style.');
  assert.equal(result.personalizationUpdated,false);
 }finally{globalThis.fetch=original;}
});

test('cancelled responses do not write learned preferences or conversation messages',async()=>{
 const {readMuseNote,readMuseChat}=await import('../scripts/muse-store.mjs');
 const original=globalThis.fetch,owner='adaptive-cancel-owner',controller=new AbortController();
 globalThis.fetch=async()=>{
  controller.abort();
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'Understood.',cards:[],updates:[],personalization:{updates:[{key:'tone',target:'soul',scope:'owner',text:'Be playful.',evidence:'Please be playful',operation:'upsert'}],summary:''}})}}]}));
 };
 try{
  await assert.rejects(askMuse(owner,{thread:'cancel:one',message:'Please be playful',board:JSON.stringify({board:'Draft',page:'One',objects:[]})},controller.signal),{status:499});
  assert.doesNotMatch((await readMuseNote(owner,'soul')).content,/Be playful/);
  assert.deepEqual(await readMuseChat(owner,'cancel:one'),[]);
 }finally{globalThis.fetch=original;}
});

test('removing a learned preference also removes its old exchange from model context',async()=>{
 const {readMuseNote,saveMuseNote,readMuseChat}=await import('../scripts/muse-store.mjs');
 const original=globalThis.fetch,owner='adaptive-delete-owner';let captured,calls=0;
 globalThis.fetch=async(_url,options)=>{
  captured=JSON.parse(options.body);calls++;
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:calls===1?'I can use violet metaphors.':'What should we work on next?',cards:[],updates:[],personalization:{updates:calls===1?[{key:'tone',target:'soul',scope:'owner',text:'Use violet metaphors.',evidence:'Always use violet metaphors',operation:'upsert'}]:[],summary:''}})}}]}));
 };
 const ask=message=>askMuse(owner,{thread:'delete:one',message,board:JSON.stringify({board:'Draft',page:'One',objects:[]})},new AbortController().signal);
 try{
  await ask('Always use violet metaphors');
  const soul=await readMuseNote(owner,'soul');
  await saveMuseNote(owner,'soul',soul.content.replace(/<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/,''),soul.revision);
  await ask('Continue');
  assert.doesNotMatch(JSON.stringify(captured.messages),/violet metaphors/);
  assert.match(JSON.stringify(await readMuseChat(owner,'delete:one')),/violet metaphors/,'the private transcript remains separate from active memory');
 }finally{globalThis.fetch=original;}
});
