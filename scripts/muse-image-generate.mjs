import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile,writeFile,rename} from './muse-storage.mjs';
import {ensureMuse,museDirectory,withMuseOwner,MuseStoreError} from './muse-store.mjs';
import {normalizeBoardImage} from './muse-image-import.mjs';
import {readToolJson} from './muse-tool-http.mjs';

async function reserveGeneration(owner){
 await ensureMuse(owner);
 await withMuseOwner(owner,async()=>{
  const path=join(museDirectory(owner),'image-usage.json'),day=new Date().toISOString().slice(0,10);let usage={day,count:0};
  try{const saved=JSON.parse(await readFile(path,'utf8'));if(saved.day===day)usage=saved;}catch(error){if(error.code!=='ENOENT')throw error;}
  const cap=Number(process.env.MUSE_IMAGE_DAILY_REQUESTS??10);
  if(!Number.isSafeInteger(cap)||cap<0||usage.count>=cap)throw new MuseStoreError(429,'Today’s image generation limit has been reached.');
  usage.count++;const temp=path+'.'+randomUUID();await writeFile(temp,JSON.stringify(usage),{mode:0o600,flag:'wx'});await rename(temp,path);
 });
}

export async function generateBoardImage(owner,prompt,signal,fetcher=fetch){
 if(process.env.MUSE_AGENT_ENABLED==='false')throw new MuseStoreError(503,'Image generation is unavailable in this deployment.');
 if(!process.env.MODEL_API_KEY)throw new MuseStoreError(503,'Muse is not configured yet.');
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>2000)throw new MuseStoreError(400,'Describe the image you want to create.');
 signal.throwIfAborted();await reserveGeneration(owner);
 // One paid attempt per explicit request. Do not retry an uncertain completion.
 const response=await fetcher('https://api.meta.ai/v1/images/generations',{
  method:'POST',redirect:'error',headers:{Authorization:`Bearer ${process.env.MODEL_API_KEY}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:'muse-image-1.0',prompt,n:1,size:'1024x1024',response_format:'b64_json',output_format:'webp',reasoning_strength:'low',tool_enablement:{enable_web_search:false,enable_image_search:false,enable_shell:false}}),
  signal:AbortSignal.any([signal,AbortSignal.timeout(90_000)]),
 });
 if(!response.ok){
  const error=await readToolJson(response,50_000).catch(()=>null);
  if(error?.error?.code==='content_policy_violation')throw new MuseStoreError(400,'Muse could not generate that image. Try a different description.');
  if(response.status===429)throw new MuseStoreError(429,'Image generation is busy. Try again shortly.');
  throw new MuseStoreError(502,'Muse could not generate the image. Try again.');
 }
 const data=await readToolJson(response,17_000_000),encoded=data.data?.[0]?.b64_json;
 if(typeof encoded!=='string'||!encoded.length||encoded.length>16_000_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new MuseStoreError(502,'Muse returned no usable image.');
 const src=await normalizeBoardImage(Buffer.from(encoded,'base64'));signal.throwIfAborted();
 return {src,sourceTitle:'Generated with Muse',retrievedAt:new Date().toISOString(),attribution:'Generated with Muse'};
}
