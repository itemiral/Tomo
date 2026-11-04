import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'muze-learning-test-'));
process.env.MUZE_PRIVATE_DIR = directory;
const { readMuseLearning, commitMuseTurn, readMuseArchive, DEFAULT_MUSE_STYLE } = await import('../scripts/muse-learning.mjs');
const { readMuseChat, readMuseNote, saveMuseNote, museDirectory, saveMuseChat, readMuseConversation, chatArchivePath } = await import('../scripts/muse-store.mjs');
after(() => rm(directory, { recursive: true, force: true }));

const update = (target, key, text, evidence, scope = 'owner', operation = 'upsert') => ({ target, key, text, evidence, scope, operation });
async function turn(owner, message, updates, options = {}) {
  const thread = options.thread || 'board:page';
  const snapshot = options.snapshot || await readMuseLearning(owner, thread);
  const userMessage = { id: options.id || randomUUID(), role: 'user', content: message };
  const messages = [...await readMuseChat(owner, thread), userMessage, { id: randomUUID(), role: 'assistant', content: options.reply || 'Done.' }];
  return commitMuseTurn(owner, thread, { snapshot, messages, userMessage, boardName: options.boardName || 'Current plan', personalization: { updates, summary: options.summary || '' } });
}

test('defaults belong to every owner and learned style and memories populate editable files', async () => {
  const owner = 'learning-defaults';
  const initial = await readMuseLearning(owner, 'board:page');
  assert.equal(Object.keys(DEFAULT_MUSE_STYLE).length, 6);
  const {MUSE_NOTE_TEMPLATES} = await import('../scripts/muse-defaults.mjs');
  assert.equal(initial.notes.soul.content, MUSE_NOTE_TEMPLATES.soul);
  assert.equal(initial.notes.memory.content, MUSE_NOTE_TEMPLATES.memory);
  assert.doesNotMatch(initial.notes.soul.content, /Make me yours/);
  assert.deepEqual(initial.entries, []);
  const message = 'I prefer brief bullet points and I live in Santa Cruz.';
  const result = await turn(owner, message, [update('soul', 'format', 'Prefer brief bullet points.', 'I prefer brief bullet points'), update('memory', 'home', 'Lives in Santa Cruz.', 'I live in Santa Cruz')]);
  assert.equal(result.learningChanged, true);
  assert.match((await readMuseNote(owner, 'soul')).content, /Learned working style/);
  assert.match((await readMuseNote(owner, 'memory')).content, /Lives in Santa Cruz/);
  assert.doesNotMatch((await readMuseLearning('another-owner', 'board:page')).memoryContext, /Santa Cruz/);
  assert.equal((await readMuseChat(owner, 'board:page')).length, 2);
});

test('project facts stay scoped to their board while stable keys replace corrected facts', async () => {
  const owner = 'learning-scope';
  await turn(owner, 'Our budget is $500.', [update('memory', 'budget', 'Budget is $500.', 'budget is $500', 'board')], { boardName: 'First project' });
  await turn(owner, 'Actually the budget is $800.', [update('memory', 'budget', 'Budget is $800.', 'budget is $800', 'board')], { boardName: 'First project' });
  const first = await readMuseLearning(owner, 'board:other-page');
  assert.match(first.memoryContext, /Budget is \$800/);
  assert.doesNotMatch(first.memoryContext, /\$500/);
  assert.equal(first.entries.filter(entry => entry.key === 'budget').length, 1);
  assert.doesNotMatch((await readMuseLearning(owner, 'different:page')).memoryContext, /\$800/);
  assert.doesNotMatch((await readMuseLearning(owner, 'different:page')).ownerText.memory, /\$800/);
});

test('an owner edit during generation wins while the successful conversation is retained', async () => {
  const owner = 'learning-race';
  const snapshot = await readMuseLearning(owner, 'board:page');
  await saveMuseNote(owner, 'soul', '# Soul\nUse a thoughtful, detailed voice.', snapshot.notes.soul.revision);
  const result = await turn(owner, 'Always be very brief.', [update('soul', 'detail', 'Use very brief answers.', 'Always be very brief')], { snapshot, summary: 'The owner prefers short answers.' });
  assert.equal(result.learningChanged, false);
  assert.equal((await readMuseNote(owner, 'soul')).content, '# Soul\nUse a thoughtful, detailed voice.');
  assert.equal(result.summary, '');
  assert.equal((await readMuseChat(owner, 'board:page')).length, 2);
});

