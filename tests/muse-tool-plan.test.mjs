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
  assert.equal(requested.max_completion_tokens,2048);assert.equal(requested.reasoning_effort,'minimal');assert.equal(requested.response_format.json_schema.name,'MuzeToolPlan');
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
 let prompt;const result=await runChatTools('generation','Draw this as a watercolor illustration',signal(),{planner:async()=>({action:'image_generate',query:'A moon garden in watercolor'}),generate:async(owner,value)=>{assert.equal(owner,'generation');prompt=value;return {src:'data:image/webp;base64,test',sourceTitle:'Generated with Muse',retrievedAt:'now'};},research:()=>assert.fail('no research'),findImage:()=>assert.fail('do not replace generation with a found photo')},context);
 assert.equal(prompt,'A moon garden in watercolor');assert.equal(result.images.length,1);assert.deepEqual(result.sources,[]);
 await assert.rejects(planMuseTools('Draw a moon',context,signal(),async()=>response({action:'execute_shell',query:'bad',explicitImageRequest:true})),/prepare/);
});
test('an explicit self-contained image request runs generation once without a fallible planning call',async()=>{
 for(const [message,prompt] of [
  ['can you generate me an image of banana with face','banana with face'],
  ['Please create a picture showing a friendly banana','a friendly banana'],
  ['Draw an image of a moon garden','a moon garden'],
  ['Could you please create an illustration of a happy cat and a dog?','a happy cat and a dog'],
  ['Make me a picture depicting a peaceful forest in watercolor.','a peaceful forest in watercolor'],
 ]){
  let generated=0;
  const result=await runChatTools('direct',message,signal(),{planner:()=>assert.fail('A clear image request must not depend on tool planning'),generate:async(_owner,value)=>{generated++;assert.equal(value,prompt);return {src:'data:image/webp;base64,test',sourceTitle:'Generated with Muse'};},research:()=>assert.fail('generation is not research'),findImage:()=>assert.fail('generation is not image search')},context);
  assert.equal(generated,1);assert.equal(result.images.length,1);assert.deepEqual(result.sources,[]);
 }
});
test('direct generation excludes contextual, negative, quoted, capability and conditional requests',async()=>{
 for(const message of [
  'Can you generate images?','Explain how to generate an image of a banana','Rewrite this: generate an image of a banana','Do not search: generate an image of a banana','Create an image of this',
  'Create an image of a cat if I approve it','Create an image of a cat, but only describe how you would do it',
  'Can you generate an image of any size?','Create an image of a cat; do not generate anything yet','Create an image of a cat? I am asking about capabilities.',"'Generate an image of a cat'",'Generate an image of a cat, not now','Create an image of a cat without tools','Generate an image of a cat without using tools',"Generate an image of a cat, don't run any tools",'Create an image of a cat, do not use tools','Create an image of a cat, not yet',
 ])assert.equal((await resolveToolPlan(message,context,signal(),async()=>({action:'none',query:''}))).action,'none',message);
 let planned=false;
 const result=await resolveToolPlan('Create an image of this place at night',context,signal(),async()=>{planned=true;return {action:'image_generate',query:'SF Botanical Garden at night'};});
 assert.equal(planned,true);assert.equal(result.query,'SF Botanical Garden at night');
 for(const message of ['Create an image of this place at night','Create an image of my dog','Create an image of a cat like the previous one','Generate an image of the same banana again']){
  await assert.rejects(resolveToolPlan(message,context,signal(),async()=>({action:'none',query:''})),/did not prepare an image/,message);
 }
});
test('direct image prompts are sanitized and a cancelled request cannot start generation',async()=>{
 const plan=await resolveToolPlan('Create an image of a sign with email person@example.org and secret=hidden',context,signal(),()=>assert.fail('No planning needed'));
 assert.equal(plan.action,'image_generate');assert.doesNotMatch(plan.query,/person@example|hidden/);assert.match(plan.query,/\[private\]/);
 const abort=new AbortController();abort.abort();
 await assert.rejects(runChatTools('direct','Create an image of a cat',abort.signal,{generate:()=>assert.fail('Cancelled request')},context),{name:'AbortError'});
});
test('tool planner diagnoses truncation and provider failures without logging private content or retrying',async()=>{
 const original=console.warn,logs=[];console.warn=value=>logs.push(JSON.parse(value));
 try{
  const cases=[
   {kind:'busy',status:429,result:()=>new Response('PRIVATE RESPONSE',{status:429}),match:/busy/},
   {kind:'auth',status:502,result:()=>new Response('PRIVATE RESPONSE',{status:401}),match:/authenticate/},
   {kind:'provider',status:502,result:()=>new Response('PRIVATE RESPONSE',{status:503}),match:/prepare this request/},
   {kind:'truncated',status:502,result:()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'PRIVATE RESPONSE'}}],usage:{completion_tokens:2048,completion_tokens_details:{reasoning_tokens:1980}}})),match:/finish preparing/},
   {kind:'invalid_json',status:502,result:()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'PRIVATE RESPONSE'}}]})),match:/prepare this request/},
   {kind:'invalid_plan',status:502,result:()=>response(null),match:/prepare this request/},
   {kind:'invalid_response',status:502,result:()=>new Response('not json'),match:/prepare this request/},
  ];
  for(const item of cases){let calls=0;await assert.rejects(planMuseTools('PRIVATE PROMPT',context,signal(),async()=>{calls++;return item.result();}),error=>{assert.equal(error.status,item.status);assert.match(error.message,item.match);return true;});assert.equal(calls,1);assert.equal(logs.at(-1).kind,item.kind);}
  assert.deepEqual(logs.find(x=>x.kind==='truncated'),{event:'muse_tool_plan_failure',kind:'truncated',outputTokens:2048,reasoningTokens:1980,finishReason:'length'});
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|Workshop|Garden|synthetic/);
 }finally{console.warn=original;}
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

