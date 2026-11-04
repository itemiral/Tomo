import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardContext, parseBoardContext, parseMuseResponse } from '../src/lib/muse-board.ts';

const directory = await mkdtemp(join(tmpdir(), 'muze-store-test-'));
process.env.MUZE_PRIVATE_DIR = directory;
const store = await import('../scripts/muse-store.mjs');
after(() => rm(directory, { recursive: true, force: true }));

test('one Muse per verified owner, isolated notes, icons, and conversations', async () => {
  const a = await store.ensureMuse('owner-a'), b = await store.ensureMuse('owner-b');
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await store.ensureMuse('owner-a'), a);
  const soul = await store.readMuseNote('owner-a', 'soul');
  assert.match(soul.content, /Who I am/);
  assert.doesNotMatch(soul.content, /Make me yours/);
  await store.saveMuseNote('owner-a', 'soul', '# Private preference\nUse short steps.', soul.revision);
  assert.doesNotMatch((await store.readMuseNote('owner-b', 'soul')).content, /Private preference/);
  assert.equal((await store.readMuseNote('owner-a', 'soul')).content, '# Private preference\nUse short steps.');
  await store.saveMuseChat('owner-a', 'board:page', [{ id: '1', role: 'user', content: 'My private idea' }]);
  assert.deepEqual(await store.readMuseChat('owner-b', 'board:page'), []);
  assert.equal((await store.readMuseChat('owner-a', 'board:page'))[0].content, 'My private idea');
  assert.equal(await store.readMuseIcon('owner-b'), null);
  assert.equal((await stat(join(store.museDirectory('owner-a'), 'soul.md'))).mode & 0o777, 0o600);
  assert.equal((await stat(store.museDirectory('owner-a'))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(join(store.museDirectory('owner-a'), 'identity.json'), 'utf8')).ownerId, 'owner-a');
});

test('concurrent edits reject stale revisions without replacing the winner', async () => {
  const note = await store.readMuseNote('concurrent-owner', 'memory');
  const results = await Promise.allSettled(['First edit', 'Second edit'].map(content => store.saveMuseNote('concurrent-owner', 'memory', content, note.revision)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await store.readMuseNote('concurrent-owner', 'memory')).content, results.find(result => result.status === 'fulfilled').value.content);
});

test('invalid note paths, thread paths, and unsafe icons are rejected', async () => {
  await assert.rejects(store.readMuseNote('owner-a', '../soul'), { status: 404 });
  await assert.rejects(store.saveMuseIcon('owner-a', 'data:image/svg+xml,<svg/>'), { status: 400 });
  await assert.rejects(store.saveMuseIcon('owner-a', 'data:image/png;base64,AAAA'), { status: 400 });
  assert.throws(() => store.validThread('../../board:page'), { status: 400 });
});

test('large board context remains valid JSON and excludes unsafe or truncated update targets', () => {
  const objects = Array.from({ length: 150 }, (_, index) => ({ id: 'card-' + index, type: 'MuzeNote', text: 'x'.repeat(3900) }));
  const serialized = boardContext('Plan', 'Page 1', objects);
  const board = parseBoardContext(serialized);
  assert.ok(serialized.length <= 35000);
  assert.ok(board.objects.length > 0 && board.objects.length < 150);
  const protectedBoard = parseBoardContext(boardContext('Plan', 'Page', [
    { id: 'locked', type: 'MuzeNote', text: 'Private edit', isLocked: true },
    { id: 'long', type: 'MuzeNote', text: 'x'.repeat(4500) },
    { id: 'label', type: 'MuzeLabel', text: 'Shape label', labelFor: 'shape' },
  ]));
  assert.ok(protectedBoard.objects.every(object => !object.editable));
});