test('manual changes and deletions to learned entries stay authoritative', async () => {
  const owner = 'learning-pins';
  await turn(owner, 'I prefer short answers.', [update('soul', 'detail', 'Use short answers.', 'I prefer short answers')]);
  let note = await readMuseNote(owner, 'soul');
  await saveMuseNote(owner, 'soul', note.content.replace('Use short answers.', 'Use detailed answers with examples.'), note.revision);
  let snapshot = await readMuseLearning(owner, 'board:page');
  assert.equal(snapshot.entries[0].pinned, true);
  assert.equal(snapshot.messages.length, 2, 'the private displayed conversation is preserved');
  assert.deepEqual(snapshot.contextMessages, [], 'old preference and its reply cannot overrule the owner correction');
  await turn(owner, 'I prefer short answers.', [update('soul', 'detail', 'Use short answers.', 'I prefer short answers')]);
  assert.match((await readMuseNote(owner, 'soul')).content, /Use detailed answers with examples/);
  note = await readMuseNote(owner, 'soul');
  await saveMuseNote(owner, 'soul', note.content.replace(/<!-- muze-entry:[a-f0-9]{24}:start -->[\s\S]*?<!-- muze-entry:[a-f0-9]{24}:end -->/, ''), note.revision);
  snapshot = await readMuseLearning(owner, 'board:page');
  assert.equal(snapshot.entries.length, 0);
  assert.equal(snapshot.suppressed[0].deleted, true);
  await turn(owner, 'I prefer short answers.', [update('soul', 'detail', 'Use short answers.', 'I prefer short answers')]);
  assert.doesNotMatch((await readMuseNote(owner, 'soul')).content, /Use short answers|Use detailed answers/);
});

test('handwritten text and extra paragraphs in a learned section survive later updates', async () => {
  const owner = 'learning-handwritten';
  await turn(owner, 'I like tea.', [update('memory', 'drink', 'Likes tea.', 'I like tea')]);
  const note = await readMuseNote(owner, 'memory');
  const edited = '# Handwritten\nAlways keep this paragraph.\n\n' + note.content.replace('## Learned context', '## Learned context\n\nMy own additional paragraph.');
  await saveMuseNote(owner, 'memory', edited, note.revision);
  await turn(owner, 'I live near the coast.', [update('memory', 'home', 'Lives near the coast.', 'I live near the coast')]);
  const result = (await readMuseNote(owner, 'memory')).content;
  assert.match(result, /Always keep this paragraph/);
  assert.match(result, /My own additional paragraph/);
  assert.match(result, /Lives near the coast/);
});

test('unquoted or invalid learning proposals never enter private notes', async () => {
  const owner = 'learning-evidence';
  const result = await turn(owner, 'Make the note shorter.', [
    update('memory', 'home', 'Lives in Paris.', 'I live in Paris'),
    update('soul', 'identity', 'My name is Elsewhere.', 'Make the note shorter'),
    update('soul', 'tone', '<!-- markup -->', 'Make the note shorter'),
  ]);
  assert.equal(result.learningChanged, false);
  assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 0);
});

test('older conversation is archived and retrieved without enlarging recent history', async () => {
  const owner = 'learning-archive', thread = 'board:page';
  let messages = [];
  for (let i = 0; i < 90; i++) {
    messages = [...await readMuseChat(owner, thread), { id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'The project codename is Maplefjord.' : 'A separate discussion number ' + i }];
    await saveMuseChat(owner, thread, messages);
  }
  assert.equal((await readMuseChat(owner, thread)).length, 32);
  const envelope = await readMuseConversation(owner, thread);
  assert.equal(envelope.archiveCount, 1);
  const archived = JSON.parse(await readFile(chatArchivePath(owner, thread, 0), 'utf8'));
  assert.equal(archived.length, 58);
  assert.equal(new Set(archived.map(message => message.id)).size, 58);
  assert.match(JSON.stringify(await readMuseArchive(owner, thread, 'What was Maplefjord?')), /Maplefjord/);
  assert.deepEqual(await readMuseArchive('another-owner', thread, 'Maplefjord'), []);
  assert.equal(JSON.parse(await readFile(join(museDirectory(owner), 'identity.json'), 'utf8')).ownerId, owner);
});

