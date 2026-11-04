import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const directory=await mkdtemp(join(tmpdir(),'muse-research-'));
process.env.MUZE_PRIVATE_DIR=directory;
process.env.MODEL_API_KEY='synthetic-research-key';
process.env.MUSE_AGENT_ENABLED='true';
const {researchGoal}=await import('../scripts/muse-research.mjs');
after(()=>rm(directory,{recursive:true,force:true}));

const signal=()=>new AbortController().signal;
const json=value=>new Response(JSON.stringify(value));
const answer='The museum opens at 10 am.';
const citation={type:'url_citation',url:'https://museum.example.org/hours',title:'Museum hours',start_index:0,end_index:answer.length};
const completed=()=>({status:'completed',output:[
 {type:'web_search_call',status:'completed',results:[{type:'text_result',title:'Museum hours',url:citation.url,snippet:answer}]},
 {type:'message',content:[{type:'output_text',text:answer,annotations:[{...citation}]}]},
]});
const truncated=()=>({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{output_tokens:8192,output_tokens_details:{reasoning_tokens:8050}},output:[{type:'reasoning',summary:[{text:'PRIVATE_REASONING'}]},{type:'message',content:[{type:'output_text',text:'PRIVATE_PARTIAL_ANSWER',annotations:[]}]}]});
function captureLogs(t){const logs=[];t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));return logs;}

test('research uses supported search and minimal reasoning with enough room for a cited answer',async()=>{
 let request,calls=0;
 const before=Date.now();
 const result=await researchGoal('Museum hours',signal(),async(url,options)=>{
  calls++;assert.equal(url,'https://api.meta.ai/v1/responses');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer synthetic-research-key');request=JSON.parse(options.body);return json(completed());
 });
 assert.equal(calls,1);assert.equal(request.model,'muse-spark-1.3');assert.equal(request.store,false);
 assert.deepEqual(request.reasoning,{effort:'minimal'});assert.equal(request.max_output_tokens,8192);
 assert.deepEqual(request.tools,[{type:'web_search',search_context_size:'low'}]);assert.deepEqual(request.include,['web_search_call.results']);
 assert.equal(request.text.format.type,'json_schema');assert.equal(request.text.format.strict,true);
 assert.equal(request.text.format.schema.properties.findings.type,'array');assert.equal(request.text.format.schema.properties.uncertainty.type,'string');
 assert.ok(request.tool_choice===undefined||request.tool_choice==='auto');assert.equal(request.input.at(-1).content,'Museum hours');
 assert.equal(result.text,answer);assert.deepEqual(result.sources,[{url:citation.url,title:citation.title,excerpt:answer}]);
 assert.ok(result.searchedAt>=before&&result.searchedAt<=Date.now());
});

test('confirmed output exhaustion retries once with a larger budget and the same deadline',async t=>{
 const logs=captureLogs(t),requests=[];
 const result=await researchGoal('Museum hours',signal(),async(_url,options)=>{
  requests.push({body:JSON.parse(options.body),signal:options.signal});return json(requests.length===1?truncated():completed());
 });
 assert.equal(requests.length,2);assert.equal(requests[0].body.max_output_tokens,8192);assert.equal(requests[1].body.max_output_tokens,16384);
 assert.strictEqual(requests[0].signal,requests[1].signal);
 const {max_output_tokens:_first,...first}=requests[0].body,{max_output_tokens:_second,...second}=requests[1].body;
 assert.deepEqual(second,first);assert.equal(requests[1].body.previous_response_id,undefined);
 assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_REASONING|PRIVATE_PARTIAL_ANSWER/);
 assert.equal(result.text,answer);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 assert.deepEqual(logs,[{event:'muse_research_retry',attempt:2,responseStatus:'incomplete',reason:'max_output_tokens',outputTokens:8192,reasoningTokens:8050}]);
});

