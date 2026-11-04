import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'muse-tool-plan-'));process.env.MUZE_PRIVATE_DIR=dir;process.env.MODEL_API_KEY='synthetic-test-key';
const {planMuseTools,toolPlanningContext}=await import('../scripts/muse-tool-plan.mjs');
const {resolveToolPlan,runChatTools,findBoardImage}=await import('../scripts/muse-chat-tools.mjs');
const {publicToolText}=await import('../scripts/muse-tool-http.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
const signal=()=>new AbortController().signal;
const context={board:{board:'Workshop',page:'Venues',selectedIds:['venue'],objects:[{id:'venue',text:'SF Botanical Garden opening hours'}]},history:[{role:'user',content:'We are choosing a venue.'}]};
const response=plan=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]}));
test('ambiguous and multilingual requests use a bounded semantic plan with shared context',async()=>{
 for(const message of ['Is this still open on Sundays?','查一下这个地方现在的开放时间','¿Cuánto cuesta la entrada?','Добавь фотографию этого места']){
  let requested;
  const result=await resolveToolPlan(message,context,signal(),(text,ctx,sig)=>planMuseTools(text,ctx,sig,async(url,options)=>{assert.equal(url,'https://api.meta.ai/v1/chat/completions');requested=JSON.parse(options.body);return response({action:'research',query:'SF Botanical Garden Sunday opening hours',explicitImageRequest:false});}));
  assert.equal(result.action,'research');
  const sent=JSON.parse(requested.messages[1].content);assert.equal(sent.context.notes[0].selected,true);assert.equal(sent.context.notes[0].text,'SF Botanical Garden opening hours');assert.equal(sent.request,message);
  assert.equal(requested.max_completion_tokens,600);assert.equal(requested.response_format.json_schema.name,'MuzeToolPlan');
 }
});
test('explicit offline requests, quoted rewrites, preferences and plain planning never invoke tools',async()=>{
 for(const message of ['Do not search: show current prices','不要联网，整理笔记','Не ищи в интернете','No busques en internet','Sans internet, organise ceci',"Rewrite this: 'generate an image of a cat'",'I prefer current prices in my notes','Outline a daily plan template']){
  const result=await resolveToolPlan(message,context,signal(),()=>assert.fail(message));assert.equal(result.action,'none');
 }
});
test('tool planning bounds scene/history and removes obvious private data before any query',()=>{
 const privateContext=toolPlanningContext({board:{objects:Array.from({length:100},(_,i)=>({id:String(i),text:'x'.repeat(1000)+' email owner@example.org api_key=secretvalue'})),selectedIds:['99']},history:Array.from({length:50},()=>({role:'user',content:'password=notpublic '+ 'z'.repeat(1000)})),soul:'NEVER INCLUDE SOUL',memory:'NEVER INCLUDE MEMORY'});
 assert.equal(privateContext.notes[0].selected,true);assert.ok(privateContext.notes.reduce((n,x)=>n+x.text.length,0)<=5000);assert.equal(privateContext.recent.length,4);assert.doesNotMatch(JSON.stringify(privateContext),/owner@example|notpublic|NEVER INCLUDE/);
 assert.equal(publicToolText('prices for cat toys; email owner@example.org secret=hide'), 'prices for cat toys; email [private] [private]');
});
test('research receives only the minimal planned query, not scene/history/private context',async()=>{
 let query;const result=await runChatTools('contextual','Is this open on Sundays?',signal(),{planner:async()=>({action:'research',query:'SF Botanical Garden Sunday hours'}),research:async value=>{query=value;return {text:'Open Sundays.',sources:[{url:'https://example.org/hours',title:'Hours'}]};}},context);
 assert.equal(query,'SF Botanical Garden Sunday hours');assert.equal(result.sources.length,1);assert.equal(result.images.length,0);
});
test('generation is separate from real image search and requires explicit request in the structured plan',async()=>{
 const denied=await planMuseTools('Can you generate pictures?',context,signal(),async()=>response({action:'image_generate',query:'A cat',explicitImageRequest:false}));assert.equal(denied.action,'none');
 let prompt;const result=await runChatTools('generation','Draw an image of a moon garden',signal(),{planner:async()=>({action:'image_generate',query:'A moon garden in watercolor'}),generate:async(owner,value)=>{assert.equal(owner,'generation');prompt=value;return {src:'data:image/webp;base64,test',sourceTitle:'Generated with Muse',retrievedAt:'now'};},research:()=>assert.fail('no research'),findImage:()=>assert.fail('do not replace generation with a found photo')},context);
 assert.equal(prompt,'A moon garden in watercolor');assert.equal(result.images.length,1);assert.deepEqual(result.sources,[]);
 await assert.rejects(planMuseTools('Draw a moon',context,signal(),async()=>response({action:'execute_shell',query:'bad',explicitImageRequest:true})),/prepare/);
});
test('image lookup falls back to a source-backed Wikipedia thumbnail if Commons fails',async()=>{
 const requests=[];const result=await findBoardImage('Seoul skyline',signal(),async url=>{requests.push(new URL(url));if(url.includes('commons.wikimedia.org'))return new Response('Unavailable',{status:503});return new Response(JSON.stringify({query:{pages:{1:{title:'Seoul',fullurl:'https://en.wikipedia.org/wiki/Seoul',thumbnail:{source:'https://upload.wikimedia.org/photo.webp'}}}}}));},async url=>({src:'data:image/webp;base64,pixels',sourceUrl:url,retrievedAt:'now'}));
 assert.equal(requests.length,2);assert.equal(result.sourceUrl,'https://en.wikipedia.org/wiki/Seoul');assert.equal(result.imageUrl,'https://upload.wikimedia.org/photo.webp');
});

test('planning that needs real public options gets semantic routing instead of a blanket local fast path',async()=>{
 for(const message of ['Plan a trip to Korea with hotels','Outline nearby restaurant options','Plan a trip to Seoul']){
  let called=false;
  const result=await resolveToolPlan(message,context,signal(),async()=>{called=true;return {action:'research',query:'Seoul hotel options'};});
  assert.equal(called,true);assert.equal(result.action,'research');
 }
});
test('unavailable planning does not block neutral chat or pretend a lookup happened',async()=>{
 const result=await resolveToolPlan('Help me think about this',context,signal(),async()=>{throw new Error('service unavailable');});
 assert.equal(result.action,'none');assert.match(result.notice,/No web search/);
 await assert.rejects(resolveToolPlan('What does this hotel cost?',context,signal(),async()=>{throw new Error('service unavailable');}),/service unavailable/);
});

test('a personal preference does not swallow a separate current-information request',async()=>{
 for(const message of ['I like museums; recommend current exhibitions in Seoul','I prefer quiet hotels, find current rates in Busan','I love gardens and please check the opening hours','I like museums. Current exhibitions in Seoul?']){
  let called=false;const result=await resolveToolPlan(message,context,signal(),async()=>{called=true;return {action:'research',query:'Seoul exhibitions'};});
  assert.equal(result.action,'research',message);
  assert.equal(called,true,'mixed preferences are reduced to a public query');
 }
 assert.equal((await resolveToolPlan('Rewrite this: I like museums; search current exhibitions',context,signal(),()=>assert.fail('quoted edits stay local'))).action,'none');
});
