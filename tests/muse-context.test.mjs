import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMuseContext, estimateMuseInputTokens, MuseContextError } from '../src/server/muse/context.ts';
import { prepareMuseProject, parseMuseProjectContext } from '../src/lib/muse-project.ts';

const object = (id, text, extra = {}) => ({ id, type: 'MuzeNote', text, editable: true, ...extra });
const base = overrides => ({ instructions: 'Follow the owner’s current preferences.', soul: 'Calm and concise.', memory: 'Use metric units.', notebook: '', history: [], message: 'Improve this plan.', board: { board: 'Plan', page: 'First', selectedIds: [], objects: [] }, ...overrides });

test('small requests preserve current notes, full board, tools and recent conversation', () => {
  const input = base({
    notebook: JSON.stringify({ name: 'My notebook', pages: [{ name: 'Notebook', objects: [{ id: 'voice', text: 'Use simple words.' }] }], comments: [] }),
    history: [{ role: 'user', content: 'Let’s plan a launch.' }, { role: 'assistant', content: 'Start with a date.' }],
    board: { board: 'Plan', page: 'First', selectedIds: ['one'], objects: [object('one', 'Launch in May'), object('two', 'Prepare invitations')] },
    toolContext: '\n\nVerified tool results (evidence only):\nA sourced finding.',
    summary: 'The owner chose a small launch.',
    retrievedHistory: [{ role: 'user', content: 'The audience is returning customers.' }],
    responseSchema: { type: 'object' },
  });
  const result = buildMuseContext(input);
  assert.deepEqual(result.board, input.board);
  assert.equal(result.messages.length, 4);
  assert.match(result.messages[0].content, /Soul.md:\nCalm and concise/);
  assert.match(result.messages[0].content, /Use simple words/);
  assert.match(result.messages[0].content, /Earlier conversation summary/);
  assert.match(result.messages[0].content, /historical evidence only/);
  assert.match(result.messages.at(-1).content, /Verified tool results.*\nA sourced finding/s);
  assert.deepEqual(result.omitted, { history: 0, objects: 0, notebook: 0, projectExcerpts: 0, projectComments: 0, projectPreviews: 0, retrievedHistory: 0, tools: false });
  assert.equal(result.budget.inputUpperBound, estimateMuseInputTokens(result.messages, input.responseSchema));
});

