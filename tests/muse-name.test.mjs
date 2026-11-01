import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMuseNameSave, renameMuseInSoul } from '../src/lib/muse-name.ts';

const title = name => ({ id: 'muse-name', type: 'MuzeText', text: 'Hello, my name is ' + name + '.' });
const soul = text => ({ id: 'muse-file-soul', type: 'MuzeDocument', markdown: text, text, left: 100 });
const originalSoul = '# Soul\nI’m Muse, your planning companion.\n\nKeep answers short.';
const savedSoul = originalSoul.replace('I’m Muse,', 'I’m Kumo,');

function board() {
  return {
    id: 'muse-private', name: 'My notebook', museName: 'Muse', activePage: 'first', comments: [],
    pages: [
      { id: 'first', name: 'Notebook', viewport: [1, 0, 0, 1, 0, 0], objects: [title('Kumo'), soul(originalSoul), { id: 'drawing', type: 'Rect', left: 20, fill: '#abcdef' }] },
      { id: 'second', name: 'Ideas', viewport: [1, 0, 0, 1, 0, 0], objects: [] },
    ],
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('a save acknowledgement applies canonical soul text without rewinding queued unrelated edits', () => {
  const submitted = board(), latest = structuredClone(submitted);
  latest.name = 'My renamed notebook';
  latest.activePage = 'second';
  latest.comments.push({ id: 'new-comment', text: 'A thought added while saving.' });
  latest.pages[0].objects[2].left = 750;
  latest.pages[1].objects.push({ id: 'new-note', type: 'MuzeDocument', markdown: 'A newer note' });
  latest.pages[1].viewport = [2, 0, 0, 2, 40, 60];
  const result = reconcileMuseNameSave(latest, submitted, { name: 'Kumo', soul: savedSoul });
  const expected = structuredClone(latest);
  expected.museName = 'Kumo';
  Object.assign(expected.pages[0].objects[1], { markdown: savedSoul, text: savedSoul });
  assert.deepEqual(result, expected);
});

test('newer soul edits, including an intentionally empty note, survive an older acknowledgement', () => {
  for (const text of ['# Soul\nI prefer a new working style.', '']) {
    const submitted = board(), latest = structuredClone(submitted);
    Object.assign(latest.pages[0].objects[1], { markdown: text, text: 'The latest rendered text', left: 300 });
    const result = reconcileMuseNameSave(latest, submitted, { name: 'Kumo', soul: savedSoul });
    assert.deepEqual(result.pages[0].objects[1], latest.pages[0].objects[1]);
    assert.equal(result.museName, 'Kumo');
  }
});

test('a queued second rename keeps its newer title, identity, and soul instead of the acknowledged name', () => {
  const submitted = board(), latest = structuredClone(submitted);
  latest.pages[0].objects[0] = title('Nova');
  latest.pages[0].objects[1] = soul(originalSoul.replace('I’m Muse,', 'I’m Nova,'));
  latest.museName = 'Kumo';
  const result = reconcileMuseNameSave(latest, submitted, { name: 'Kumo', soul: savedSoul });
  assert.equal(result.museName, 'Nova');
  assert.deepEqual(result.pages[0].objects, latest.pages[0].objects);
});

test('reconciliation finds nested cards across pages without mutating submitted or latest scenes', () => {
  const submitted = board();
  submitted.pages[0].objects = [{ id: 'other-soul-note', type: 'MuzeDocument', markdown: originalSoul }];
  submitted.pages[1].objects = [{ id: 'outer', type: 'Group', objects: [
    { id: 'inner', type: 'Group', objects: [title('Kumo'), soul(originalSoul)] },
    { id: 'memory', type: 'MuzeDocument', markdown: 'Do not change this memory.' },
  ] }];
  const latest = structuredClone(submitted);
  latest.pages[1].objects[0].left = 900;
  latest.pages[1].objects[0].objects[0].objects[1].left = 500;
  const submittedBefore = structuredClone(submitted), latestBefore = structuredClone(latest);
  freeze(submitted); freeze(latest);
  const result = reconcileMuseNameSave(latest, submitted, { name: 'Kumo', soul: savedSoul });
  assert.equal(result.museName, 'Kumo');
  assert.equal(result.pages[1].objects[0].objects[0].objects[1].markdown, savedSoul);
  assert.equal(result.pages[1].objects[0].objects[0].objects[1].text, savedSoul);
  assert.equal(result.pages[1].objects[0].objects[0].objects[1].left, 500);
  assert.equal(result.pages[1].objects[0].left, 900);
  assert.equal(result.pages[0].objects[0].markdown, originalSoul);
  assert.equal(result.pages[1].objects[0].objects[1].markdown, 'Do not change this memory.');
  assert.deepEqual(submitted, submittedBefore);
  assert.deepEqual(latest, latestBefore);
  assert.notEqual(result, latest);
});

test('an incomplete newer title is preserved while an older save finishes', () => {
  const submitted = board(), latest = structuredClone(submitted);
  latest.museName = 'Nova';
  latest.pages[0].objects[0].text = 'Hello, my name is ';
  const result = reconcileMuseNameSave(latest, submitted, { name: 'Kumo', soul: savedSoul });
  assert.equal(result.pages[0].objects[0].text, 'Hello, my name is ');
  assert.equal(result.museName, 'Nova');
});

test('soul renames support Unicode and literal regex characters without changing incidental names', () => {
  const previous = 'Kumo (β)+[1].*', next = '小月 🐾';
  const content = `# Soul\nI’m ${previous}, your companion.\nName: ${previous}\n\nA historical reference to ${previous} stays here.\nMuseology is an unrelated word.\n`;
  const expected = `# Soul\nI’m ${next}, your companion.\nName: ${next}\n\nA historical reference to ${previous} stays here.\nMuseology is an unrelated word.\n`;
  assert.equal(renameMuseInSoul(content, previous, next), expected);
  assert.equal(renameMuseInSoul('I am Muse.', 'Muse', 'Cafe\u0301'), 'I am Café.');
});

test('default introductions are repaired during a later rename and already-current declarations are idempotent', () => {
  const content = 'I am Muse.\nMy name is Kumo.\nName: Nova\n\nMuse, Kumo, and Nova appear in my notes.';
  const expected = 'I am Nova.\nMy name is Nova.\nName: Nova\n\nMuse, Kumo, and Nova appear in my notes.';
  assert.equal(renameMuseInSoul(content, 'Kumo', 'Nova'), expected);
  assert.equal(renameMuseInSoul(expected, 'Kumo', 'Nova'), expected);
  const custom = 'My working style has no identity declaration.\n';
  assert.equal(renameMuseInSoul(custom, 'Nova', 'Nova'), custom);
});
