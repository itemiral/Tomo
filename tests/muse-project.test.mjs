import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMuseProject, parseMuseProjectContext, MUSE_PROJECT_MAX_CHARS } from '../src/lib/muse-project.ts';
import { parseBoardContext, parseMuseResponse } from '../src/lib/muse-board.ts';

const note = (id, text, extra = {}) => ({ id, type: 'MuzeNote', text, left: 10, top: 20, width: 280, height: 160, ...extra });
const page = (id, objects = [], name = id) => ({ id, name, objects, viewport: [1, 0, 0, 1, 0, 0] });
const board = (pages = [page('first')], extra = {}) => ({ id: 'board-one', name: 'Project', activePage: pages[0].id, pages, comments: [], ...extra });
const packet = (value, extra = {}) => {
  const result = prepareMuseProject({ board: value, message: 'Improve this project', ...extra });
  return { ...result, active: JSON.parse(result.boardContext), project: parseMuseProjectContext(result.projectContext) };
};
const reply = updates => ({ reply: 'Prepared your changes.', cards: [], updates, suggestions: [] });

test('query relevance is applied before the active page object limit', () => {
  const objects = [...Array.from({ length: 220 }, (_, i) => note('background-' + i, 'Furniture inventory ' + i)), note('important', 'Lunar launch requires thermal testing.')];
  const result = packet(board([page('first', objects)]), { message: 'Explain the lunar launch.' });
  assert.equal(result.active.objects[0].id, 'important');
  assert.equal(result.active.objects.length, 150);
  assert.ok(result.anchorIds.includes('important'));
  assert.equal(result.project.coverage.objects.total, 221);
  assert.equal(result.project.coverage.objects.activeIncluded, 150);
  assert.ok(result.project.coverage.objects.omitted > 0);
  assert.equal(result.project.coverage.scanLimited, false);
  assert.equal(parseBoardContext(result.boardContext).objects[0].text, 'Lunar launch requires thermal testing.');
});

test('all page overviews and relevant other-page notes remain read-only', () => {
  const value = board([page('first', [note('daily', 'Schedule interviews')], 'Current work'), page('research', [note('finding', 'Customers need offline access.')], 'Research')]);
  value.otherWorkspace = { privateSoul: 'Never include another board’s private note.' };
  const result = packet(value, { message: 'Use the research about offline access.' });
  assert.deepEqual(result.project.pages.map(item => item.id), ['first', 'research']);
  assert.match(result.project.pages[1].preview, /offline access/);
  assert.equal(result.project.excerpts[0].pageId, 'research');
  assert.equal(result.project.excerpts[0].objectId, 'finding');
  assert.equal(result.project.readOnly, true);
  assert.doesNotMatch(result.projectContext + result.boardContext, /another board’s private/);
  assert.throws(() => parseMuseResponse(reply([{ id: 'finding', text: 'Changed research' }]), parseBoardContext(result.boardContext), 'turn'), /incomplete response/);
});

test('ordinary comments are included by page without turning them into editable notes', () => {
  const value = board([page('first'), page('second')], { comments: [
    { id: 'old', author: 'One', text: 'Unrelated discussion.', pageId: 'first' },
    { id: 'decision', author: 'Two', text: 'The launch date is April 4.', pageId: 'second' },
    { id: 'legacy', author: 'One', text: 'This comment belongs to the first page.' },
    { id: 'missing-page', author: 'One', text: 'Unreachable comment.', pageId: 'missing' },
  ] });
  const result = packet(value, { message: 'What is the launch date?' });
  assert.equal(result.project.comments[0].id, 'decision');
  assert.equal(result.project.comments.find(item => item.id === 'legacy').pageId, 'first');
  assert.equal(result.project.comments.some(item => item.id === 'missing-page'), false);
  assert.equal(result.project.coverage.comments.total, 4);
  assert.equal(result.project.coverage.comments.included, 3);
  assert.equal(result.project.coverage.comments.omitted, 1);
  assert.equal(result.active.objects.length, 0);
});