test('model updates must name existing editable cards and carry their original text', () => {
  const board = parseBoardContext(boardContext('Plan', 'Page', [{ id: 'existing', type: 'MuzeNote', text: 'Original plan' }]));
  const response = { reply: 'Prepared the next step.', cards: [{ title: 'Next step', body: 'Choose a date.' }], updates: [{ id: 'existing', text: 'Revised plan' }] };
  const result = parseMuseResponse(response, board, 'turn');
  assert.equal(result.actions.updates[0].expectedText, 'Original plan');
  assert.equal(result.actions.cards[0].id, 'muse-turn-0');
  assert.throws(() => parseMuseResponse({ ...response, updates: [{ id: 'someone-else', text: 'Overwrite' }] }, board, 'turn'));
  assert.throws(() => parseMuseResponse({ ...response, updates: [...response.updates, ...response.updates] }, board, 'turn'));
  assert.throws(() => parseMuseResponse({ ...response, cards: Array(7).fill(response.cards[0]) }, board, 'turn'));
  assert.throws(() => parseMuseResponse({ ...response, cards: [{ title: 'Long', body: 'x'.repeat(901) }] }, board, 'turn'));
});

test('selected notes survive context budgets and include only bounded scene information', () => {
  const objects = Array.from({ length: 220 }, (_, index) => ({ id: 'card-' + index, type: 'MuzeNote', text: 'x'.repeat(3900), left: index * 10, top: 20, width: 320, height: 240, privateMetadata: 'never forward this' }));
  const serialized = boardContext('Plan', 'Page', objects, ['card-219'], [{ id: 'card-219', x: 900, y: 100, w: 360, h: 240 }]);
  const board = parseBoardContext(serialized);
  assert.ok(serialized.length <= 35000);
  assert.deepEqual(board.selectedIds, ['card-219']);
  assert.equal(board.objects[0].id, 'card-219');
  assert.deepEqual(board.objects[0].bounds, { x: 900, y: 100, w: 360, h: 240 });
  assert.equal(board.objects[0].editable, true);
  assert.doesNotMatch(serialized, /privateMetadata|never forward/);
  assert.ok(board.objects.length < 150);
});

test('group selection resolves to visible leaf context without enabling unsafe grouped rewrites', () => {
  const objects = [{ id: 'frame', type: 'MuzeShape' }, { id: 'group', type: 'Group', frameId: 'frame', objects: [
    { id: 'one', type: 'MuzeNote', text: 'First option', frameId: 'frame' },
    { id: 'nested', type: 'Group', objects: [{ id: 'two', type: 'MuzeNote', text: 'Second option' }] },
    { id: 'arrow', type: 'MuzeArrow', startBinding: 'one', endBinding: 'two', sourceUrl: 'https://example.org/private' },
    { id: 'image', type: 'Image', src: 'data:image/png;base64,PRIVATEPIXELS' },
  ] }];
  const board = parseBoardContext(boardContext('Plan', 'Page', objects, ['group'], [{ id: 'two', x: 500, y: 600, w: 320, h: 240 }]));
  assert.deepEqual(board.selectedIds, ['one', 'two', 'arrow', 'image']);
  assert.equal(board.objects.find(item => item.id === 'one').parentId, 'group');
  assert.equal(board.objects.find(item => item.id === 'one').frameId, 'frame');
  assert.equal(board.objects.find(item => item.id === 'two').parentId, 'nested');
  assert.deepEqual(board.objects.find(item => item.id === 'two').bounds, { x: 500, y: 600, w: 320, h: 240 });
  assert.equal(board.objects.find(item => item.id === 'arrow').startBinding, 'one');
  assert.equal(board.objects.find(item => item.id === 'arrow').endBinding, 'two');
  assert.ok(board.objects.every(item => !item.editable));
  assert.doesNotMatch(JSON.stringify(board), /PRIVATEPIXELS|sourceUrl|example.org/);
  assert.throws(() => parseMuseResponse({ reply: 'Changed.', cards: [], updates: [{ id: 'one', text: 'Unsafe rewrite' }] }, board, 'turn'));
});

