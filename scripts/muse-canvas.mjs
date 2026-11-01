import {NAME_PREFIX,nameFromText,museNameStyles} from '../src/lib/muse-name.ts';
import { readFile, writeFile, rename } from './muse-storage.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMuse, museDirectory, readMuseNote, saveMuseNoteUnlocked, readMuseBoard, withMuseOwner, MuseStoreError } from './muse-store.mjs';
import { readAvatar } from './muse-avatar.mjs';
import { digest } from './muse-local.mjs';
import { documentColor } from '../src/components/muze/document-color.ts';
import { parseBoardFile } from '../src/components/muze/storage.ts';

export const MUSE_COMMENT = 'A little notebook for your Muse. Your words, comments and drawings become context. Pictures stay in your private notebook—add a caption for what Muse should know.';
const noteIds = { soul: 'muse-file-soul', memory: 'muse-file-memory' };
export function walkObjects(objects, visit) { for (const o of objects) { visit(o); if (Array.isArray(o.objects)) walkObjects(o.objects, visit); } }
function fileCard(key, text, x, y, angle) {
  return { type:'MuzeDocument', markdown:text, documentTitle:key+'.md', id:noteIds[key], muzeKind:'note', left:x, top:y, width:430, boxHeight:360, inset:28, angle, text, fontFamily:'IBM Plex Sans', fontSize:18, lineHeight:1.3, fill:'#202124', backgroundColor:documentColor(key+'.md'), stroke:'#202124', strokeWidth:0, verticalAlign:'top' };
}
async function initialBoard(owner, notes) {
  const old = await readMuseBoard(owner);
  const objects = [fileCard('soul',notes.soul.content,220,190,-2),fileCard('memory',notes.memory.content,750,270,2)];
  old.cards.forEach((c,i)=>objects.push({...fileCard('memory',c.text,240+(i%2)*500,850+Math.floor(i/2)*320,0),id:c.id,documentTitle:'Memory note.md',width:420,boxHeight:240}));
  return {id:'muse-private',name:'My Muse’s notebook',activePage:'muse-notebook',pages:[{id:'muse-notebook',name:'Notebook',objects,viewport:[.75,0,0,.75,0,0]}],comments:[{id:'muse-welcome',pageId:'muse-notebook',x:1230,y:150,author:'Muze',text:MUSE_COMMENT},...old.comments]};
}
async function raw(owner) { try { return await readFile(join(museDirectory(owner),'canvas.json'),'utf8'); } catch(e) { if(e.code==='ENOENT') return null; throw e; } }
export async function readMuseCanvas(owner) {
  const identity=await ensureMuse(owner);
  const notes = {soul:await readMuseNote(owner,'soul'),memory:await readMuseNote(owner,'memory')};
  const text = await raw(owner), board = text ? JSON.parse(text) : await initialBoard(owner,notes);
  let nameObject;for(const page of board.pages)walkObjects(page.objects,o=>{if(o.id==='muse-name')nameObject=o;});
  if(!nameObject){nameObject={type:'MuzeText',id:'muse-name',muzeKind:'muse-name',left:220,top:100,width:950,fontFamily:'Inter',fontSize:40,fill:'#202124',editable:false,autoWidth:true,text:NAME_PREFIX+identity.name+'.'};board.pages[0].objects.push(nameObject);}
  nameObject.editable=false;nameObject.styles=museNameStyles(identity.name);nameObject.fontSize=40;nameObject.width=Math.max(950,nameObject.width||0);board.museName=identity.name;
  const avatar=await readAvatar(owner);
  const preview=avatar?.preview || (await readFile(new URL('../public/muse/default-avatar.png',import.meta.url))).toString('base64');
  let appearance;
  for(const page of board.pages) walkObjects(page.objects,o=>{if(o.id==='muse-appearance')appearance=o;});
  if(!appearance){appearance={type:'Image',id:'muse-appearance',muzeKind:'muse-appearance',left:1240,top:300,width:256,height:256,scaleX:1,scaleY:1};board.pages[0].objects.push(appearance);}
  appearance.src='data:image/png;base64,'+preview;
  // File content is canonical, even when edited outside the canvas.
  for(const page of board.pages) walkObjects(page.objects,o=>{for(const key of ['soul','memory']) if(o.id===noteIds[key]) {o.text=notes[key].content;o.markdown=notes[key].content;o.type='MuzeDocument';o.documentTitle=key+'.md';}});
  return {board,revision:digest(text || ''),notes:{soul:notes.soul.revision,memory:notes.memory.revision},context:describeMuseCanvas(board)};
}
export function describeMuseCanvas(board) {
  const pages = board.pages.map(page=>{
    const objects=[];
    walkObjects(page.objects,o=>{
      const type=String(o.type), entry={id:String(o.id||''),type,position:{x:o.left||0,y:o.top||0,width:o.width||0,height:o.height||o.boxHeight||0,angle:o.angle||0}};
      const key=Object.keys(noteIds).find(k=>noteIds[k]===o.id);
      if(key) {entry.file=key+'.md';entry.status='Canonical text supplied separately';}
      else if(typeof o.markdown==='string') entry.markdown=o.markdown.replace(/data:[^\s)]+/g,'[embedded data is not sent]');
      else if(typeof o.text==='string') entry.text=o.text.replace(/data:[^\s)]+/g,'[embedded data is not sent]');
      if(o.id==='muse-appearance') entry.role='Muse appearance reference; swapping uses the avatar upload action';
      if(type==='Image') entry.status='Private image: pixels not sent or interpreted; any nearby caption is user-provided context';
      else if(type==='Path') {entry.status='Drawing: geometry only, no visual interpretation';entry.stroke=o.stroke;entry.pathSegments=Array.isArray(o.path)?o.path.length:0;}
      else if(type==='Group') entry.status='Group; members listed separately';
      else {entry.shape=o.geo||o.muzeKind||type; if(o.fill)entry.fill=o.fill;if(o.stroke)entry.stroke=o.stroke;}
      if(o.labelFor)entry.labelFor=o.labelFor;
      if(o.startBinding)entry.startBinding=o.startBinding;
      if(o.endBinding)entry.endBinding=o.endBinding;
      objects.push(entry);
    });
    return {name:page.name,objects};
  });
  return JSON.stringify({name:board.name,pages,comments:board.comments||[],mediaPolicy:'Image pixels are not included in this context. Geometry descriptions are not pixel understanding.'});
}
export async function saveMuseCanvas(owner,body) {
  await ensureMuse(owner);
  if(!body || typeof body.revision!=='string' || !body.notes) throw new MuseStoreError(400,'Reload this notebook before saving.');
  let board;
  try { board=parseBoardFile(JSON.stringify({format:'muze',version:1,board:body.board})); } catch(e) { throw new MuseStoreError(400,e.message); }
  board.id='muse-private';
  const found={};let count=0,appearances=0,names=0,nameObject;
  for(const page of board.pages) walkObjects(page.objects,o=>{count++;if(o.id==='muse-name'){names++;nameObject=o;}if(o.id==='muse-appearance')appearances++;for(const key of ['soul','memory']) if(o.id===noteIds[key]) {if(found[key]) throw new MuseStoreError(400,'Keep one original card for each Muse file.');found[key]=o;}});
  if(names>1)throw new MuseStoreError(400,'Keep one name on this board.');
  if(nameObject){try{board.museName=nameFromText(nameObject.text);nameObject.text=NAME_PREFIX+board.museName+'.';nameObject.styles=museNameStyles(board.museName);nameObject.editable=false;}catch(e){throw new MuseStoreError(400,e.message);}}else {board.museName=(await ensureMuse(owner)).name;}
  if(appearances!==1) throw new MuseStoreError(400,'Keep one Muse appearance image on this board. Undo its removal or duplication, then use Swap image to change it.');
  if(!found.soul || !found.memory) throw new MuseStoreError(400,'Keep the soul.md and memory.md cards in your notebook. Undo their removal to save.');
  if(count>1000 || describeMuseCanvas(board).length>64000) throw new MuseStoreError(413,'This notebook has more context than Muse can use. Shorten some text or remove a few objects; your draft stays open.');
  const content=JSON.stringify(board);
  if(Buffer.byteLength(content)>20_000_000) throw new MuseStoreError(413,'This notebook is over 20 MB. Use smaller local images.');
  return withMuseOwner(owner,async()=>{
    if(digest((await raw(owner))||'')!==body.revision) throw new MuseStoreError(409,'This notebook changed elsewhere. Your draft is preserved; reload the saved notebook or export your draft.');
    const notes={soul:await readMuseNote(owner,'soul'),memory:await readMuseNote(owner,'memory')};
    for(const key of ['soul','memory']) {
      if(notes[key].revision!==body.notes[key]) throw new MuseStoreError(409,key+'.md changed elsewhere. Your draft is preserved; reload before saving.');
      if(typeof (found[key].markdown ?? found[key].text)!=='string' || Buffer.byteLength((found[key].markdown ?? found[key].text))>512000 || (found[key].markdown ?? found[key].text).includes('\0')) throw new MuseStoreError(400,'Keep Muse files under 500 KB of text.');
    }
    for(const key of ['soul','memory']) if(notes[key].content!==(found[key].markdown ?? found[key].text)) notes[key]=await saveMuseNoteUnlocked(owner,key,(found[key].markdown ?? found[key].text),notes[key].revision);
    const path=join(museDirectory(owner),'canvas.json'), temp=path+'.'+randomUUID();
    await writeFile(temp,content,{flag:'wx',mode:0o600});await rename(temp,path);
    return {name:board.museName,revision:digest(content),notes:{soul:notes.soul.revision,memory:notes.memory.revision}};
  });
}
export async function museCanvasContext(owner) { return describeMuseCanvas((await readMuseCanvas(owner)).board); }