test('strong matches on one page are not displaced by unrelated page diversity', () => {
  const value = board([
    page('first'),
    page('findings', Array.from({ length: 5 }, (_, i) => note('finding-' + i, 'Offline access requires encrypted records. Constraint ' + i))),
    ...Array.from({ length: 40 }, (_, i) => page('other-' + i, [note('background-' + i, 'Unrelated topic')])),
  ]);
  const result = packet(value, { message: 'Explain offline access and encrypted records.' });
  assert.equal(result.project.excerpts.filter(item => item.pageId === 'findings').length, 5);
  assert.equal(result.project.pages.length, 42);
});

test('long documents retrieve a relevant later passage and cannot be overwritten as partial text', () => {
  const text = 'General project background. '.repeat(900) + '\nLaunch constraint: all materials must remain recyclable.\n' + 'Other context. '.repeat(30);
  const result = packet(board([page('first', [note('long-note', text)])]), { message: 'Explain the recyclable launch constraint.', selectedIds: ['long-note'] });
  assert.equal(result.active.objects[0].editable, false);
  assert.equal(result.active.objects[0].text.length, 4000);
  const excerpt = result.project.excerpts.find(item => item.objectId === 'long-note');
  assert.ok(excerpt.start > 4000);
  assert.match(excerpt.text, /must remain recyclable/);
  assert.equal(excerpt.partial, true);
  assert.equal(excerpt.text, text.slice(excerpt.start, excerpt.end));
  assert.equal(excerpt.sourceLength, text.length);
  assert.throws(() => parseMuseResponse(reply([{ id: 'long-note', text: 'Only this paragraph' }]), parseBoardContext(result.boardContext), 'turn'), /incomplete response/);
});

test('the live active drawing replaces stale saved objects without changing other pages or the source', () => {
  const value = board([page('first', [note('draft', 'Stale text')]), page('second', [note('stable', 'Keep the other page')])]);
  const before = JSON.stringify(value);
  const result = packet(value, { activeDrawing: { objects: [note('draft', 'Latest unsaved text')] }, selectedIds: ['draft'], sceneItems: [{ id: 'draft', x: 80, y: 90, w: 200, h: 100 }] });
  assert.equal(result.active.objects[0].text, 'Latest unsaved text');
  assert.deepEqual(result.active.objects[0].bounds, { x: 80, y: 90, w: 200, h: 100 });
  assert.match(result.project.pages[1].preview, /Keep the other page/);
  assert.equal(JSON.stringify(value), before);
  assert.throws(() => packet(value, { activePageId: 'unknown' }), /not part of this board/);
});

test('selected objects take precedence and grouped descendants never become editable', () => {
  const value = board([page('first', [
    ...Array.from({ length: 180 }, (_, i) => note('noise-' + i, 'Background ' + i)),
    { id: 'group', type: 'Group', objects: [note('child', 'A grouped decision')], left: 0, top: 0, width: 400, height: 200 },
  ])]);
  const result = packet(value, { selectedIds: ['group'], message: 'Clarify this decision.' });
  assert.equal(result.active.objects[0].id, 'child');
  assert.equal(result.active.objects[0].editable, false);
  assert.deepEqual(result.active.selectedIds, ['child']);
  assert.equal(parseBoardContext(result.boardContext).objects[0].editable, false);
  assert.throws(() => parseMuseResponse(reply([{ id: 'child', text: 'Replaced child' }]), parseBoardContext(result.boardContext), 'turn'), /incomplete response/);
});

