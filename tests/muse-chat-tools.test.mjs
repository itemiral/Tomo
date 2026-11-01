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
test('Commons results use actual decoded pixels and source/license metadata, never invented URLs',async()=>{
 let requested,download;const result=await findCommonsImage('Add a photo of a cat to the board',new AbortController().signal,async url=>{requested=new URL(url);return new Response(JSON.stringify({query:{pages:{1:{title:'File:Cat.jpg',imageinfo:[{mime:'image/jpeg',thumburl:'https://upload.wikimedia.org/cat.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Cat.jpg',extmetadata:{Artist:{value:'<b>Photographer</b>'},LicenseShortName:{value:'CC BY-SA 4.0'}}}]}}}}));},async url=>{download=url;return {src:'data:image/png;base64,decoded',sourceUrl:url,retrievedAt:'now'};});assert.equal(requested.searchParams.get('gsrsearch'),'cat filetype:bitmap');assert.equal(download,'https://upload.wikimedia.org/cat.jpg');assert.equal(result.sourceUrl,'https://commons.wikimedia.org/wiki/File:Cat.jpg');assert.equal(result.attribution,'Photographer · CC BY-SA 4.0');assert.match(result.src,/decoded/);
 const actions=await runChatTools('image-owner','Add a cat image',new AbortController().signal,{findImage:async()=>result,research:()=>assert.fail('Image-only request should not run paid research')});assert.equal(actions.images.length,1);assert.equal(actions.sources[0].url,result.sourceUrl);
});
test('search limit persists per owner, failed requests consume attempts, other owners remain isolated',async()=>{
 process.env.MUSE_SEARCH_DAILY_REQUESTS='1';const signal=new AbortController().signal;let calls=0;const deps={research:async()=>{calls++;throw new Error('provider unavailable');}};await assert.rejects(runChatTools('limited','Search the web',signal,deps),/provider unavailable/);await assert.rejects(runChatTools('limited','Search again',signal,deps),/search limit/);assert.equal(calls,1);await assert.rejects(runChatTools('other','Search the web',signal,deps),/provider unavailable/);assert.equal(calls,2);delete process.env.MUSE_SEARCH_DAILY_REQUESTS;
});