test('a second exhausted budget fails without a third request or exposing a partial answer',async t=>{
 const logs=captureLogs(t);let calls=0;
 await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(truncated());}),error=>{
  assert.equal(error.kind,'truncated');assert.equal(error.status,502);assert.match(error.message,/response space/);assert.doesNotMatch(error.message,/PRIVATE/);return true;
 });
 assert.equal(calls,2);assert.equal(logs.length,2);assert.equal(logs.at(-1).kind,'truncated');
});

test('filters, nonterminal states, malformed JSON and provider failures never trigger a budget retry',async t=>{
 const logs=captureLogs(t);
 const cases=[
  {response:()=>json({status:'incomplete',incomplete_details:{reason:'content_filter'}}),kind:'content_filter',status:400},
  ...['queued','in_progress','cancelled','failed'].map(status=>({response:()=>json({status,incomplete_details:{reason:'max_output_tokens'}}),kind:'incomplete',status:502})),
  {response:()=>json({status:'incomplete',incomplete_details:{reason:'unknown'}}),kind:'incomplete',status:502},
  {response:()=>json(null),kind:'incomplete',status:502},
  {response:()=>new Response('PRIVATE_INVALID_JSON'),kind:'invalid_response',status:502},
  ...[401,403,429,503].map(status=>({response:()=>new Response('PRIVATE_PROVIDER_BODY',{status}),kind:status===429?'busy':status===503?'provider':'auth',status:status===429?429:502})),
 ];
 for(const item of cases){
  let calls=0;
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return item.response();}),error=>{assert.equal(error.kind,item.kind);assert.equal(error.status,item.status);return true;});
  assert.equal(calls,1,item.kind);assert.equal(logs.at(-1).kind,item.kind);
 }
 assert.ok(logs.every(log=>log.event==='muse_research_failure'));
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE/);
});

test('uncertain transport failures and timeouts are not automatically retried',async t=>{
 captureLogs(t);
 for(const failure of [new TypeError('PRIVATE_TRANSPORT_ERROR'),new DOMException('PRIVATE_TIMEOUT','TimeoutError')]){
  let calls=0;
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;throw failure;}),error=>{assert.equal(error.kind,failure.name==='TimeoutError'?'timeout':'unavailable');return true;});
  assert.equal(calls,1);
 }
});

test('raw search results, unfinished searches and unsupported citation spans are not successful research',async t=>{
 captureLogs(t);
 const invalidAnnotations=[
  [],[{...citation,type:'file_citation'}],[{...citation,start_index:-1}],[{...citation,end_index:answer.length+1}],
  [{...citation,start_index:2,end_index:2}],[{...citation,start_index:0.5}],[{...citation,url:'http://museum.example.org/hours'}],
  [{...citation,url:'https://localhost/private'}],[{...citation,url:'https://user:password@museum.example.org/hours'}],
 ];
 const cases=invalidAnnotations.map(annotations=>{const value=completed();value.output[1].content[0].annotations=annotations;return value;});
 const noSearch=completed();noSearch.output.shift();cases.push(noSearch);
 const unfinished=completed();unfinished.output[0].status='in_progress';cases.push(unfinished);
 const noText=completed();noText.output.pop();cases.push(noText);
 for(const value of cases){let calls=0;await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(value);}),{kind:'no_sources'});assert.equal(calls,1);}
});

test('malformed array entries cannot crash citation parsing or manufacture a source',async t=>{
 captureLogs(t);
 const valid=completed();valid.output.unshift(null);valid.output[2].content.unshift(null);valid.output[2].content[1].annotations.unshift(null);
 assert.equal((await researchGoal('Museum hours',signal(),async()=>json(valid))).text,answer);
 const malformed={status:'completed',output:[null,{type:'web_search_call',status:'completed'},{type:'message',content:[null,{type:'output_text',text:answer,annotations:[null]}]}]};
 await assert.rejects(researchGoal('Museum hours',signal(),async()=>json(malformed)),{kind:'no_sources'});
});

