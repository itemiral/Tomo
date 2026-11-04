import https from 'node:https';
import {lookup} from 'node:dns/promises';
import sharp from 'sharp';
import {publicUrl} from './muse-research.mjs';
import {MuseStoreError} from './muse-store.mjs';

export function publicAddress(address){if(address.includes(':'))return false;const p=address.split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&![0,10,127].includes(p[0])&&p[0]<224&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&(p[1]===168||p[1]===0&&(p[2]===0||p[2]===2)||p[1]===88&&p[2]===99))&&!(p[0]===198&&(p[1]===18||p[1]===19||p[1]===51&&p[2]===100))&&!(p[0]===203&&p[1]===0&&p[2]===113);}

function abortable(promise,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}

// Portable pixels fit the shared scene; the browser never needs a third-party URL.
export async function normalizeBoardImage(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>12_000_000)throw new MuseStoreError(413,'That image is too large.');
 try{
  const image=sharp(bytes,{limitInputPixels:20_000_000,animated:false}).rotate();
  const meta=await image.metadata();
  if(!['png','jpeg','webp'].includes(meta.format))throw new Error('format');
  for(const [size,quality] of [[1600,84],[1200,78],[900,70]]){
   const output=await image.clone().resize(size,size,{fit:'inside',withoutEnlargement:true}).webp({quality,effort:4}).toBuffer();
   if(output.length<=600_000)return 'data:image/webp;base64,'+output.toString('base64');
  }
  throw new MuseStoreError(413,'That image is too detailed to add to this board.');
 }catch(error){if(error instanceof MuseStoreError)throw error;throw new MuseStoreError(400,'That image could not be decoded.');}
}

async function download(target,signal,lookupHost,get){
 const addresses=await abortable(lookupHost(target.hostname,{all:true,family:4}),signal);
 if(!addresses.length||addresses.some(a=>a.family!==4||!publicAddress(a.address)))throw new MuseStoreError(400,'Private or reserved image addresses are not allowed.');
 const address=addresses[0].address;
 return new Promise((resolve,reject)=>{
  const request=get(target,{signal,lookup:(_host,options,callback)=>options.all?callback(null,[{address,family:4}]):callback(null,address,4),headers:{Accept:'image/png,image/jpeg,image/webp','User-Agent':'Muze/1.0 (https://muze-board.vercel.app)'}},response=>{
   if([301,302,303,307,308].includes(response.statusCode)){response.destroy();resolve({redirect:response.headers.location});return;}
   if(response.statusCode!==200){response.destroy();reject(new MuseStoreError(502,'The image host could not provide that image.'));return;}
   if(!/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers['content-type']||'')){response.destroy();reject(new MuseStoreError(400,'Choose a PNG, JPEG, or WebP image.'));return;}
   if(Number(response.headers['content-length'])>5_000_000){response.destroy();reject(new MuseStoreError(413,'Image must be under 5 MB.'));return;}
   let size=0;const chunks=[];
   response.on('data',chunk=>{size+=chunk.length;if(size>5_000_000){request.destroy(new MuseStoreError(413,'Image must be under 5 MB.'));return;}chunks.push(chunk);});
   response.on('end',()=>resolve({bytes:Buffer.concat(chunks)}));response.on('error',reject);
   response.on('aborted',()=>reject(new MuseStoreError(502,'The image download was interrupted.')));
  });
  request.on('error',reject);
 });
}

export async function importImage(value,signal,deps={}){
 const original=publicUrl(value);if(!original)throw new MuseStoreError(400,'Use a public HTTPS image URL without credentials.');
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(deps.timeoutMs??20_000)]);
 let url=original;const visited=new Set();
 for(let hop=0;hop<=3;hop++){
  deadline.throwIfAborted();
  if(visited.has(url))throw new MuseStoreError(400,'The image link redirects in a loop.');visited.add(url);
  const result=await download(new URL(url),deadline,deps.lookup||lookup,deps.get||https.get);
  if(result.bytes){const src=await normalizeBoardImage(result.bytes);deadline.throwIfAborted();return {src,sourceUrl:original,sourceTitle:new URL(original).hostname,retrievedAt:new Date().toISOString()};}
  let next;try{next=typeof result.redirect==='string'?publicUrl(new URL(result.redirect,url).href):null;}catch{}
  if(!next)throw new MuseStoreError(400,'The image redirected to an unsupported address.');
  url=next;
 }
 throw new MuseStoreError(400,'The image link has too many redirects.');
}
