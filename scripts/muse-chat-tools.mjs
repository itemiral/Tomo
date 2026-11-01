import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {ensureMuse,museDirectory,withMuseOwner,MuseStoreError} from './muse-store.mjs';
import {researchGoal,publicUrl} from './muse-research.mjs';
import {importImage} from './muse-image-import.mjs';
import {imageLinks} from './muse-tasks.mjs';

export function toolIntent(message){
 const images=/\b(?:add|insert|find|fetch|get|show|search|put|place|bring)\b[\s\S]*\b(?:images?|photos?|pictures?)\b|\b(?:images?|photos?|pictures?)\b[\s\S]*\b(?:on|onto|to)\s+(?:the |my )?board\b/i.test(message)||imageLinks(message).length>0;
 return {images,search:/\b(?:search|look\s*up|browse|research|latest|current|today|web)\b/i.test(message)};
}
const plain=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,500);
export async function findCommonsImage(message,signal,fetcher=fetch,importer=importImage){
 const query=message.replace(/\b(?:can|could|you|please|add|insert|find|fetch|get|show|search|put|place|bring|me|an?|some|the|images?|photos?|pictures?|of|for|on|onto|to|my|this|board|whiteboard|web|and)\b/gi,' ').replace(/\s+/g,' ').trim().slice(0,240);
 if(!query)throw new MuseStoreError(400,'Tell me what you want a picture of.');
 const params=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:query+' filetype:bitmap',gsrnamespace:'6',gsrlimit:'5',prop:'imageinfo',iiprop:'url|mime|extmetadata',iiurlwidth:'800'});
 const response=await fetcher('https://commons.wikimedia.org/w/api.php?'+params,{redirect:'error',headers:{'User-Agent':'MuseBoard/1.0 (image search demo)','Accept':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!response.ok)throw new MuseStoreError(502,'Image search is unavailable. Try a direct public image link.');
 const reader=response.body?.getReader();if(!reader)throw new MuseStoreError(502,'Image search returned no results.');let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1_000_000){await reader.cancel();throw new MuseStoreError(502,'Image search returned too much data.');}chunks.push(value);}}finally{reader.releaseLock();}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new MuseStoreError(502,'Image search returned an invalid result.');}
 for(const page of Object.values(data.query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0))){
  const info=page.imageinfo?.[0],url=publicUrl(info?.thumburl||info?.url),sourceUrl=publicUrl(info?.descriptionurl);if(!url||!sourceUrl||!/^image\/(png|jpeg|webp)$/.test(info?.thumbmime||info?.mime||''))continue;
  try{const image=await importer(url,signal);return {...image,imageUrl:url,sourceUrl,sourceTitle:plain(page.title).slice(0,200).replace(/^File:/,''),attribution:[plain(info.extmetadata?.Artist?.value),plain(info.extmetadata?.LicenseShortName?.value)].filter(Boolean).join(' · ')};}catch(error){if(signal.aborted)throw error;}
 }
 throw new MuseStoreError(502,'No downloadable image was found. Try a more specific subject or a direct public image link.');
}
export async function reserveSearch(owner){
 await ensureMuse(owner);return withMuseOwner(owner,async()=>{const path=join(museDirectory(owner),'search-usage.json'),day=new Date().toISOString().slice(0,10);let usage={day,count:0};try{const saved=JSON.parse(await readFile(path,'utf8'));if(saved.day===day)usage=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
 const cap=Number(process.env.MUSE_SEARCH_DAILY_REQUESTS??20);if(!Number.isFinite(cap)||usage.count>=cap)throw new MuseStoreError(429,'Today’s search limit has been reached.');usage.count++;const temp=path+'.'+randomUUID();await writeFile(temp,JSON.stringify(usage),{mode:0o600,flag:'wx'});await rename(temp,path);
 });
}
export async function runChatTools(owner,message,signal,deps={}){
 const intent=toolIntent(message),images=[],sources=[];let research=null;
 if(intent.images){const urls=imageLinks(message);if(urls.length){for(const url of urls)images.push({id:randomUUID(),...await (deps.importer||importImage)(url,signal)});}else images.push({id:randomUUID(),...await (deps.findImage||findCommonsImage)(message,signal)});for(const i of images)sources.push({url:i.sourceUrl,title:i.sourceTitle});}
 if(intent.search&&!intent.images){await reserveSearch(owner);research=await (deps.research||researchGoal)(message,signal);sources.push(...research.sources);}
 return {images,sources,research};
}
