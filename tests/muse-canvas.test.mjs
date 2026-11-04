import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentText } from '../src/components/muze/document-text.ts';
const directory=await mkdtemp(join(tmpdir(),'muse-canvas-test-'));process.env.MUZE_PRIVATE_DIR=directory;
const {readMuseCanvas,saveMuseCanvas,describeMuseCanvas,MUSE_COMMENT}=await import('../scripts/muse-canvas.mjs');
const {readMuseNote,saveMuseNote,museDirectory,ensureMuse}=await import('../scripts/muse-store.mjs');
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

const card = (snapshot, id) => snapshot.board.pages.flatMap(page => page.objects).find(object => object.id === id);
const renameDraft = (snapshot, name) => { card(snapshot, 'muse-name').text = 'Hello, my name is ' + name + '.'; return snapshot; };

test('renaming Muse updates the canonical introduction through successive names while preserving custom notes', async () => {
 const owner = 'rename-soul';
 let snapshot = await readMuseCanvas(owner);
 const initialSoul = card(snapshot, 'muse-file-soul').markdown;
 const customBody = '\n## My preferences\nUse short paragraphs. Muse is also a product I use.\n';
 const memory = '# Memory\nKeep the names Muse and Kumo in this meeting record.\n';
 card(snapshot, 'muse-file-soul').markdown = initialSoul + customBody;
 card(snapshot, 'muse-file-memory').markdown = memory;
 await saveMuseCanvas(owner, snapshot);
 const identity = await ensureMuse(owner);
 for (const name of ['Kumo', 'Nova', 'Muse']) {
  snapshot = renameDraft(await readMuseCanvas(owner), name);
  const saved = await saveMuseCanvas(owner, snapshot);
  const expected = 'My name is ' + name + '.\n\n' + initialSoul + customBody;
  assert.equal((await readMuseNote(owner, 'soul')).content, expected);
  assert.equal((await readMuseNote(owner, 'memory')).content, memory);
  const reloaded = await readMuseCanvas(owner);
  assert.equal(reloaded.board.museName, name);
  assert.equal(card(reloaded, 'muse-file-soul').markdown, expected);
  assert.equal(card(reloaded, 'muse-file-soul').text, expected);
  const serialized = JSON.parse(await readFile(join(museDirectory(owner), 'canvas.json'), 'utf8'));
  assert.equal(serialized.pages[0].objects.find(object => object.id === 'muse-file-soul').markdown, expected);
  assert.equal(reloaded.notes.soul, saved.notes.soul);
  assert.deepEqual(await ensureMuse(owner), { ...identity, name });
 }
 assert.equal((await readMuseNote('rename-other-owner', 'soul')).content, initialSoul);
});

test('custom soul text gets a single name declaration on rename and stays untouched on same-name saves', async () => {
 const owner = 'rename-custom-soul', custom = 'Keep answers short.\nMuse and Kumo are names in a historical example.\n';
 let snapshot = await readMuseCanvas(owner);
 card(snapshot, 'muse-file-soul').markdown = custom;
 await saveMuseCanvas(owner, snapshot);
 assert.equal((await readMuseNote(owner, 'soul')).content, custom, 'saving an unchanged name must not add an introduction');
 await saveMuseCanvas(owner, renameDraft(await readMuseCanvas(owner), 'Kumo'));
 const first = (await readMuseNote(owner, 'soul')).content;
 assert.ok(first.includes(custom));
 assert.match(first.replace(custom, ''), /Kumo/);
 assert.ok(first.length - custom.length < 100, 'the added identity declaration should stay minimal');
 await saveMuseCanvas(owner, await readMuseCanvas(owner));
 assert.equal((await readMuseNote(owner, 'soul')).content, first);
 await saveMuseCanvas(owner, renameDraft(await readMuseCanvas(owner), 'Nova'));
 const next = (await readMuseNote(owner, 'soul')).content;
 assert.equal(next, first.replace('Kumo', 'Nova'));
 assert.ok(next.includes(custom), 'historical name references must not be rewritten');
});