test('stale or oversized selection fails closed instead of becoming whole-board context', () => {
  const objects = Array.from({ length: 160 }, (_, index) => ({ id: 'card-' + index, type: 'MuzeNote', text: 'x'.repeat(3900) }));
  for (const selected of [['missing'], objects.map(item => item.id), ['card-0', 'missing']]) {
    const serialized = boardContext('Plan', 'Page', objects, selected);
    assert.ok(serialized.length <= 35000);
    assert.equal(JSON.parse(serialized).selectionIncomplete, true);
    assert.throws(() => parseBoardContext(serialized), /Select fewer notes or select them again/);
  }
  const legacy = parseBoardContext(JSON.stringify({ board: 'Plan', page: 'Page', objects: [{ id: 'one', type: 'MuzeNote', text: 'One', editable: true }] }));
  assert.deepEqual(legacy.selectedIds, []);
  for (const selectedIds of [['missing'], ['one', 'one'], [null], null, 'one']) assert.throws(() => parseBoardContext(JSON.stringify({ ...legacy, selectedIds })), /selection/);
});

test('context parsing validates geometry and strips arbitrary data or dangling relationships', () => {
  const raw = { board: 'Plan', page: 'Page', selectedIds: ['one'], privateNotes: 'secret', objects: [
    { id: 'one', type: 'MuzeNote', text: 'One', editable: true, bounds: { x: 10, y: 20, w: 320, h: 240, source: 'secret' }, frameId: 'missing', privateNotes: 'secret' },
    { id: 'arrow', type: 'MuzeArrow', text: '', editable: true, startBinding: 'one', endBinding: 'missing' },
  ] };
  const board = parseBoardContext(JSON.stringify(raw));
  assert.deepEqual(board.objects[0], { id: 'one', type: 'MuzeNote', text: 'One', editable: true, bounds: { x: 10, y: 20, w: 320, h: 240 } });
  assert.deepEqual(board.objects[1], { id: 'arrow', type: 'MuzeArrow', text: '', editable: false, startBinding: 'one' });
  assert.doesNotMatch(JSON.stringify(board), /secret|privateNotes|source/);
  for (const bounds of [{ x: null, y: 0, w: 1, h: 1 }, { x: 1e8, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: -1, h: 1 }]) assert.throws(() => parseBoardContext(JSON.stringify({ ...raw, objects: [{ ...raw.objects[0], bounds }] })), /position/);
});

test('selection limits model updates and focus cannot be chosen by the model', () => {
  const board = parseBoardContext(boardContext('Plan', 'Page', [{ id: 'one', type: 'MuzeNote', text: 'One' }, { id: 'two', type: 'MuzeNote', text: 'Two' }], ['one']));
  const result = parseMuseResponse({ reply: 'A shorter version.', cards: [], updates: [{ id: 'one', text: 'Shorter one' }], focusIds: ['two'], suggestions: ['Compare this with the other option'] }, board, 'turn');
  assert.deepEqual(result.actions.focusIds, ['one']);
  assert.equal(result.actions.updates[0].expectedText, 'One');
  assert.deepEqual(result.suggestions, ['Compare this with the other option']);
  assert.throws(() => parseMuseResponse({ reply: 'Too broad.', cards: [], updates: [{ id: 'two', text: 'Changed outside focus' }] }, board, 'turn'));
});

test('follow-up suggestions are bounded, optional and separate from board actions', () => {
  const board = parseBoardContext(boardContext('Plan', 'Page', [])), response = { reply: 'Ready.', cards: [], updates: [] };
  assert.deepEqual(parseMuseResponse(response, board, 'turn').suggestions, []);
  const result = parseMuseResponse({ ...response, suggestions: [' Compare the options ', 'Compare the options'] }, board, 'turn');
  assert.deepEqual(result.suggestions, ['Compare the options']);
  assert.equal(Object.hasOwn(result.actions, 'suggestions'), false);
  for (const suggestions of [null, 'Next', [''], ['x'.repeat(101)], ['First', 'Second', 'Third'], ['First\nSecond'], [{ label: 'Hidden request', prompt: 'Different action' }]]) assert.throws(() => parseMuseResponse({ ...response, suggestions }, board, 'turn'));
});
