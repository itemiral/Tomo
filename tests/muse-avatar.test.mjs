import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
const directory = await mkdtemp(join(tmpdir(), 'muse-avatar-test-'));
process.env.MUZE_PRIVATE_DIR = directory;
process.env.MODEL_API_KEY = 'fixture-only-not-a-real-key';
const { uploadAvatar, readAvatar, generateAvatar, activateAvatar } = await import('../scripts/muse-avatar.mjs');
const { readMuseBoard, saveMuseBoard, museBoardContext } = await import('../scripts/muse-store.mjs');
after(() => rm(directory, {recursive:true,force:true}));
const png = await sharp({create:{width:32,height:32,channels:3,background:'#ffccee'}}).png().toBuffer();
const source = 'data:image/png;base64,'+png.toString('base64');
test('avatar retains exact source, isolates owners and validates image data', async()=>{
 await uploadAvatar('a', source);
 assert.equal((await readAvatar('a')).source, source);
 assert.equal(await readAvatar('b'),null);
 await assert.rejects(uploadAvatar('a','data:image/png;base64,AAAA'), /decoded/);
 assert.equal((await readAvatar('a')).source,source);
});
test('oversized avatar uploads are rejected before storage or generation', async () => {
 const { replaceAvatar } = await import('../scripts/muse-avatar.mjs');
 const { randomUUID } = await import('node:crypto');
 const oversized = 'data:image/png;base64,' + 'A'.repeat(3_800_000);
 await assert.rejects(uploadAvatar('oversized', oversized), /smaller/);
 await assert.rejects(replaceAvatar('oversized', { source: oversized, operationId: randomUUID(), confirmCost: true, maxCostUsd: .01, shareWithMeta: true }, new AbortController().signal, () => { throw new Error('Must not generate'); }), /smaller/);
 assert.equal(await readAvatar('oversized'), null);
});
test('generation requires exact cost and source approval; failures preserve avatar',async()=>{
 const original=await uploadAvatar('generation',source); let calls=0;
 const fail=async()=>{calls++;return {ok:false,status:503}};
 await assert.rejects(generateAvatar('generation',{},new AbortController().signal,fail),/Confirm/);
 assert.equal(calls,0);
 const body={confirmCost:true,maxCostUsd:.01,shareWithMeta:true,sourceVersion:original.iconVersion};
 await assert.rejects(generateAvatar('generation',body,new AbortController().signal,fail),/could not/);
 assert.equal((await readAvatar('generation')).source,source);
 const sheet=await sharp({create:{width:768,height:768,channels:3,background:'#ffeecc'}}).png().toBuffer();
 const result=await generateAvatar('generation',body,new AbortController().signal,async(url,options)=>{
  assert.equal(url,'https://api.meta.ai/v1/images/edits');const request=JSON.parse(options.body);assert.equal(request.n,1);assert.equal(request.model,'muse-image-1.0');return {ok:true,json:async()=>({data:[{b64_json:sheet.toString('base64')}]})};
 });
 assert.equal(result.gazeVersion,null);
 assert.ok(result.candidateVersion);
 await assert.rejects(activateAvatar('generation','wrong'),/changed/);
 assert.equal((await activateAvatar('generation',result.candidateVersion)).gazeVersion,result.candidateVersion);
});
test('all supported memory cards and comments persist, enter context, and reject conflicts and media', async()=>{
 const start=await readMuseBoard('context');
 const saved=await saveMuseBoard('context',{...start,cards:[{id:'one',kind:'markdown',text:'Remember my weekly review'}],comments:[{id:'c',text:'Use concise answers'}]});
 assert.match(museBoardContext(await readMuseBoard('context')),/weekly review/);
 assert.match(museBoardContext(saved),/concise answers/);
 assert.equal((await readMuseBoard('other')).cards.length,0);
 await assert.rejects(saveMuseBoard('context',start),/changed elsewhere/);
 await assert.rejects(saveMuseBoard('context',{...saved,cards:[{id:'media',kind:'image',text:'image'}]}),/Describe images/);
});
test('automatic replacement keeps active avatar until success, activates once and deduplicates billed requests',async()=>{
 const {replaceAvatar}=await import('../scripts/muse-avatar.mjs');const {randomUUID}=await import('node:crypto');
 await uploadAvatar('replace',source);const original=await readAvatar('replace'),sheet=await sharp({create:{width:768,height:768,channels:3,background:'#446688'}}).png().toBuffer();let release,calls=0;const gate=new Promise(r=>release=r);const body={source,operationId:randomUUID(),confirmCost:true,maxCostUsd:.01,shareWithMeta:true};
 const promise=replaceAvatar('replace',body,new AbortController().signal,async()=>{calls++;await gate;return {ok:true,json:async()=>({data:[{b64_json:sheet.toString('base64')}]})};});
 await new Promise(r=>setTimeout(r,30));assert.equal((await readAvatar('replace')).activeVersion,original.activeVersion);await assert.rejects(replaceAvatar('replace',{...body,operationId:randomUUID()},new AbortController().signal,()=>{throw Error('must not call')}),/being updated/);release();const result=await promise;assert.ok(result.gazeVersion);assert.equal((await readAvatar('replace')).active,true);assert.equal((await replaceAvatar('replace',body,new AbortController().signal,()=>{throw Error('duplicate')})).gazeVersion,result.gazeVersion);assert.equal(calls,1);
});
test('replacement cancellation/failure preserves active source and budget stops further billing',async()=>{
 const {replaceAvatar,avatarOperation}=await import('../scripts/muse-avatar.mjs');const {randomUUID}=await import('node:crypto');await uploadAvatar('cancel',source);const original=await readAvatar('cancel');let calls=0;const abort=new AbortController(),body={source,operationId:randomUUID(),confirmCost:true,maxCostUsd:.01,shareWithMeta:true};
 await assert.rejects(replaceAvatar('cancel',body,abort.signal,async()=>{calls++;abort.abort();throw Error('cancelled')}));assert.equal((await readAvatar('cancel')).version,original.version);assert.equal((await avatarOperation('cancel',body.operationId)).status,'cancelled');await assert.rejects(replaceAvatar('cancel',body,new AbortController().signal,()=>{throw Error('must not retry')}),/already submitted/);
 process.env.MUSE_AVATAR_DAILY_BUDGET_USD='.01';await assert.rejects(replaceAvatar('cancel',{...body,operationId:randomUUID()},new AbortController().signal,()=>{calls++;}),/budget/);delete process.env.MUSE_AVATAR_DAILY_BUDGET_USD;assert.equal(calls,1);
});