test('an external soul edit rejects the entire stale rename without changing the name or memory', async () => {
 const owner = 'rename-soul-conflict';
 await saveMuseCanvas(owner, await readMuseCanvas(owner));
 const snapshot = renameDraft(await readMuseCanvas(owner), 'Kumo');
 const identity = await ensureMuse(owner), memory = await readMuseNote(owner, 'memory');
 const originalCanvas = await readFile(join(museDirectory(owner), 'canvas.json'), 'utf8');
 card(snapshot, 'muse-file-memory').markdown = 'This stale edit must not save.';
 const soul = await readMuseNote(owner, 'soul');
 await saveMuseNote(owner, 'soul', '# Soul\nAn external edit that must survive.', soul.revision);
 await assert.rejects(saveMuseCanvas(owner, snapshot), { status: 409 });
 assert.deepEqual(await ensureMuse(owner), identity);
 assert.equal((await readMuseNote(owner, 'soul')).content, '# Soul\nAn external edit that must survive.');
 assert.equal((await readMuseNote(owner, 'memory')).content, memory.content);
 assert.equal(await readFile(join(museDirectory(owner), 'canvas.json'), 'utf8'), originalCanvas);
});

test('saved default welcome comments adopt current copy while custom welcome comments remain unchanged', async () => {
 const owner = 'welcome-copy', snapshot = await readMuseCanvas(owner);
 const welcome = snapshot.board.comments.find(comment => comment.id === 'muse-welcome');
 assert.ok(welcome);
 const prefix = 'A little notebook for your Muse. Your words, comments and drawings become context. ';
 for (const message of [
  prefix + 'Pictures stay local—add a caption for what Muse should know.',
  prefix + 'Pictures stay in your private notebook—add a caption for what Muse should know.',
 ]) {
  welcome.text = message;
  await writeFile(join(museDirectory(owner), 'canvas.json'), JSON.stringify(snapshot.board));
  const reloaded = await readMuseCanvas(owner);
  assert.equal(reloaded.board.comments.find(comment => comment.id === 'muse-welcome').text, MUSE_COMMENT);
 }
 assert.equal(MUSE_COMMENT, 'Your private Muse notebook. Your notes, comments, and captions help Muse understand you.');
 welcome.text = 'My own welcome and planning reminders.';
 await writeFile(join(museDirectory(owner), 'canvas.json'), JSON.stringify(snapshot.board));
 assert.equal((await readMuseCanvas(owner)).board.comments.find(comment => comment.id === 'muse-welcome').text, welcome.text);
});

test('reopening an older renamed notebook repairs only its exact default soul introduction once', async () => {
 const owner = 'legacy-renamed-soul', snapshot = renameDraft(await readMuseCanvas(owner), 'Kumo');
 snapshot.board.museName = 'Kumo';
 const original = '# Soul\n\n## Who I am\nI’m Muse, your companion inside Muze.\n\n## Custom detail\nKeep this body and the word Muse unchanged.\n';
 const path = join(museDirectory(owner), 'soul.md');
 await writeFile(join(museDirectory(owner), 'canvas.json'), JSON.stringify(snapshot.board));
 await writeFile(path, original);
 const reloaded = await readMuseCanvas(owner);
 const expected = original.replace('I’m Muse, your companion inside Muze.', 'I’m Kumo, your companion inside Muze.');
 assert.equal(card(reloaded, 'muse-file-soul').markdown, expected);
 assert.equal(await readFile(path, 'utf8'), expected);
 const note = await readMuseNote(owner, 'soul');
 assert.equal((await ensureMuse(owner)).name, 'Kumo');
 await readMuseCanvas(owner);
 assert.deepEqual(await readMuseNote(owner, 'soul'), note, 'reopening must not rewrite the already-repaired note');
 for (const custom of [
  '# My soul\n\nI’m Muse, your companion inside Muze.\nA custom introduction.',
  '# Soul\n\n## Who I am\nI’m Muse, your research partner.\nA custom role.',
 ]) {
  await writeFile(path, custom);
  await readMuseCanvas(owner);
  assert.equal(await readFile(path, 'utf8'), custom);
 }
});
