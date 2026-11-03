import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
const dir = await mkdtemp(join(tmpdir(), 'muze-board-validation-'));
const output = await build({ entryPoints: ['src/server/boards/validation.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
await writeFile(join(dir, 'validation.mjs'), output.outputFiles[0].text);
const { sharedBoard, readSharedBoard, boardId, inviteToken } = await import(pathToFileURL(join(dir, 'validation.mjs')));
after(() => rm(dir, { recursive: true, force: true }));
const fixture = () => ({ id: randomUUID(), name: 'Shared board', activePage: 'p', pages: [{ id: 'p', name: 'Page 1', objects: [{ id: 'note', type: 'Textbox', text: 'Hello' }], viewport: [1, 0, 0, 1, 0, 0] }] });

test('cloud snapshots retain their cloud ID and discard unrelated top-level data', () => {
  const value = fixture();
  const result = sharedBoard({ ...value, irrelevant: 'discarded' }, value.id);
  assert.equal(result.id, value.id);
  assert.equal(result.irrelevant, undefined);
  assert.equal(result.pages[0].objects[0].text, 'Hello');
  const grouped = fixture();
  grouped.pages[0].objects.push({ id: 'group', type: 'Group', objects: [{ type: 'Rect', width: 20, height: 20 }] });
  assert.equal(sharedBoard(grouped).pages[0].objects.length, 2, 'group children do not require merge IDs');
});
test('unsafe images, unknown classes, duplicate object IDs, and private Muse files cannot be loaded or shared', () => {
  for (const object of [{ id: 'image', type: 'Image', src: 'https://example.com/tracker.png' }, { id: 'bad', type: 'ArbitraryClass' }, { id:'not-a-type',type:['Rect'] }, { id: 'muse-file-soul', type: 'Textbox', text: 'private' }]) {
    const board = fixture(); board.pages[0].objects.push(object);
    assert.throws(() => sharedBoard(board), { status: 400 });
  }
  const repeated = fixture(); repeated.pages[0].objects.push({ ...repeated.pages[0].objects[0] });
  assert.throws(() => sharedBoard(repeated), { status: 400 });
  assert.throws(() => sharedBoard({ ...fixture(), id: 'muse-private' }), { status: 400 });
  assert.throws(() => sharedBoard({ ...fixture(), name: 'x'.repeat(3_000_000) }), { status: 413 });
  assert.throws(() => boardId('../../muse/canvas'), { status: 400 });
  assert.throws(() => inviteToken('short'), { status: 400 });
});


test('merge keys are unique through nested groups and comments without rejecting legacy anonymous children', () => {
  const valid = fixture();
  valid.pages[0].objects.push({id:'group',type:'Group',objects:[{type:'Rect',id:'child'},{type:'Rect'}]});
  assert.doesNotThrow(() => sharedBoard(valid));
  for (const bad of [
    {...valid,pages:[{...valid.pages[0],id:''}]},
    {...valid,pages:[{...valid.pages[0],objects:[...valid.pages[0].objects,{id:'child',type:'Rect'}]}]},
    {...valid,comments:[{id:'same',text:'One',author:'A'},{id:'same',text:'Two',author:'B'}]},
    {...valid,comments:[{id:'',text:'One',author:'A'}]},
  ]) assert.throws(() => sharedBoard(bad), {status:400});
});


test('saved snapshots discard malformed optional links while preserving attribution and strict writes', () => {
  const value = fixture();
  value.pages[0].objects.push({id:'group',type:'Group',objects:[{
    id:'image',type:'Image',src:'data:image/png;base64,fixture',left:20,top:40,
    sourceUrl:'https://xn--a.example/source',imageUrl:'https://xn--.example/picture',
    attribution:'Photo by a contributor',sourceTitle:'Reference photo',
  },{id:'valid',type:'Image',src:'data:image/png;base64,fixture',sourceUrl:'https://example.org/reference',imageUrl:'https://example.org/photo.png',attribution:'Retain this credit'}]});
  const before = structuredClone(value);
  assert.throws(() => sharedBoard(value, value.id), {status:400}, 'new writes remain strict');
  const result = readSharedBoard(value, value.id), [repaired, valid] = result.pages[0].objects[1].objects;
  assert.equal(result.id, value.id);
  assert.equal(repaired.sourceUrl, undefined); assert.equal(repaired.imageUrl, undefined);
  assert.equal(repaired.attribution, 'Photo by a contributor'); assert.equal(repaired.sourceTitle, 'Reference photo');
  assert.equal(repaired.src, 'data:image/png;base64,fixture'); assert.equal(repaired.left,20); assert.equal(repaired.top,40);
  assert.deepEqual(valid,before.pages[0].objects[1].objects[1]);
  assert.deepEqual(value,before,'reading never mutates the source snapshot');
  assert.doesNotThrow(() => sharedBoard(result,result.id));
});

test('snapshot link repair never admits invalid structures, unsafe pixels or private file cards', () => {
  for (const object of [null,{id:'bad',type:'Unsupported',sourceUrl:'https://xn--a.example/'},{id:'bad',type:'Image',src:'https://example.org/tracker.png',imageUrl:'https://xn--a.example/'},{id:'muse-file-memory',type:'MuzeDocument',markdown:'Private',sourceUrl:'https://xn--a.example/'}]) {
    const value=fixture();value.pages[0].objects.push(object);
    assert.throws(() => readSharedBoard(value,value.id),{status:400});
  }
  assert.throws(() => readSharedBoard({...fixture(),pages:[null]}),{status:400});
});