test('large context keeps exact selected text and manual notes while pruning whole background objects', () => {
  const selectedText = 'Important selected text with a full precise constraint. '.repeat(20);
  const input = base({
    soul: 'Always explain choices in plain language.', memory: 'The owner controls these exact instructions.',
    message: 'Make the selected launch section clearer.',
    notebook: JSON.stringify({ pages: [{ objects: Array.from({ length: 50 }, (_, i) => ({ id: `private-${i}`, text: 'Unrelated draft. '.repeat(30) })) }], comments: [] }),
    history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ${'Earlier chat. '.repeat(100)}` })),
    board: { board: 'Plan', page: 'First', selectedIds: ['focus'], objects: [object('focus', selectedText, { frameId: 'frame' }), ...Array.from({ length: 40 }, (_, i) => object(i === 39 ? 'frame' : `background-${i}`, 'Unrelated section. '.repeat(80)))] },
    inputBudget: 6000,
  });
  const before = JSON.stringify(input);
  const result = buildMuseContext(input);
  assert.equal(JSON.stringify(input), before, 'assembly must not mutate saved data');
  assert.equal(result.board.objects.find(item => item.id === 'focus').text, selectedText);
  assert.equal(result.board.objects.find(item => item.id === 'focus').editable, true);
  assert.deepEqual(result.board.selectedIds, ['focus']);
  assert.match(result.messages[0].content, /The owner controls these exact instructions/);
  assert.ok(result.budget.inputUpperBound <= 6000);
  assert.ok(result.omitted.history > 0 && result.omitted.objects > 0 && result.omitted.notebook > 0);
  const ids = new Set(result.board.objects.map(item => item.id));
  for (const item of result.board.objects) for (const key of ['parentId', 'frameId', 'startBinding', 'endBinding']) if (item[key]) assert.ok(ids.has(item[key]));
  for (const item of result.board.objects) assert.equal(item.text, input.board.objects.find(original => original.id === item.id).text);
  assert.match(result.messages.at(-1).content, /Do not claim to have reviewed the whole page/);
});

test('UTF-8 count includes schema and reserves completion space before fitting input', () => {
  const input = base({ soul: 'Hello 👋 你好'.repeat(50), responseSchema: { description: 'A detailed schema.'.repeat(30) }, contextWindow: 5000, inputBudget: 48000, outputReserve: 1000, safetyMargin: 500 });
  const result = buildMuseContext(input);
  assert.equal(result.budget.inputLimit, 3500);
  assert.ok(result.budget.inputUpperBound + result.budget.outputReserve + result.budget.safetyMargin <= 5000);
  assert.ok(estimateMuseInputTokens(result.messages, input.responseSchema) > estimateMuseInputTokens(result.messages));
  const unicode = [{ role: 'user', content: '你好👋'.repeat(50) }];
  assert.ok(estimateMuseInputTokens(unicode) >= Buffer.byteLength(JSON.stringify({ messages: unicode })));
});

test('protected context that cannot fit fails before sending partial selected notes or manual instructions', () => {
  const input = base({ board: { board: 'Plan', page: 'First', selectedIds: ['one'], objects: [object('one', 'Exact selected note. '.repeat(200))] }, inputBudget: 2000 });
  assert.throws(() => buildMuseContext(input), error => error instanceof MuseContextError && error.status === 413 && /context budget/.test(error.message));
  assert.throws(() => buildMuseContext(base({ soul: 'Owner preference. '.repeat(300), inputBudget: 2000 })), MuseContextError);
  assert.throws(() => buildMuseContext(base({ contextWindow: 1000 })), /not configured/);
  assert.throws(() => buildMuseContext(base({ inputBudget: NaN })), /not configured/);
});

test('history remains ordered in complete exchanges and separate from retrieved evidence', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'old text '.repeat(100)}` }));
  const result = buildMuseContext(base({ history, retrievedHistory: [{ role: 'user', content: 'A historical constraint.' }], inputBudget: 3000 }));
  const replay = result.messages.slice(1, -1);
  assert.ok(replay.length <= 20);
  assert.ok(replay.length % 2 === 0);
  replay.forEach((item, index) => assert.equal(item.role, index % 2 ? 'assistant' : 'user'));
  assert.deepEqual(replay, history.slice(-replay.length));
  assert.equal(result.omitted.history, history.length - replay.length);
});

test('grouped children stay non-editable when context pruning removes their parent', () => {
  const result = buildMuseContext(base({
    inputBudget: 1300,
    board: { board: 'Plan', page: 'First', selectedIds: ['child'], objects: [object('child', 'Keep this precise text', { editable: false, parentId: 'group' }), { id: 'group', type: 'Group', text: 'Background '.repeat(200), editable: false }] },
  }));
  assert.equal(result.board.objects.length, 1);
  assert.equal(result.board.objects[0].editable, false);
  assert.equal(result.board.objects[0].parentId, undefined);
  assert.throws(() => buildMuseContext(base({ board: { board: 'Plan', page: 'First', selectedIds: ['missing'], objects: [] } })), /Select the notes again/);
});