test('explicit links work when the provider returns searched sources without citation annotations',async()=>{
 const value=completed(),text=`${answer} [Opening hours](${citation.url})`;
 value.output[0].results[0].snippet='';
 value.output[1].content[0]={type:'output_text',text,annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.equal(result.text,text);assert.deepEqual(result.sources,[{url:citation.url,title:citation.title,excerpt:text}]);
});

test('explicit citations must match actual completed text search results',async t=>{
 captureLogs(t);
 const make=text=>{const value=completed();value.output[1].content[0]={type:'output_text',text,annotations:[]};return value;};
 const linked=`${answer} [Hours](${citation.url})`;
 const values=[
  make(`${answer} [Invented hours](https://museum.example.org/invented-hours)`),
  make(`${answer} [Invented source](https://invented.example.org/hours)`),
  make(answer),
 ];
 const unfinished=make(linked);unfinished.output[0].status='in_progress';unfinished.output.unshift({type:'web_search_call',status:'completed',results:[]});values.push(unfinished);
 const invalidHit=make(linked);invalidHit.output[0].results[0].type='image_result';values.push(invalidHit);
 const unsafe=make('[Source](https://user:password@museum.example.org/hours)');unsafe.output[0].results[0].url='https://user:password@museum.example.org/hours';values.push(unsafe);
 for(const value of values){let calls=0;await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(value);}),{kind:'no_sources'});assert.equal(calls,1);}
});

test('a real citation does not carry fabricated links into the answer or its source excerpts',async()=>{
 const value=completed(),invented='https://invented.example.org/not-retrieved';
 value.output[1].content[0]={type:'output_text',text:`${answer} [Hours](${citation.url}) More details: [Unverified suggestion](${invented})`,annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.deepEqual(result.sources.map(source=>source.url),[citation.url]);
 assert.ok(!JSON.stringify(result).includes(invented));
 assert.ok(result.text.includes(`[Hours](${citation.url})`));
});

test('commentary and non-assistant messages cannot supply research text or citations',async t=>{
 captureLogs(t);
 const value=completed();value.output.unshift({type:'message',phase:'commentary',role:'assistant',content:[{type:'output_text',text:'I will now research PRIVATE_PROGRESS',annotations:[]}]});
 value.output.unshift({type:'message',role:'user',content:[{type:'output_text',text:'PRIVATE_USER_ECHO',annotations:[]}]});
 assert.equal((await researchGoal('Museum hours',signal(),async()=>json(value))).text,answer);
 for(const excluded of [{phase:'commentary',role:'assistant'},{role:'user'}]){
  const onlyProgress=completed();Object.assign(onlyProgress.output[1],excluded);
  onlyProgress.output[1].content[0].text=`${answer} [Hours](${citation.url})`;
  onlyProgress.output.push({type:'message',role:'assistant',content:[{type:'output_text',text:'The answer has no cited sources.',annotations:[]}]});
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>json(onlyProgress)),{kind:'no_sources'});
 }
});

test('repeated explicit links and native annotations produce one source per URL',async()=>{
 const value=completed(),extra={type:'text_result',url:'https://museum.example.org/visit',title:'Plan your visit',snippet:''};
 value.output[0].results.push({...value.output[0].results[0]},null,extra);
 value.output[1].content[0].text+=` [Hours](${citation.url}) [Hours again](${citation.url})\n\nBook ahead. [Visit](${extra.url})`;
 value.output.push({type:'message',role:'assistant',content:[{type:'output_text',text:`Booking details. [Visit again](${extra.url})`,annotations:[]}]});
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.equal(result.sources.length,2);assert.deepEqual(result.sources[0],{url:citation.url,title:citation.title,excerpt:answer});
 assert.deepEqual(result.sources[1],{url:extra.url,title:extra.title,excerpt:`Book ahead. [Visit](${extra.url})`});
});

