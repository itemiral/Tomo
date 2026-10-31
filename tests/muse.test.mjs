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