test('missing, duplicate, and oversized selections cannot silently degrade into an unfocused request', () => {
  const value = board([page('first', Array.from({ length: 170 }, (_, i) => note('note-' + i, 'A note')))]);
  for (const selectedIds of [['missing'], ['note-0', 'note-0'], Array.from({ length: 151 }, (_, i) => 'note-' + i)]) {
    const result = packet(value, { selectedIds });
    assert.equal(result.active.selectionIncomplete, true);
    assert.throws(() => parseBoardContext(result.boardContext), /Select fewer notes/);
  }
  const long = board([page('first', Array.from({ length: 12 }, (_, i) => note('long-' + i, 'A'.repeat(3999))))]);
  const result = packet(long, { selectedIds: long.pages[0].objects.map(item => item.id) });
  assert.equal(result.active.selectionIncomplete, true);
  assert.ok(result.boardContext.length < 35000);
});

test('selected notes bring connected endpoints and nearby notes into a crowded page', () => {
  const result = packet(board([page('first', [
    ...Array.from({ length: 170 }, (_, i) => note('noise-' + i, 'A different topic', { left: 90000, top: 90000 })),
    note('focus', 'Current milestone', { left: 100, top: 100 }),
    note('nearby', 'A nearby constraint', { left: 150, top: 150 }),
    note('endpoint', 'A linked dependency', { left: 90000, top: 90000 }),
    { id: 'connection', type: 'MuzeArrow', startBinding: 'focus', endBinding: 'endpoint', left: 0, top: 0, width: 100, height: 100 },
  ])]), { selectedIds: ['focus'], message: 'Explain this.' });
  const ids = result.active.objects.map(item => item.id);
  for (const id of ['focus', 'nearby', 'endpoint', 'connection']) assert.ok(ids.includes(id), id);
  assert.deepEqual(result.active.selectedIds, ['focus']);
  assert.throws(() => parseMuseResponse(reply([{ id: 'endpoint', text: 'Changed dependency' }]), parseBoardContext(result.boardContext), 'turn'), /incomplete response/);
});

test('resume requests prefer recent existing content rather than always the first objects', () => {
  const result = packet(board([page('first', Array.from({ length: 180 }, (_, i) => note('note-' + i, 'Task update ' + i, { updatedAt: i + 1 })))]), { message: 'Continue from the latest update.' });
  assert.equal(result.active.objects[0].id, 'note-179');
  assert.equal(result.anchorIds[0], 'note-179');
  assert.ok(result.project.pages[0].preview.includes('Task update 179'));
});

test('visual candidates are selected and bounded without copying image payloads or source URLs', () => {
  const images = Array.from({ length: 8 }, (_, i) => ({ id: 'image-' + i, type: 'Image', src: 'data:image/png;base64,PRIVATE_PIXELS', imageUrl: 'https://external.example/private-image', sourceTitle: 'Research diagram ' + i }));
  const result = packet(board([page('first', images)]), { selectedIds: ['image-7'], message: 'Explain the diagram.' });
  assert.equal(result.imageCandidates.length, 4);
  assert.equal(result.imageCandidates[0].objectId, 'image-7');
  assert.equal(result.imageCandidates[0].selected, true);
  assert.equal(result.project.coverage.images.omitted, 4);
  assert.doesNotMatch(result.projectContext + result.boardContext, /PRIVATE_PIXELS|external\.example/);
});

test('large projects retain every legal page identity within a bounded packet and disclose omissions', () => {
  const value = board(Array.from({ length: 100 }, (_, p) => page('page-' + p, Array.from({ length: 40 }, (_, i) => note('object-' + p + '-' + i, 'Research topic '.repeat(500))), '非常に長いプロジェクトページ'.repeat(15))));
  const result = packet(value, { activePageId: 'page-99', selectedIds: ['object-99-39'], message: 'Summarize this research.' });
  assert.equal(result.project.pages.length, 100);
  assert.equal(result.project.activePageId, 'page-99');
  assert.equal(result.project.coverage.objects.total, 4000);
  assert.ok(result.projectContext.length <= MUSE_PROJECT_MAX_CHARS - 512);
  assert.ok(result.boardContext.length < 35000);
  assert.ok(result.project.coverage.objects.omitted > 3000);
  assert.ok(result.active.selectedIds.includes('object-99-39'));
  const withScene = JSON.parse(result.projectContext);
  withScene.images.push({ pageId: 'page-99', objectId: 'scene-preview', selected: false, reason: 'visual-region', kind: 'scene' });
  withScene.coverage.images.total++; withScene.coverage.images.included++;
  assert.ok(JSON.stringify(withScene).length <= MUSE_PROJECT_MAX_CHARS);
  assert.equal(parseMuseProjectContext(JSON.stringify(withScene)).images.at(-1).kind, 'scene');
});

