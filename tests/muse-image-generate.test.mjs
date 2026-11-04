import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
const dir=await mkdtemp(join(tmpdir(),'muse-generate-'));process.env.MUZE_PRIVATE_DIR=dir;process.env.MODEL_API_KEY='synthetic-test-key';
const {generateBoardImage}=await import('../scripts/muse-image-generate.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
const signal=()=>new AbortController().signal;
const png=await sharp({create:{width:100,height:100,channels:3,background:'#9ab'}}).png().toBuffer();
test('explicit image generation uses Muse Image once and returns portable decoded pixels without invented attribution',async()=>{
 let calls=0;
 const result=await generateBoardImage('artist','A quiet moon garden',signal(),async(url,options)=>{calls++;assert.equal(url,'https://api.meta.ai/v1/images/generations');const body=JSON.parse(options.body);assert.equal(body.model,'muse-image-1.0');assert.equal(body.prompt,'A quiet moon garden');assert.equal(body.n,1);assert.equal(body.response_format,'b64_json');assert.deepEqual(body.tool_enablement,{enable_web_search:false,enable_image_search:false,enable_shell:false});return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});
 assert.equal(calls,1);assert.match(result.src,/^data:image\/webp;base64,/);assert.equal(result.sourceUrl,undefined);assert.equal(result.sourceTitle,'Generated with Muse');
});
test('failed or uncertain generations are not retried and consume the per-owner allowance',async()=>{
 process.env.MUSE_IMAGE_DAILY_REQUESTS='1';let calls=0;
 const unavailable=async()=>{calls++;return new Response(JSON.stringify({error:{code:'unavailable'}}),{status:503});};
 try{await assert.rejects(generateBoardImage('limited','A garden',signal(),unavailable),/could not generate the image/);await assert.rejects(generateBoardImage('limited','A garden',signal(),unavailable),/limit/);assert.equal(calls,1);await assert.rejects(generateBoardImage('another','A garden',signal(),unavailable),/could not generate the image/);assert.equal(calls,2);}finally{delete process.env.MUSE_IMAGE_DAILY_REQUESTS;}
});
test('invalid pixels and content policy refusal return factual errors',async()=>{
 await assert.rejects(generateBoardImage('invalid','A garden',signal(),async()=>new Response(JSON.stringify({data:[{b64_json:Buffer.from('invalid').toString('base64')}]}))),/decoded/);
 await assert.rejects(generateBoardImage('refused','A garden',signal(),async()=>new Response(JSON.stringify({error:{code:'content_policy_violation'}}),{status:400})),/different description/);
});