test('summary follows the current private notes and is cleared after owner corrections', async () => {
  const owner = 'learning-summary';
  await turn(owner, 'We are planning a workshop.', [], { summary: 'Planning a workshop; date undecided.' });
  assert.equal((await readMuseLearning(owner, 'board:page')).summary, 'Planning a workshop; date undecided.');
  const note = await readMuseNote(owner, 'memory');
  await saveMuseNote(owner, 'memory', note.content + '\nWorkshop cancelled.\n', note.revision);
  assert.equal((await readMuseLearning(owner, 'board:page')).summary, '');
});

test('learning an unrelated project fact preserves another board conversation summary', async () => {
  const owner = 'learning-summary-scope';
  await turn(owner, 'We are planning a workshop.', [], { summary: 'Planning a workshop; date undecided.' });
  await turn(owner, 'The trip budget is $800.', [update('memory', 'budget', 'Trip budget is $800.', 'trip budget is $800', 'board')], { thread: 'other:page', boardName: 'Holiday' });
  assert.equal((await readMuseLearning(owner, 'board:page')).summary, 'Planning a workshop; date undecided.');
});

test('replaying a committed turn after the recent history rolls over never duplicates history', async () => {
  const owner = 'learning-idempotence';
  for (let i = 0; i < 17; i++) await turn(owner, 'Earlier conversation ' + i, []);
  const snapshot = await readMuseLearning(owner, 'board:page');
  const userMessage = { id: randomUUID(), role: 'user', content: 'Another turn.' };
  const input = { snapshot, userMessage, messages: [...snapshot.messages, userMessage, { id: randomUUID(), role: 'assistant', content: 'Understood.' }], personalization: { updates: [], summary: 'A short conversation.' } };
  await commitMuseTurn(owner, 'board:page', input);
  const first = await readMuseConversation(owner, 'board:page');
  await commitMuseTurn(owner, 'board:page', input);
  assert.deepEqual(await readMuseConversation(owner, 'board:page'), first);
  await saveMuseChat(owner, 'board:page', input.messages);
  assert.deepEqual(await readMuseConversation(owner, 'board:page'), first);
  for (let i = 0; i < 33; i++) await turn(owner, 'Later conversation ' + i, [], { summary: 'A newer summary ' + i });
  const newer = await readMuseConversation(owner, 'board:page');
  await commitMuseTurn(owner, 'board:page', input);
  assert.deepEqual(await readMuseConversation(owner, 'board:page'), newer, 'old receipt cannot replace the latest summary after the recent turn list rolls over');
});

test('only owner customization overrides learned defaults, including older renamed templates', async () => {
  const { LEGACY_NOTE_TEMPLATES } = await import('../scripts/muse-defaults.mjs');
  const owner = 'learning-customization';
  let snapshot = await readMuseLearning(owner, 'board:page');
  assert.deepEqual(snapshot.ownerCustomized, { soul: false, memory: false });
  await saveMuseNote(owner, 'soul', LEGACY_NOTE_TEMPLATES.soul, snapshot.notes.soul.revision);
  const { readMuseCanvas, saveMuseCanvas } = await import('../scripts/muse-canvas.mjs');
  const canvas = await readMuseCanvas(owner);
  canvas.board.pages[0].objects.find(object => object.id === 'muse-name').text = 'Hello, my name is Miso.';
  await saveMuseCanvas(owner, canvas);
  snapshot = await readMuseLearning(owner, 'board:page');
  assert.equal(snapshot.ownerCustomized.soul, false);
  await turn(owner, 'I prefer detailed answers.', [update('soul', 'detail', 'Prefer detailed answers.', 'I prefer detailed answers')]);
  snapshot = await readMuseLearning(owner, 'board:page');
  assert.equal(snapshot.ownerCustomized.soul, false);
  await saveMuseNote(owner, 'soul', snapshot.notes.soul.content + '\nMy own style instruction.\n', snapshot.notes.soul.revision);
  assert.equal((await readMuseLearning(owner, 'board:page')).ownerCustomized.soul, true);
});

