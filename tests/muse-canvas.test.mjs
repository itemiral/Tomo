import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentText } from '../src/components/muze/document-text.ts';
const directory=await mkdtemp(join(tmpdir(),'muse-canvas-test-'));process.env.MUZE_PRIVATE_DIR=directory;
const {readMuseCanvas,saveMuseCanvas,describeMuseCanvas}=await import('../scripts/muse-canvas.mjs');
const {readMuseNote,saveMuseNote,museDirectory}=await import('../scripts/muse-store.mjs');
after(()=>rm(directory,{recursive:true,force:true}));
test('Fabric notebook documents write canonical files and preserve canvas drawing data across reload',async()=>{
 const snapshot=await readMuseCanvas('owner');const board=snapshot.board;
 board.pages[0].objects.find(o=>o.id==='muse-file-soul').markdown='# My style\n\nBe concise.';
 board.pages[0].objects.push({id:'shape',type:'Rect',left:600,top:300,width:120,height:80,fill:'#eeddcc'});
 board.comments.push({id:'anchored',author:'You',text:'At this spot',pageId:board.activePage,x:321.5,y:-42});
 const result=await saveMuseCanvas('owner',{...snapshot,board});
 assert.equal((await readMuseNote('owner','soul')).content,'# My style\n\nBe concise.');
 const loaded=await readMuseCanvas('owner');assert.equal(loaded.revision,result.revision);assert.deepEqual(loaded.board.comments.find(c=>c.id==='anchored'),{id:'anchored',author:'You',text:'At this spot',pageId:board.activePage,x:321.5,y:-42});assert.ok(loaded.board.pages[0].objects.some(o=>o.id==='shape'));
 assert.ok((await readFile(join(museDirectory('owner'),'canvas.json'),'utf8')).includes('shape'));
 assert.ok(!(await readMuseCanvas('other')).board.pages[0].objects.some(o=>o.id==='shape'));
});
test('typed context includes groups, document source, comments and geometry, without transmitting image pixels',async()=>{
 const snapshot=await readMuseCanvas('media');snapshot.board.pages[0].objects.push({id:'g',type:'Group',objects:[{id:'doc',type:'MuzeDocument',markdown:'# Remember\nFriday',text:'Remember',documentTitle:'todo.md',left:10,top:20,width:300},{id:'img',type:'Image',src:'data:image/png;base64,PRIVATEPIXELS',width:20,height:20},{id:'path',type:'Path',path:[['M',0,0],['L',10,10]],width:10,height:10}]});snapshot.board.comments.push({id:'comment',author:'You',text:'Weekly review'});
 const context=describeMuseCanvas(snapshot.board);assert.match(context,/Friday/);assert.match(context,/Weekly review/);assert.match(context,/Drawing: geometry only/);assert.match(context,/Private image/);assert.doesNotMatch(context,/PRIVATEPIXELS|data:image/);
});
test('file conflicts and deleting canonical document cards reject without overwriting files',async()=>{
 const snapshot=await readMuseCanvas('conflict');const note=await readMuseNote('conflict','memory');await saveMuseNote('conflict','memory','External update',note.revision);
 await assert.rejects(saveMuseCanvas('conflict',snapshot),/changed elsewhere/);assert.equal((await readMuseNote('conflict','memory')).content,'External update');
 const fresh=await readMuseCanvas('conflict');fresh.board.pages[0].objects=fresh.board.pages[0].objects.filter(o=>o.id!=='muse-file-memory');await assert.rejects(saveMuseCanvas('conflict',fresh),/Keep the/);
});
test('oversized context is rejected visibly rather than silently omitted',async()=>{
 const snapshot=await readMuseCanvas('large');snapshot.board.pages[0].objects.push({type:'MuzeDocument',id:'large',markdown:'x'.repeat(65000),text:'large',documentTitle:'large.md',width:300});await assert.rejects(saveMuseCanvas('large',snapshot),/more context/);
});
test('document presentation preserves source separately and does not fetch image references',()=>{
 const source='# A heading\n\n**Bold**\n- one\n![photo](https://example.com/private.png)';const display=documentText(source,'note.md');assert.match(display,/note.md/);assert.match(display,/A heading/);assert.match(display,/• one/);assert.match(display,/not loaded/);assert.doesNotMatch(display,/https:\/\//);
});
test('Muse rename is canonical, scoped, unicode-safe and rejects invalid edits without losing the saved name',async()=>{
 const {ensureMuse}=await import('../scripts/muse-store.mjs');let snapshot=await readMuseCanvas('named');let name=snapshot.board.pages[0].objects.find(o=>o.id==='muse-name');assert.equal(name.text,'Hello, my name is Muse.');name.text='Hello, my name is 小月 🐾.';await saveMuseCanvas('named',snapshot);assert.equal((await ensureMuse('named')).name,'小月 🐾');assert.equal((await ensureMuse('another-name')).name,'Muse');snapshot=await readMuseCanvas('named');assert.equal(snapshot.board.pages[0].objects.find(o=>o.id==='muse-name').text,'Hello, my name is 小月 🐾.');snapshot.board.pages[0].objects.find(o=>o.id==='muse-name').text='Hello, my name is <script>.';await assert.rejects(saveMuseCanvas('named',snapshot),/markup/);assert.equal((await ensureMuse('named')).name,'小月 🐾');snapshot.board.pages[0].objects.find(o=>o.id==='muse-name').text='Hello, my name is    .';await assert.rejects(saveMuseCanvas('named',snapshot),/1–40/);
});
