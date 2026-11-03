import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'muse-chat-tools-'));process.env.MUZE_PRIVATE_DIR=dir;
const {toolIntent,findCommonsImage,runChatTools}=await import('../scripts/muse-chat-tools.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
test('normal chat recognizes search and image requests without routing ordinary greetings',()=>{
 assert.deepEqual(toolIntent('Hello'),{images:false,search:false});assert.equal(toolIntent('Search the web for garden tips').search,true);for(const m of ['Add a cat image to the board','Find a photo of a cat','Put pictures of Rome on my board','Add https://example.org/cat.png'])assert.equal(toolIntent(m).images,true);
});
test('natural requests for public prices and availability use research without tool keywords',()=>{
 for(const message of [
  'Find flights from San Francisco to Tokyo in December',
  'What are the fares for Korea?',
  'Can you see live fares?',
  'Find hotels available this weekend',
  'How much does the flight cost?',
  'Compare prices for a good drawing tablet',
  'Is the 256 GB model in stock?',
  'Check the library opening hours',
  'Which concert tickets are available for Saturday?',
  'What is the latest version?',
  'Latest news about community gardens',
  'Current fares to Seoul',
  'Get ticket prices for Saturday',
  'Using my notes, search for flights to Seoul',
  'Based on the board, look up current tablet prices',
 ])assert.equal(toolIntent(message).search,true,message);
});
test('local edits, preferences and planning do not trigger incidental public research',()=>{
 for(const message of [
  'Plan a trip to Seoul',
  'Plan my day today',
  'Outline a budget for our workshop',
  'I prefer to compare fares myself',
  'Remember that I like research before decisions',
  'Rewrite this note: current flight prices',
  'Please rename the card to Search flights',
  'Summarize the current prices in these notes',
  'Can you compare fares using only my notes?',
  'What are the costs according to the table?',
  'Rewrite this note: add a photo of flights',
  'Find a photo in my notes',
 ])assert.deepEqual(toolIntent(message),{images:false,search:false},message);
});
test('explicit offline and no-search requests suppress external tools',async()=>{
 for(const message of [
  "Don't search the web. Compare ticket prices from my notes.",
  'Do not browse; find flights from the supplied itinerary.',
  'Check current availability without searching.',
  'Keep it offline: compare these prices.',
  'No web search. Find a photo of the venue in my notes.',
  'Use only the board to check availability.',
  'Only use my notes to check availability.',
  'Use just my notes to compare fares.',
  "Don't look up flights; organize the itinerary.",
  'Compare prices without looking up anything.',
  'No need to search; use the current plan.',
 ]){
  assert.deepEqual(toolIntent(message),{images:false,search:false},message);
  const result=await runChatTools('offline-owner',message,new AbortController().signal,{research:()=>assert.fail('Offline requests must not search'),findImage:()=>assert.fail('Offline requests must not search images')});
  assert.deepEqual(result,{images:[],sources:[],research:null});
 }
});
test('Commons results use actual decoded pixels and source/license metadata, never invented URLs',async()=>{
 let requested,download;const result=await findCommonsImage('Add a photo of a cat to the board',new AbortController().signal,async url=>{requested=new URL(url);return new Response(JSON.stringify({query:{pages:{1:{title:'File:Cat.jpg',imageinfo:[{mime:'image/jpeg',thumburl:'https://upload.wikimedia.org/cat.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Cat.jpg',extmetadata:{Artist:{value:'<b>Photographer</b>'},LicenseShortName:{value:'CC BY-SA 4.0'}}}]}}}}));},async url=>{download=url;return {src:'data:image/png;base64,decoded',sourceUrl:url,retrievedAt:'now'};});assert.equal(requested.searchParams.get('gsrsearch'),'cat filetype:bitmap');assert.equal(download,'https://upload.wikimedia.org/cat.jpg');assert.equal(result.sourceUrl,'https://commons.wikimedia.org/wiki/File:Cat.jpg');assert.equal(result.attribution,'Photographer · CC BY-SA 4.0');assert.match(result.src,/decoded/);
 const actions=await runChatTools('image-owner','Add a cat image',new AbortController().signal,{findImage:async()=>result,research:()=>assert.fail('Image-only request should not run paid research')});assert.equal(actions.images.length,1);assert.equal(actions.sources[0].url,result.sourceUrl);
});
test('search limit persists per owner, failed requests consume attempts, other owners remain isolated',async()=>{
 process.env.MUSE_SEARCH_DAILY_REQUESTS='1';const signal=new AbortController().signal;let calls=0;const deps={research:async()=>{calls++;throw new Error('provider unavailable');}};await assert.rejects(runChatTools('limited','Search the web',signal,deps),/provider unavailable/);await assert.rejects(runChatTools('limited','Search again',signal,deps),/search limit/);assert.equal(calls,1);await assert.rejects(runChatTools('other','Search the web',signal,deps),/provider unavailable/);assert.equal(calls,2);delete process.env.MUSE_SEARCH_DAILY_REQUESTS;
});