test('adjacent explicit citations retain each actual retrieved URL',async()=>{
 const value=completed(),second={type:'text_result',url:'https://museum.example.org/visit',title:'Plan your visit',snippet:''};
 value.output[0].results.push(second);value.output[1].content[0]={type:'output_text',text:`${answer} [Hours](${citation.url}),[Visit](${second.url})`,annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.deepEqual(result.sources.map(source=>source.url),[citation.url,second.url]);
});

test('parentheses in a retrieved URL remain part of its explicit citation',async()=>{
 const value=completed(),source={type:'text_result',url:'https://en.wikipedia.org/wiki/Museum_(disambiguation)',title:'Museum',snippet:''};
 value.output[0].results=[source];value.output[1].content[0]={type:'output_text',text:`Museum terminology. [Museum](${source.url})`,annotations:[]};
 const result=await researchGoal('Museum terminology',signal(),async()=>json(value));
 assert.deepEqual(result.sources.map(item=>item.url),[source.url]);
});

test('structured research renders supported findings and uncertainty without exposing JSON',async()=>{
 const value=completed(),uncertainty='Live ticket availability and booking status could not be verified.';
 const second={type:'text_result',url:'https://museum.example.org/visit?day=saturday',title:'Saturday visits',snippet:''};
 value.output[0].results.push(second);
 value.output[1].content[0]={type:'output_text',text:JSON.stringify({findings:[{text:answer,sourceUrl:citation.url},{text:'Saturday visits require a reservation.',sourceUrl:second.url}],uncertainty}),annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.ok(result.text.includes(answer));assert.ok(result.text.includes('Saturday visits require a reservation.'));assert.ok(result.text.includes(uncertainty));
 assert.deepEqual(result.sources.map(source=>source.url),[citation.url,second.url]);
 for(const source of result.sources)assert.ok(result.text.includes(source.url));
 assert.doesNotMatch(result.text,/"findings"|"sourceUrl"|"uncertainty"/);
});

test('structured findings from invented or incomplete sources are omitted with their unsupported claims',async()=>{
 const value=completed(),invented='https://museum.example.org/unretrieved';
 value.output.unshift({type:'web_search_call',status:'in_progress',results:[{type:'text_result',url:invented,title:'Incomplete search',snippet:''}]});
 value.output[2].content[0]={type:'output_text',text:JSON.stringify({findings:[{text:'Unsupported claim from an unfinished search.',sourceUrl:invented},{text:answer,sourceUrl:citation.url},{text:'Unsupported claim from an invented source.',sourceUrl:'https://invented.example.org/fare'}],uncertainty:'No live fares were verified.'}),annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.deepEqual(result.sources.map(source=>source.url),[citation.url]);assert.ok(result.text.includes(answer));assert.ok(result.text.includes('No live fares were verified.'));
 assert.doesNotMatch(JSON.stringify(result),/Unsupported claim|unretrieved|invented\.example/);
});

test('structured results cannot succeed from uncited raw hits or invented source URLs',async t=>{
 captureLogs(t);
 for(const findings of [[],[{text:'Invented live availability.',sourceUrl:'https://invented.example.org/tickets'}],[{text:'Same domain is not the same retrieved page.',sourceUrl:'https://museum.example.org/'}]]){
  const value=completed();value.output[1].content[0]={type:'output_text',text:JSON.stringify({findings,uncertainty:'Not verified.'}),annotations:[]};let calls=0;
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(value);}),{kind:'no_sources'});assert.equal(calls,1);
 }
});

test('malformed structured output produces a controlled error without leaking JSON or retrying',async t=>{
 const logs=captureLogs(t);
 const malformed=['{"findings": INVALID_JSON}',JSON.stringify({findings:null,uncertainty:''}),JSON.stringify({findings:'not an array',uncertainty:''}),JSON.stringify({findings:[null,{sourceUrl:citation.url,text:42}],uncertainty:''})];
 for(const text of malformed){
  const value=completed();value.output[1].content[0]={type:'output_text',text,annotations:[]};let calls=0;
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(value);}),error=>{assert.equal(error.status,502);assert.ok(['invalid_response','no_sources'].includes(error.kind));assert.doesNotMatch(error.message,/INVALID_JSON|findings|sourceUrl/);return true;});
  assert.equal(calls,1);
 }
 assert.doesNotMatch(JSON.stringify(logs),/INVALID_JSON|not an array|museum\.example/);
});