test('a forgotten project preference does not suppress the same key on another board', async () => {
  const owner = 'learning-forget-scope';
  await turn(owner, 'Our budget is $500.', [update('memory', 'budget', 'Budget is $500.', 'budget is $500', 'board')]);
  await turn(owner, 'Our budget is $500.', [update('memory', 'budget', 'Budget is $500.', 'budget is $500', 'board')], { thread: 'different:page' });
  await turn(owner, 'Forget our budget.', [update('memory', 'budget', '', 'Forget our budget', 'board', 'forget')], { summary: 'The budget used to be $500.' });
  const first = await readMuseLearning(owner, 'board:page');
  const other = await readMuseLearning(owner, 'different:page');
  assert.equal(first.summary, '');
  assert.doesNotMatch(JSON.stringify(first.contextMessages), /\$500/);
  assert.match(JSON.stringify(other.contextMessages), /\$500/);
  assert.deepEqual(other.suppressed, []);
  for (let i = 0; i < 18; i++) await turn(owner, 'Other conversation ' + i, [], { thread: 'different:page' });
  assert.match(JSON.stringify(await readMuseArchive(owner, 'different:page', 'budget')), /\$500/);
});

test('explicit forgetting removes generated context and excludes source messages from recall', async () => {
  const owner = 'learning-forget';
  await turn(owner, 'My favorite drink is rooibos.', [update('memory', 'drink', 'Favorite drink is rooibos.', 'My favorite drink is rooibos')]);
  for (let i = 0; i < 20; i++) await turn(owner, 'Unrelated chat ' + i, []);
  assert.ok((await readMuseArchive(owner, 'board:page', 'rooibos')).length);
  await turn(owner, 'Forget my favorite drink.', [update('memory', 'drink', '', 'Forget my favorite drink', 'owner', 'forget')]);
  assert.doesNotMatch((await readMuseLearning(owner, 'board:page')).memoryContext, /rooibos/);
  assert.deepEqual(await readMuseArchive(owner, 'board:page', 'rooibos'), []);
});


test('old onboarding text is removed without removing learned experience or handwritten notes', async () => {
  const { LEGACY_NOTE_TEMPLATES, PREVIOUS_NOTE_TEMPLATES } = await import('../scripts/muse-defaults.mjs');
  const owner = 'learning-clean-templates';
  await turn(owner, 'I live in Santa Cruz.', [update('memory', 'home', 'Lives in Santa Cruz.', 'I live in Santa Cruz')]);
  let note = await readMuseNote(owner, 'memory');
  await saveMuseNote(owner, 'memory', note.content.replace('# Memory', LEGACY_NOTE_TEMPLATES.memory.trimEnd()) + '\nMy own travel notes.', note.revision);
  note = await readMuseNote(owner, 'memory');
  assert.doesNotMatch(note.content, /Add the context|How I like to plan/);
  assert.match(note.content, /Lives in Santa Cruz/);
  assert.match(note.content, /My own travel notes/);
  let soul = await readMuseNote(owner, 'soul');
  await saveMuseNote(owner, 'soul', PREVIOUS_NOTE_TEMPLATES.soul + '\nMy own working style.', soul.revision);
  soul = await readMuseNote(owner, 'soul');
  assert.doesNotMatch(soul.content, /Make me yours/);
  assert.match(soul.content, /My own working style/);
});