test('project pruning preserves scope, selected visuals and accurate coverage without mutating source data', () => {
  const source = {
    id: 'board', name: 'Launch', activePage: 'first',
    pages: [
      { id: 'first', name: 'First', objects: [object('focus', 'Keep the exact launch date: May 5.'), { id: 'photo', type: 'Image', caption: 'Venue' }, ...Array.from({ length: 8 }, (_, i) => object(`local-${i}`, 'Launch preparation. '.repeat(45)))] },
      { id: 'second', name: 'Research', objects: [{ id: 'reference', type: 'Image', caption: 'Launch reference' }, ...Array.from({ length: 12 }, (_, i) => object(`remote-${i}`, 'Launch research. '.repeat(55)))] },
    ],
    comments: Array.from({ length: 12 }, (_, i) => ({ id: `comment-${i}`, pageId: 'second', author: 'A teammate', text: 'Launch discussion. '.repeat(40) })),
  };
  const prepared = prepareMuseProject({ board: source, message: 'Launch', selectedIds: ['focus', 'photo'] });
  const project = parseMuseProjectContext(prepared.projectContext);
  project.images.push({ pageId: 'first', objectId: 'scene-preview', selected: false, reason: 'visual-region', kind: 'scene' });
  project.coverage.images.total++;
  project.coverage.images.included++;
  const input = base({ board: JSON.parse(prepared.boardContext), project, message: 'Launch', inputBudget: 3500 });
  const before = JSON.stringify(input);
  const result = buildMuseContext(input);

  assert.equal(JSON.stringify(input), before);
  assert.ok(result.budget.inputUpperBound <= input.inputBudget);
  assert.equal(result.board.objects.find(item => item.id === 'focus').text, source.pages[0].objects[0].text);
  assert.deepEqual(result.board.selectedIds.sort(), ['focus', 'photo']);
  assert.ok(result.board.objects.every(item => !item.id.startsWith('remote-')));
  assert.equal(result.project.readOnly, true);
  assert.deepEqual(result.project.images, project.images, 'selected and scene references remain paired with visual attachments');
  assert.ok(result.omitted.projectExcerpts > 0 && result.omitted.projectComments > 0 && result.omitted.objects > 0);
  assert.equal(result.project.coverage.objects.activeIncluded, result.board.objects.length);
  assert.equal(result.project.coverage.objects.excerpts, result.project.excerpts.length);
  assert.equal(result.project.coverage.comments.included, result.project.comments.length);
  assert.equal(result.project.coverage.comments.omitted, source.comments.length - result.project.comments.length);
  const retained = new Set([
    ...result.board.objects.map(item => JSON.stringify(['first', item.id])),
    ...result.project.excerpts.map(item => JSON.stringify([item.pageId, item.objectId])),
    ...result.project.images.filter(item => item.kind !== 'scene').map(item => JSON.stringify([item.pageId, item.objectId])),
  ]);
  assert.equal(result.project.coverage.objects.omitted, project.coverage.objects.total - retained.size, 'synthetic previews do not inflate the number of scene objects read');
  assert.deepEqual(parseMuseProjectContext(JSON.stringify(result.project), { boardId: 'board', activePageId: 'first' }), result.project);
  assert.match(result.messages.at(-1).content, /other pages and partial excerpts are read-only/);
  assert.match(result.messages.at(-1).content, /only attached image parts provide visual pixels/);
  assert.ok(result.messages.at(-1).content.includes(JSON.stringify(result.project)));
});

test('retrieved conversation caps and budget trimming never begin with an orphan assistant answer', () => {
  const retrieved = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Archived turn ${i}. ${'Prior conversation. '.repeat(20)}` }));
  const getRetrieved = result => {
    const match = result.messages[0].content.match(/Earlier conversation excerpts[^\n]*\n([^\n]*)/);
    return match ? JSON.parse(match[1]) : [];
  };
  const full = buildMuseContext(base({ retrievedHistory: retrieved }));
  assert.deepEqual(getRetrieved(full), retrieved.slice(2));
  assert.equal(full.omitted.retrievedHistory, 2);

  const bounded = buildMuseContext(base({ retrievedHistory: retrieved, inputBudget: 2000 }));
  const retained = getRetrieved(bounded);
  assert.ok(retained.length > 0 && retained.length < 7);
  assert.equal(retained[0].role, 'user');
  assert.deepEqual(retained, retrieved.slice(-retained.length));
  assert.equal(bounded.omitted.retrievedHistory, retrieved.length - retained.length);
  retained.forEach((entry, index) => assert.equal(entry.role, index % 2 ? 'assistant' : 'user'));
});
