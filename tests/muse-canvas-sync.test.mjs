import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { documentEditSource, documentLines, documentText } from '../src/components/muze/document-text.ts';

const bundle = await build({ entryPoints: ['src/lib/muse-canvas-sync.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { mergeLearnedNote, reconcileMuseCanvas } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const id = digit => digit.repeat(24);
const entry = (key, text) => `<!-- muze-entry:${id(key)}:start -->\n- ${text}\n<!-- muze-entry:${id(key)}:end -->`;
const section = (...entries) => `<!-- muze-learned:start -->\n## Learned working style\n\n${entries.join('\n')}\n<!-- muze-learned:end -->`;
const baseText = '# Soul\n\nCalm and direct.';

function board(soul = baseText) {
  return { id: 'muse-private', name: 'Private notebook', activePage: 'one', pages: [{ id: 'one', name: 'Notebook', viewport: [1, 0, 0, 1, 0, 0], objects: [
    { id: 'muse-file-soul', type: 'MuzeDocument', text: soul, markdown: soul, left: 100, top: 100 },
    { id: 'muse-file-memory', type: 'MuzeDocument', text: '# Memory', markdown: '# Memory', left: 600 },
    { id: 'drawing', type: 'Rect', left: 10 },
  ] }] };
}

test('new learned content joins handwritten edits without replacing the owner voice', () => {
  const local = '# Soul\n\nMy own voice. Keep explanations short.';
  const remote = baseText + '\n\n' + section(entry('a', 'Prefer concrete examples.'));
  const merged = mergeLearnedNote(baseText, local, remote);
  assert.match(merged, /My own voice/);
  assert.match(merged, /Prefer concrete examples/);
  assert.doesNotMatch(merged, /Calm and direct/);
});

test('manual changes and deletions to individual learned entries win', () => {
  const base = baseText + '\n\n' + section(entry('a', 'Use short replies.'), entry('b', 'Prefer lists.'));
  const local = baseText + '\n\n' + section(entry('a', 'Use detailed explanations when needed.'));
  const remote = baseText + '\n\n' + section(entry('a', 'Use very short replies.'), entry('b', 'Always use lists.'), entry('c', 'Explain unfamiliar terms.'));
  const merged = mergeLearnedNote(base, local, remote);
  assert.match(merged, /detailed explanations/);
  assert.match(merged, /Explain unfamiliar terms/);
  assert.doesNotMatch(merged, /very short|Always use lists|Prefer lists/);
});

test('removing a learned section stays removed when an automatic update arrives', () => {
  const base = baseText + '\n\n' + section(entry('a', 'Use short replies.'));
  assert.equal(mergeLearnedNote(base, baseText, base + '\n'), baseText);
});

test('owner writing between learned entries survives the next learned update', () => {
  const base=baseText+'\n\n'+section(entry('a','Be concise.'),entry('b','Use examples.'));
  const local=base.replace(entry('b','Use examples.'),'My own note between entries.\n'+entry('b','Use examples.'));
  const remote=base.replace('Be concise.','Be clear and concise.');
  const merged=mergeLearnedNote(base,local,remote);
  assert.match(merged,/My own note between entries/);
  assert.match(merged,/Be clear and concise/);
});

test('handwritten edits from another tab still require conflict resolution', () => {
  assert.equal(mergeLearnedNote(baseText, '# Soul\nMy edit.', '# Soul\nAnother edit.'), null);
  assert.throws(() => reconcileMuseCanvas(board(), board('# Soul\nMy edit.'), board('# Soul\nAnother edit.')), /draft is kept/);
});

test('refresh preserves local geometry, current page and camera while accepting learned text', () => {
  const base = board(), local = structuredClone(base), remote = board(baseText + '\n\n' + section(entry('a', 'Prefer concise explanations.')));
  local.pages[0].viewport = [.6, 0, 0, .6, 370, 120];
  local.pages[0].objects[0].left = 200;
  local.pages[0].objects[2].left = 50;
  const before = JSON.stringify({ base, local, remote });
  const merged = reconcileMuseCanvas(base, local, remote);
  assert.deepEqual(merged.pages[0].viewport, local.pages[0].viewport);
  assert.equal(merged.pages[0].objects[0].left, 200);
  assert.equal(merged.pages[0].objects[2].left, 50);
  assert.match(merged.pages[0].objects[0].markdown, /concise explanations/);
  assert.equal(JSON.stringify({ base, local, remote }), before);
  assert.throws(() => reconcileMuseCanvas(base, local, { ...remote, id: 'another-board' }), /draft is preserved/);
});

test('learned metadata stays out of the visible document', () => {
  const source = baseText + '\n\n' + section(entry('a', 'Prefer useful examples.'));
  const display = documentText(source, 'soul.md');
  assert.match(display, /Learned working style/);
  assert.match(display, /Prefer useful examples/);
  assert.doesNotMatch(display, /muze-entry|muze-learned|<!--/);
  assert.match(source, /muze-entry/);
});

test('editing a learned line keeps its stable identity without exposing metadata', () => {
  const source=baseText+'\n\n'+section(entry('a','Prefer useful examples.'),entry('b','Use concise replies.'));
  const visible=documentLines(source).join('\n');
  const edited=visible.replace('useful examples','detailed explanations');
  const saved=documentEditSource(source,edited);
  assert.equal(documentLines(saved).join('\n'),edited);
  assert.match(saved,new RegExp(`muze-entry:${id('a')}:start -->\\n- Prefer detailed explanations`));
  assert.match(saved,new RegExp(`muze-entry:${id('b')}:start`));
  assert.equal(documentEditSource(source,visible),source);
});

test('deletions and replacements preserve every visible character without assigning unrelated identities', () => {
  const source=baseText+'\n\n'+section(entry('a','Prefer examples.'),entry('b','Be concise.'))+'\n';
  const visible=documentLines(source).join('\n');
  const whole='# Soul\n\nEntirely my own document.';
  assert.equal(documentEditSource(source,whole),whole);
  for(let start=0;start<visible.length;start+=7)for(let end=start;end<=visible.length;end+=11){
    const edited=visible.slice(0,start)+'new\nwords'+visible.slice(end);
    assert.equal(documentLines(documentEditSource(source,edited)).join('\n'),edited,`edit ${start}:${end}`);
  }
  const deleted=visible.replace('- Prefer examples.\n','');
  const saved=documentEditSource(source,deleted);
  assert.equal(documentLines(saved).join('\n'),deleted);
  assert.doesNotMatch(saved,new RegExp(`muze-entry:${id('a')}`));
  assert.match(saved,new RegExp(`muze-entry:${id('b')}`));
});
