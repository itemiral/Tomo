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
const { sharedBoard, boardId, inviteToken } = await import(pathToFileURL(join(dir, 'validation.mjs')));
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
  for (const object of [{ id: 'image', type: 'Image', src: 'https://example.com/tracker.png' }, { id: 'bad', type: 'ArbitraryClass' }, { id: 'muse-file-soul', type: 'Textbox', text: 'private' }]) {
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
