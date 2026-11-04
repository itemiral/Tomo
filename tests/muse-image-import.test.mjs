import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {importImage,normalizeBoardImage} from '../scripts/muse-image-import.mjs';
const png=await sharp({create:{width:60,height:40,channels:4,background:'#55aaee'}}).png().toBuffer();
const signal=()=>new AbortController().signal;
function transport(routes,requests=[]){return (url,options,callback)=>{
 const request=new EventEmitter();request.destroy=error=>request.emit('error',error);
 requests.push({url:url.href,options});
 queueMicrotask(()=>{const result=routes[url.href];if(!result){request.emit('error',new Error('Unknown test URL'));return;}const response=Readable.from(result.bytes?[result.bytes]:[]);response.statusCode=result.status??200;response.headers=result.headers??{'content-type':'image/png'};callback(response);});return request;
};}
const publicLookup=async()=>[{address:'93.184.216.34',family:4}];
test('image redirects validate and pin every destination, then save bounded portable pixels',async()=>{
 const requests=[],hosts=[];
 const image=await importImage('https://images.example.org/original',signal(),{lookup:async host=>{hosts.push(host);return publicLookup();},get:transport({
  'https://images.example.org/original':{status:302,headers:{location:'https://cdn.example.org/photo'}},
  'https://cdn.example.org/photo':{bytes:png},
 },requests)});
 assert.deepEqual(hosts,['images.example.org','cdn.example.org']);
 for(const req of requests)await new Promise(resolve=>req.options.lookup('ignored',{all:true},(_error,addresses)=>{assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);resolve();}));
 assert.match(image.src,/^data:image\/webp;base64,/);assert.equal(image.sourceUrl,'https://images.example.org/original');
 const meta=await sharp(Buffer.from(image.src.split(',')[1],'base64')).metadata();assert.equal(meta.width,60);assert.equal(meta.height,40);
});
test('redirects reject private DNS, downgrade, credentials, numeric addresses and loops',async()=>{
 for(const location of ['http://cdn.example.org/image','https://user:password@cdn.example.org/image','https://127.0.0.1/image','https://cdn.example.org/image','https://images.example.org/original']){
  let requests=0;
  await assert.rejects(importImage('https://images.example.org/original',signal(),{
   lookup:async host=>host==='cdn.example.org'?[{address:'10.0.0.2',family:4}]:publicLookup(),
   get:(...args)=>{requests++;return transport({'https://images.example.org/original':{status:302,headers:{location}}})(...args);},
  }),/unsupported|Private|loop/);
  assert.equal(requests,1);
 }
});
test('mixed public/private DNS and malformed image content fail before insertion',async()=>{
 await assert.rejects(importImage('https://example.org/photo',signal(),{lookup:async()=>[{address:'93.184.216.34',family:4},{address:'169.254.169.254',family:4}],get:()=>assert.fail('must not connect')}),/Private/);
 await assert.rejects(importImage('https://example.org/photo',signal(),{lookup:publicLookup,get:transport({'https://example.org/photo':{bytes:Buffer.from('not an image')}})}),/decoded/);
 await assert.rejects(importImage('https://example.org/photo',signal(),{lookup:publicLookup,get:transport({'https://example.org/photo':{headers:{'content-type':'text/html'},bytes:png}})}),/PNG/);
 await assert.rejects(importImage('https://example.org/photo',signal(),{lookup:publicLookup,get:transport({'https://example.org/photo':{headers:{'content-type':'image/png','content-length':'6000000'},bytes:png}})}),/5 MB/);
});
test('the total deadline also cancels a stalled DNS lookup',async()=>{
 const keepAlive=setTimeout(()=>{},100);
 try{await assert.rejects(importImage('https://example.org/photo',signal(),{timeoutMs:10,lookup:()=>new Promise(()=>{}),get:()=>assert.fail('must not connect')}),/timeout/i);}finally{clearTimeout(keepAlive);}
});
test('normalization limits dimensions and payload for shared scenes',async()=>{
 const large=await sharp({create:{width:2500,height:2000,channels:3,background:'#55aaee'}}).png().toBuffer();
 const src=await normalizeBoardImage(large),bytes=Buffer.from(src.split(',')[1],'base64'),meta=await sharp(bytes).metadata();
 assert.ok(bytes.length<=600000);assert.equal(meta.width,1600);assert.equal(meta.height,1280);
 await assert.rejects(normalizeBoardImage(Buffer.alloc(12000001)),/large/);
});