test('ordinary trip planning survives a router outage while preserving semantic routing when available',async()=>{
 const emptyBoard={board:{board:'Trip to Tokyo',page:'Page 1',selectedIds:[],objects:[]},history:[]};
 for(const message of ['can you help me make a trip to Tokyo for 2 people, me and my girlfriend','Plan a trip to Tokyo for two people','Outline a relaxed Tokyo trip']){
  let calls=0;
  const result=await resolveToolPlan(message,emptyBoard,signal(),async()=>{calls++;throw new Error('temporary router failure');});
  assert.equal(calls,1);assert.equal(result.action,'none');assert.match(result.notice,/No web search, image lookup or generation ran/);
  const planned=await resolveToolPlan(message,emptyBoard,signal(),async()=>({action:'research',query:'Tokyo itinerary ideas for two'}));
  assert.equal(planned.action,'research');
 }
 for(const message of ['Plan a trip to Tokyo with current prices','Outline current fares for this route','What does this hotel cost?','Research this Tokyo itinerary','Create an image of this place']){
  const failure=new Error('lookup required');
  await assert.rejects(resolveToolPlan(message,emptyBoard,signal(),async()=>{throw failure;}),error=>error===failure,message);
 }
});

test('auth, configuration, rate limits and cancellation cannot become successful planning fallbacks',async()=>{
 const message='Plan a trip to Tokyo for two';
 for(const details of [{kind:'auth',status:502},{kind:'configuration',status:503},{status:401},{status:403},{status:429}]){
  const failure=Object.assign(new Error('service account unavailable'),details);
  await assert.rejects(resolveToolPlan(message,context,signal(),async()=>{throw failure;}),error=>error===failure);
 }
 const abort=new AbortController(),reason=new Error('Cancelled by owner');
 await assert.rejects(resolveToolPlan(message,context,abort.signal,async()=>{abort.abort(reason);throw reason;}),error=>error===reason);
});

test('a failed router cannot turn an image style answer or retry into text-only success',async()=>{
 const imageContext={...context,history:[{role:'user',content:'can you generate me an image of banana with face'},{role:'assistant',content:'What style would you like: cute cartoon or realistic?'}]};
 for(const message of ['Cute cartoon banana with a happy face','Try generating the cute banana again','Make it cute','Continue']){
  const failure=new Error('image routing unavailable');
  await assert.rejects(runChatTools('image-followup',message,signal(),{planner:async()=>{throw failure;},generate:()=>assert.fail('No tool should start after failed routing')},imageContext),error=>error===failure,message);
 }
 // A new, explicit planning task is not trapped by an earlier image request.
 const result=await resolveToolPlan('Plan a trip to Tokyo',imageContext,signal(),async()=>{throw new Error('router unavailable');});
 assert.equal(result.action,'none');assert.match(result.notice,/No web search/);
});

test('a personal preference does not swallow a separate current-information request',async()=>{
 for(const message of ['I like museums; recommend current exhibitions in Seoul','I prefer quiet hotels, find current rates in Busan','I love gardens and please check the opening hours','I like museums. Current exhibitions in Seoul?']){
  let called=false;const result=await resolveToolPlan(message,context,signal(),async()=>{called=true;return {action:'research',query:'Seoul exhibitions'};});
  assert.equal(result.action,'research',message);
  assert.equal(called,true,'mixed preferences are reduced to a public query');
 }
 assert.equal((await resolveToolPlan('Rewrite this: I like museums; search current exhibitions',context,signal(),()=>assert.fail('quoted edits stay local'))).action,'none');
});
