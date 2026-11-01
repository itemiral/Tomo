import https from 'node:https';
import {lookup} from 'node:dns/promises';
import sharp from 'sharp';
import {publicUrl} from './muse-research.mjs';
import {MuseStoreError} from './muse-store.mjs';
export function publicAddress(address){if(address.includes(':'))return false;const p=address.split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&![0,10,127].includes(p[0])&&p[0]<224&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&(p[1]===168||p[1]===0&&(p[2]===0||p[2]===2)||p[1]===88&&p[2]===99))&&!(p[0]===198&&(p[1]===18||p[1]===19||p[1]===51&&p[2]===100))&&!(p[0]===203&&p[1]===0&&p[2]===113);}
export async function importImage(value,signal){
 const url=publicUrl(value);if(!url)throw new MuseStoreError(400,'Use a public HTTPS image URL without credentials.');
 const target=new URL(url),addresses=await lookup(target.hostname,{all:true,family:4});
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new MuseStoreError(400,'Private or reserved image addresses are not allowed.');
 const address=addresses[0].address;
 const bytes=await new Promise((resolve,reject)=>{const request=https.get(target,{signal,lookup:(_host,options,callback)=>options.all?callback(null,[{address,family:4}]):callback(null,address,4),headers:{Accept:'image/png,image/jpeg,image/webp','User-Agent':'MuseBoard/1.0'}},response=>{
  if(response.statusCode!==200){response.resume();reject(new MuseStoreError(400,'Image must be a direct URL without redirects.'));return;}
  if(!/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers['content-type']||'')){response.resume();reject(new MuseStoreError(400,'Choose a direct PNG, JPEG, or WebP image.'));return;}
  let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>5_000_000){request.destroy(new MuseStoreError(413,'Image must be under 5 MB.'));return;}chunks.push(chunk);});response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
 });request.setTimeout(15000,()=>request.destroy(new Error('Image timed out.')));request.on('error',reject);});
 let png;try{png=await sharp(bytes,{limitInputPixels:16000000}).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).png().toBuffer();}catch{throw new MuseStoreError(400,'That image could not be decoded.');}
 return {src:'data:image/png;base64,'+png.toString('base64'),sourceUrl:url,sourceTitle:target.hostname,retrievedAt:new Date().toISOString()};
}
