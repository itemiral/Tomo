import sharp from 'sharp';
import { readFile, writeFile, rename, withMuseLease } from './muse-storage.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMuse, museDirectory, MuseStoreError } from './muse-store.mjs';
import { digest } from './muse-local.mjs';

const locks = new Set();
async function exclusive(owner, fn) {
  if (locks.has(owner)) throw new MuseStoreError(409, 'Your avatar is being updated. Please wait.');
  locks.add(owner); try { return await withMuseLease(owner, 'avatar', fn); } finally { locks.delete(owner); }
}
export async function readAvatar(owner) {
  await ensureMuse(owner);
  try { return JSON.parse(await readFile(join(museDirectory(owner), 'avatar.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeAvatar(owner, avatar) {
  const path = join(museDirectory(owner), 'avatar.json'), temp = path + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(avatar), { mode: 0o600, flag: 'wx' }); await rename(temp, path);
}
export function avatarSummary(a) { return a ? { iconVersion: a.version, gazeVersion: a.activeVersion || (a.active ? a.candidateVersion : null), candidateVersion: a.candidateVersion || null } : {}; }
export async function uploadAvatar(owner, source) {
  return exclusive(owner, async () => {
    if (typeof source !== 'string' || source.length > 13_400_000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) throw new MuseStoreError(400, 'Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
    const bytes = Buffer.from(source.split(',')[1], 'base64');
    let preview;
    try { preview = await sharp(bytes, { limitInputPixels: 25_000_000, animated: false }).rotate().resize(256, 256, { fit: 'contain', background: '#f9fafb' }).png().toBuffer(); }
    catch { throw new MuseStoreError(400, 'That image could not be decoded. Choose another image.'); }
    await ensureMuse(owner);
    const avatar = { source, preview: preview.toString('base64'), version: digest(bytes), active: false };
    await writeAvatar(owner, avatar); return avatarSummary(avatar);
  });
}
export async function generateAvatar(owner, body, signal, fetcher = fetch) {
  if (body.confirmCost !== true || body.maxCostUsd !== 0.01 || body.shareWithMeta !== true) throw new MuseStoreError(400, 'Confirm sharing this image with Meta and the $0.01 generation cost.');
  if (!process.env.MODEL_API_KEY) throw new MuseStoreError(503, 'Image generation is not configured.');
  return exclusive(owner, async () => {
    const avatar = await readAvatar(owner);
    if (!avatar || avatar.version !== body.sourceVersion) throw new MuseStoreError(409, 'The source image changed. Reload before generating.');
    const sheet=await renderGazeSheet(avatar.preview,signal,fetcher);
    const next = { ...avatar, candidate: sheet.toString('base64'), candidateVersion: digest(sheet), active: false };
    await writeAvatar(owner, next); return avatarSummary(next);
  });
}
export async function activateAvatar(owner, version) {
  return exclusive(owner, async () => {
    const avatar = await readAvatar(owner);
    if (!avatar?.candidateVersion || version !== avatar.candidateVersion) throw new MuseStoreError(409, 'This preview changed. Reload before using it.');
    avatar.active = true; avatar.activeSheet = avatar.candidate; avatar.activeVersion = avatar.candidateVersion; await writeAvatar(owner, avatar); return avatarSummary(avatar);
  });
}

async function renderGazeSheet(preview,signal,fetcher) {
    const prompt = 'Create ONE square sprite sheet in an exact 3 by 3 grid of nine equally sized cells. Use the reference pet or character in EVERY cell, retaining its identity, colors, markings and style. Identical camera, lighting, head size, center position and neutral cool-white (#f9fafb) background in every cell. Keep the whole head inside each cell with identical generous padding. No borders, labels, text, or extra subjects. The body stays fixed; vary only eye gaze and subtle head orientation. In row-major order the gaze directions relative to the viewer are: upper-left, up, upper-right; left, directly forward, right; lower-left, down, lower-right. All nine cells must show the SAME individual. Do not crop any ears or hair.';
    let response;
    try { response = await fetcher('https://api.meta.ai/v1/images/edits', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'muse-image-1.0', prompt, images: [{ image_url: 'data:image/png;base64,' + preview }], n: 1, size: '1024x1024', response_format: 'b64_json', output_format: 'png', reasoning_strength: 'low', tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false } }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) }); }
    catch { throw new MuseStoreError(504, 'Generation did not finish. Your source is safe. Check usage before trying again.'); }
    if (!response.ok) throw new MuseStoreError(response.status === 429 ? 429 : 502, 'Meta could not generate this avatar. Your current avatar is unchanged.');
    let sheet;
    try {
      const data = await response.json(), encoded = data.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || encoded.length > 20_000_000) throw Error();
      const bytes = Buffer.from(encoded, 'base64');
      const info = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
      if (!info.width || !info.height || info.width < 300 || Math.abs(info.width / info.height - 1) > .03) throw Error();
      sheet = await sharp(bytes).resize(768, 768).png().toBuffer();
    } catch { throw new MuseStoreError(502, 'The generated image was not a usable square sheet. Your current avatar is unchanged.'); }
    if (signal.aborted) throw new MuseStoreError(499, 'Generation cancelled.');
    return sheet;
}