const observed = (text, evidence) => ({...update('soul', 'detail', text, evidence), basis: 'observed'});
test('working-style choices need three independent quotes and stay private until supported', async () => {
  const owner = 'learning-pattern';
  for (const message of ['Shorten these notes.', 'Make this answer shorter.']) await turn(owner, message, [observed('Prefers brief answers.', message)]);
  let learning = await readMuseLearning(owner, 'board:page');
  assert.equal(learning.observations[0].count, 2);
  assert.equal(learning.entries.length, 0);
  assert.doesNotMatch(learning.soulContext, /brief answers/);
  await turn(owner, 'Make this answer shorter.', [observed('Prefers brief answers.', 'Make this answer shorter.')]);
  assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 0, 'repeated identical quote is not new evidence');
  await turn(owner, 'Trim the details here.', [observed('Prefers brief answers.', 'Trim the details here.')]);
  learning = await readMuseLearning(owner, 'another:page');
  assert.equal(learning.entries[0].basis, 'observed');
  assert.deepEqual(learning.observations, [], 'a learned pattern is no longer pending');
  assert.match(learning.soulContext, /Prefers brief answers/);
  assert.equal((await readMuseLearning('learning-pattern-other-owner', 'board:page')).observations.length, 0);
});

test('contradictory choices reset tentative style and cannot replace explicit preferences', async () => {
  const owner = 'learning-pattern-correction';
  await turn(owner, 'Shorten this.', [observed('Prefers brief answers.', 'Shorten this.')]);
  await turn(owner, 'Explain more here.', [observed('Prefers detailed answers.', 'Explain more here.')]);
  assert.equal((await readMuseLearning(owner, 'board:page')).observations[0].count, 1);
  await turn(owner, 'Always be concise.', [update('soul', 'detail', 'Always be concise.', 'Always be concise.')]);
  for (const message of ['Explain that.', 'More detail please.', 'Expand this answer.']) await turn(owner, message, [observed('Prefers detailed answers.', message)]);
  const learning = await readMuseLearning(owner, 'board:page');
  assert.equal(learning.observations.length, 0);
  assert.match(learning.soulContext, /Always be concise/);
  assert.doesNotMatch(learning.soulContext, /Prefers detailed/);
});


test('header-only notes receive starting copy once without losing experience or overriding later edits', async () => {
  const {MEMORY_INTRODUCTION} = await import('../scripts/muse-defaults.mjs');
  const owner = 'learning-restore-defaults';
  await turn(owner, 'I prefer short answers and I live in Santa Cruz.', [update('soul','detail','Prefer short answers.','I prefer short answers'),update('memory','home','Lives in Santa Cruz.','I live in Santa Cruz')]);
  const directory = museDirectory(owner);
  for (const key of ['soul','memory']) {
    const note = await readMuseNote(owner,key);
    const block = note.content.match(/<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/)[0];
    await writeFile(join(directory,key+'.md'), (key==='soul'?'# Soul':'# Memory')+'\n\n'+block+'\n');
  }
  const identityPath = join(directory,'identity.json'), identity = JSON.parse(await readFile(identityPath,'utf8'));
  delete identity.noteDefaultsVersion;
  await writeFile(identityPath,JSON.stringify(identity));
  const restored = await readMuseLearning(owner,'board:page');
  assert.match(restored.notes.soul.content,/Who I am/);
  assert.doesNotMatch(restored.notes.soul.content,/Make me yours/);
  assert.ok(restored.notes.memory.content.includes(MEMORY_INTRODUCTION));
  assert.match(restored.notes.memory.content,/Lives in Santa Cruz/);
  assert.equal(restored.entries.length,2);
  await saveMuseNote(owner,'soul','',restored.notes.soul.revision);
  await saveMuseNote(owner,'memory',restored.notes.memory.content.replace(MEMORY_INTRODUCTION,'My own introduction.'),restored.notes.memory.revision);
  for (let i=0;i<2;i++) {
    assert.equal((await readMuseNote(owner,'soul')).content,'');
    const memory = (await readMuseNote(owner,'memory')).content;
    assert.doesNotMatch(memory,/Your Muse learns what matters/);
    assert.match(memory,/My own introduction/);
    assert.match(memory,/Lives in Santa Cruz/);
  }
});


test('default restoration never treats a handwritten Memory identity as a Soul name declaration', async () => {
  const {restoreMuseNoteDefaults} = await import('../scripts/muse-defaults.mjs');
  const memory='# Memory\n\nMy name is Kumo.\n';
  assert.equal(restoreMuseNoteDefaults(memory,'memory','Kumo'),memory);
});
