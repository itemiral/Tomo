import {MuseStoreError} from './muse-store.mjs';

export async function readToolJson(response, limit=1_000_000){
 const reader=response.body?.getReader();
 if(!reader)throw new MuseStoreError(502,'The service returned an empty response.');
 let size=0;const chunks=[];
 try{
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new MuseStoreError(502,'The service returned too much data.');}chunks.push(value);}
 }finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new MuseStoreError(502,'The service returned an invalid response.');}
}

// Tool queries need a topic, not the person's contact details or credentials.
export function publicToolText(value,limit=600){
 return String(value||'').replace(/\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/gi,'[private]')
  .replace(/\b(?:LLM_[\w-]+|sk_[\w-]+|sk-[\w-]+|sb_secret_[\w-]+)\b/g,'[private]')
  .replace(/\bBearer\s+[\w.-]+/gi,'[private]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[private]')
  .replace(/\b(?:\+?\d[\s().-]*){9,16}\b/g,'[private]')
  .replace(/https?:\/\/[^\s<>]+/g,value=>{try{const u=new URL(value);return u.origin+u.pathname;}catch{return '[link]';}})
  .replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
}