const operationPath=owner=>join(museDirectory(owner),'avatar-operations.json');
async function operations(owner){try{return JSON.parse(await readFile(operationPath(owner),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function saveOperations(owner,rows){const path=operationPath(owner),temp=path+'.'+randomUUID();await writeFile(temp,JSON.stringify(rows),{mode:0o600,flag:'wx'});await rename(temp,path);}
export async function avatarOperation(owner,id){
 await ensureMuse(owner);const current=await readAvatar(owner);
 if(current?.operationId===id)return {status:'completed',...avatarSummary(current)};
 const row=(await operations(owner)).find(o=>o.id===id);
 return {status:row?.status||'not-found',mayHaveCharged:!!row};
}
export async function replaceAvatar(owner,body,signal,fetcher=fetch){
 if(body.confirmCost!==true||body.maxCostUsd!==.01||body.shareWithMeta!==true)throw new MuseStoreError(400,'Choose the image again to generate your avatar.');
 if(typeof body.operationId!=='string'||! /^[a-f0-9-]{36}$/i.test(body.operationId))throw new MuseStoreError(400,'Choose the image again.');
 if(!process.env.MODEL_API_KEY)throw new MuseStoreError(503,'Image generation is not configured.');
 return exclusive(owner,async()=>{
  await ensureMuse(owner);const previous=await readAvatar(owner),rows=await operations(owner),existing=rows.find(o=>o.id===body.operationId);
  if(previous?.operationId===body.operationId)return {status:'completed',...avatarSummary(previous)};
  if(existing)throw new MuseStoreError(409,'This attempt was already submitted. Check its status before starting another attempt.');
  const source=body.source;
  if(typeof source!=='string'||source.length>13_400_000||!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source))throw new MuseStoreError(400,'Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
  const bytes=Buffer.from(source.split(',')[1],'base64');let preview;
  try{preview=await sharp(bytes,{limitInputPixels:25_000_000,animated:false}).rotate().resize(256,256,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();}catch{throw new MuseStoreError(400,'That image could not be decoded.');}
  const budget=Number(process.env.MUSE_AVATAR_DAILY_BUDGET_USD??'.10'),day=new Date().toISOString().slice(0,10);
  if(!Number.isFinite(budget)||budget<.01||rows.filter(o=>o.day===day).length>=Math.floor(budget*100+1e-6))throw new MuseStoreError(429,'Today’s avatar generation budget has been reached. Your current avatar is unchanged.');
  if(signal.aborted)throw new MuseStoreError(499,'Replacement cancelled.');
  const operation={id:body.operationId,day,status:'running',reservedUsd:.01};rows.push(operation);await saveOperations(owner,rows);
  try{
   const sheet=await renderGazeSheet(preview.toString('base64'),signal,fetcher);
   if(signal.aborted)throw new MuseStoreError(499,'Replacement cancelled.');
   // Swap only after a complete valid result. Keep the previous original for recovery.
   if(previous)await writeFile(join(museDirectory(owner),'avatar-previous.json'),JSON.stringify(previous),{mode:0o600});
   const version=digest(bytes),gazeVersion=digest(sheet);
   const next={source,preview:preview.toString('base64'),version,active:true,activeSheet:sheet.toString('base64'),activeVersion:gazeVersion,operationId:body.operationId};
   await writeAvatar(owner,next);operation.status='completed';await saveOperations(owner,rows);
   return {status:'completed',...avatarSummary(next)};
  }catch(error){operation.status=signal.aborted?'cancelled':'failed-or-uncertain';await saveOperations(owner,rows);throw error;}
 });
}