test('scan limits prioritize the active page and explicitly report incomplete project coverage', () => {
  const value = board(Array.from({ length: 110 }, (_, p) => page('page-' + p, Array.from({ length: 310 }, (_, i) => note('object-' + p + '-' + i, 'A note')))));
  const result = packet(value, { activePageId: 'page-109', selectedIds: ['object-109-309'] });
  assert.equal(result.active.selectedIds[0], 'object-109-309');
  assert.equal(result.project.coverage.pages.total, 110);
  assert.equal(result.project.coverage.pages.included, 100);
  assert.equal(result.project.coverage.pages.omitted, 10);
  assert.equal(result.project.coverage.objects.scanned, 30000);
  assert.equal(result.project.coverage.scanLimited, true);
});

test('project parsing rejects forged scopes, invalid counts and malformed references while stripping extra fields', () => {
  const result = packet(board([page('first', [note('active', 'Some text')]), page('second', [note('old', 'Other text')])]));
  assert.equal(parseMuseProjectContext(undefined), null);
  assert.throws(() => parseMuseProjectContext(result.projectContext, { boardId: 'another-board' }), /could not be read/);
  assert.throws(() => parseMuseProjectContext(result.projectContext, { activePageId: 'second' }), /could not be read/);
  for (const mutate of [
    value => { value.readOnly = false; },
    value => { value.excerpts[0].pageId = 'unknown'; },
    value => { value.excerpts[0].end++; },
    value => { value.coverage.pages.omitted = -1; },
    value => { value.coverage.objects.activeIncluded = 151; },
    value => { value.pages[0].id = '__proto__'; },
  ]) {
    const value = JSON.parse(result.projectContext); mutate(value);
    assert.throws(() => parseMuseProjectContext(JSON.stringify(value)), /could not be read/);
  }
  const value = JSON.parse(result.projectContext);
  value.privateMemory = 'Do not forward'; value.excerpts[0].editable = true; value.excerpts[0].src = 'data:image/png;base64,SECRET';
  const safe = JSON.stringify(parseMuseProjectContext(JSON.stringify(value)));
  assert.doesNotMatch(safe, /Do not forward|editable|SECRET/);
});

test('a synthetic scene preview can only refer to the active page and cannot become an editable object', () => {
  const result = packet(board([page('first', [note('active', 'Some text')]), page('second')]));
  const value = JSON.parse(result.projectContext);
  value.images.push({ pageId: 'first', objectId: 'scene-preview', selected: false, reason: 'visual-region', kind: 'scene' });
  value.coverage.images.total++; value.coverage.images.included++;
  assert.equal(parseMuseProjectContext(JSON.stringify(value)).images[0].kind, 'scene');
  value.images[0].pageId = 'second';
  assert.throws(() => parseMuseProjectContext(JSON.stringify(value)), /could not be read/);
});

test('non-Latin query phrases can find a later note without exact sentence repetition', () => {
  const value = board([page('first', [...Array.from({ length: 180 }, (_, i) => note('irrelevant-' + i, '別の話題')), note('late', '韓国の旅行では市場へ行きたい。')])]);
  const result = packet(value, { message: '韓国旅行について説明してください' });
  assert.equal(result.active.objects[0].id, 'late');
});