test('structured repeated findings retain useful text while deduplicating their actual source',async()=>{
 const value=completed();value.output[1].content[0]={type:'output_text',text:JSON.stringify({findings:[{text:answer,sourceUrl:citation.url},{text:`Reservations can be checked on [Museum hours](${citation.url}).`,sourceUrl:citation.url}],uncertainty:''}),annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].url,citation.url);assert.ok(result.text.includes(answer));assert.ok(result.text.includes('Reservations can be checked'));
 assert.doesNotMatch(result.text,/"findings"|"sourceUrl"/);
});

test('a completed opened page supplies its exact source even when results are empty',async t=>{
 captureLogs(t);
 const value=completed();value.output[0]={type:'web_search_call',status:'completed',action:{type:'open_page',url:citation.url},results:[]};
 value.output[1].content[0]={type:'output_text',text:JSON.stringify({findings:[{text:answer,sourceUrl:citation.url}],uncertainty:''}),annotations:[]};
 const result=await researchGoal('Museum hours',signal(),async()=>json(value));
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].url,citation.url);assert.ok(result.text.includes(answer));
 for(const change of [
  {status:'in_progress'},
  {action:{type:'open_page',url:'https://museum.example.org/another-page'}},
  {action:{type:'open_page',url:'https://different.example.org/hours'}},
  {action:{type:'open_page',url:'http://museum.example.org/hours'}},
  {action:{type:'open_page',url:'https://localhost/private'}},
  {action:{type:'open_page',url:'not a URL'}},
  {action:{type:'search',url:citation.url}},
 ]){
  const invalid=structuredClone(value);Object.assign(invalid.output[0],change);let calls=0;
  await assert.rejects(researchGoal('Museum hours',signal(),async()=>{calls++;return json(invalid);}),{kind:'no_sources'});assert.equal(calls,1);
 }
});

test('cancellation stops before a request, during a request and before a budget retry',async t=>{
 const logs=captureLogs(t);
 const before=new AbortController(),beforeReason=new Error('Owner cancelled before starting');before.abort(beforeReason);
 await assert.rejects(researchGoal('Museum hours',before.signal,()=>assert.fail('A cancelled request cannot start')),error=>error===beforeReason);
 const during=new AbortController(),duringReason=new Error('Owner cancelled while searching');let duringCalls=0;
 const pending=researchGoal('Museum hours',during.signal,async(_url,options)=>{
  duringCalls++;return new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 });
 during.abort(duringReason);await assert.rejects(pending,error=>error===duringReason);assert.equal(duringCalls,1);
 const afterResponse=new AbortController(),afterReason=new Error('Owner cancelled before retry');let afterCalls=0;
 await assert.rejects(researchGoal('Museum hours',afterResponse.signal,async()=>{afterCalls++;afterResponse.abort(afterReason);return json(truncated());}),error=>error===afterReason);
 assert.equal(afterCalls,1);assert.deepEqual(logs,[]);
});

test('diagnostics allow only known metadata and never include goals, credentials or provider content',async t=>{
 const logs=captureLogs(t),goal='PRIVATE_USER_GOAL about museum hours';let calls=0;
 await assert.rejects(researchGoal(goal,signal(),async()=>{
  calls++;
  if(calls===1)return json({...truncated(),id:'PRIVATE_RESPONSE_ID',error:{message:'PRIVATE_ERROR',code:'PRIVATE_CODE'}});
  return json({status:'PRIVATE_STATUS',incomplete_details:{reason:'PRIVATE_REASON'},usage:{output_tokens:'PRIVATE_TOKEN_COUNT',output_tokens_details:{reasoning_tokens:-1}},output:[{type:'message',content:[{type:'output_text',text:'PRIVATE_PROVIDER_CONTENT'}]}],error:{message:'PRIVATE_ERROR'}});
 }),{kind:'incomplete'});
 assert.deepEqual(logs.at(-1),{event:'muse_research_failure',kind:'incomplete'});
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|synthetic-research-key|Bearer/);
});
