import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'muze-memory-lifecycle-'));
process.env.MUZE_PRIVATE_DIR = directory;
const { digest } = await import('../scripts/muse-local.mjs');
const { readMuseLearning, commitMuseTurn, readMuseArchive } = await import('../scripts/muse-learning.mjs');
const { readMuseChat, readMuseNote, saveMuseNote, museDirectory, saveMuseChat, readMuseConversation, chatArchivePath } = await import('../scripts/muse-store.mjs');
after(() => rm(directory, { recursive: true, force: true }));
const update = (key, text, evidence, extra = {}) => ({ key, target: 'memory', scope: 'board', operation: 'upsert', text, evidence, ...extra });
async function turn(owner, content, updates = [], extra = {}) {
  const thread = extra.thread || 'board:page';
  const snapshot = await readMuseLearning(owner, thread);
  const userMessage = { id: randomUUID(), role: 'user', content };
  return commitMuseTurn(owner, thread, { snapshot, userMessage, boardName: 'Current plan', messages: [...await readMuseChat(owner, thread), userMessage, { id: randomUUID(), role: 'assistant', content: extra.reply || 'Done.' }], personalization: { updates, summary: extra.summary || '' } });
}
async function stored(owner) { return JSON.parse(await readFile(join(museDirectory(owner), 'identity.json'), 'utf8')); }
function entry(key, extra = {}) {
  return { id: digest('memory:board:board:' + key).slice(0, 24), key, target: 'memory', scope: 'board', boardId: 'board', boardName: 'Current plan', text: 'Project detail ' + key.replaceAll('_', ' '), evidence: 'Project detail ' + key, sourceMessageId: 'source-' + key, createdAt: 1000, updatedAt: 1000, ...extra };
}
async function seed(owner, entries) {
  const snapshot = await readMuseLearning(owner, 'board:page');
  const identity = await stored(owner);
  identity.learning = { version: 1, entries, lastTurnIds: [] };
  await writeFile(join(museDirectory(owner), 'identity.json'), JSON.stringify(identity));
  const visible = entries.filter(value => !value.deleted && !value.inactiveReason);
  const blocks = visible.map(value => `<!-- muze-entry:${value.id}:start -->\n${value.pinned ? value.manualBody : '- ' + (value.scope === 'board' ? '**Current plan:** ' : '') + value.text}\n<!-- muze-entry:${value.id}:end -->`).join('\n\n');
  await saveMuseNote(owner, 'memory', snapshot.ownerText.memory + '\n\n<!-- muze-learned:start -->\n## Learned context\n\n' + blocks + '\n<!-- muze-learned:end -->', snapshot.notes.memory.revision);
}

test('duplicates share one entry and aliases honor owner edits and deletions', async () => {
  const owner = 'deduplicated-memory';
  await turn(owner, 'I prefer concise replies.', [update('reply_style', 'Prefers concise replies.', 'I prefer concise replies', { scope: 'owner' })]);
  await turn(owner, 'I prefer short responses.', [update('answer_style', 'Prefers short responses.', 'I prefer short responses', { scope: 'owner' })]);
  assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 1);
  let note = await readMuseNote(owner, 'memory');
  await saveMuseNote(owner, 'memory', note.content.replace('Prefers short responses.', 'Use detailed explanations.'), note.revision);
  await turn(owner, 'I prefer concise replies.', [update('answer_style', 'Prefers concise replies.', 'I prefer concise replies', { scope: 'owner' })]);
  assert.equal((await readMuseLearning(owner, 'board:page')).entries[0].pinned, true);
  note = await readMuseNote(owner, 'memory');
  await saveMuseNote(owner, 'memory', note.content.replace(/<!-- muze-entry:[a-f0-9]{24}:start -->[\s\S]*?<!-- muze-entry:[a-f0-9]{24}:end -->/, ''), note.revision);
  await turn(owner, 'I prefer concise replies.', [update('answer_style', 'Prefers concise replies.', 'I prefer concise replies', { scope: 'owner' })]);
  assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 0);
  assert.equal((await stored(owner)).learning.entries[0].deletedBy, 'owner');
});

test('a corrected fact excludes outdated exchanges while preserving the private displayed chat', async () => {
  const owner = 'corrected-memory';
  await turn(owner, 'Our budget is $500.', [update('budget', 'Budget is $500.', 'budget is $500')]);
  await turn(owner, 'Our budget is now $800.', [update('budget', 'Budget is $800.', 'budget is now $800')]);
  const snapshot = await readMuseLearning(owner, 'board:page');
  assert.equal(snapshot.messages.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot.contextMessages), /\$500/);
  assert.match(JSON.stringify(snapshot.contextMessages), /\$800/);
});

test('temporary facts expire after the quoted UTC date and only current renewal reactivates them', async () => {
  const owner = 'expired-memory', originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2030-01-10T12:00:00Z');
    await turn(owner, 'Our workshop budget is $500 through 2030-01-10.', [update('budget', 'Workshop budget is $500.', 'budget is $500 through 2030-01-10', { expiresAt: '2030-01-10' })], { summary: 'Workshop budget is $500.' });
    assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 1);
    Date.now = () => Date.parse('2030-01-10T23:59:59.999Z');
    assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 1);
    Date.now = () => Date.parse('2030-01-11T00:00:00Z');
    let snapshot = await readMuseLearning(owner, 'board:page');
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.summary, '');
    assert.deepEqual(snapshot.contextMessages, []);
    await turn(owner, 'Continue with the project.', [], { summary: 'An old budget was $500.' });
    snapshot = await readMuseLearning(owner, 'board:page');
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.summary, '');
    assert.doesNotMatch(snapshot.notes.memory.content, /\$500/);
    const retired = (await stored(owner)).learning.entries[0];
    assert.equal(retired.inactiveReason, 'expired');
    assert.equal(retired.text, undefined);
    await turn(owner, 'Renew our budget to $800 through 2030-02-01.', [update('budget', 'Workshop budget is $800.', 'budget to $800 through 2030-02-01', { expiresAt: '2030-02-01' })]);
    snapshot = await readMuseLearning(owner, 'board:page');
    assert.equal(snapshot.entries.length, 1);
    assert.match(snapshot.memoryContext, /\$800/);
    assert.doesNotMatch(JSON.stringify(snapshot.contextMessages), /budget is \$500/);
  } finally { Date.now = originalNow; }
});

test('owner-pinned edits stay active past expiry and distinct preferences never merge', async () => {
  const owner = 'pinned-expiry', originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2030-01-10T12:00:00Z');
    await turn(owner, 'The budget is $500 through 2030-01-10.', [update('budget', 'Budget is $500.', 'budget is $500 through 2030-01-10', { expiresAt: '2030-01-10' })]);
    const note = await readMuseNote(owner, 'memory');
    await saveMuseNote(owner, 'memory', note.content.replace('Budget is $500.', 'Keep the budget at $800.'), note.revision);
    Date.now = () => Date.parse('2030-01-11T00:00:00Z');
    await turn(owner, 'Continue the project.');
    assert.equal((await readMuseLearning(owner, 'board:page')).entries[0].pinned, true);
    assert.match((await readMuseLearning(owner, 'board:page')).memoryContext, /\$800/);
    await turn(owner, 'I like tea and my partner does not like tea.', [update('mine', 'I like tea.', 'I like tea', { scope: 'owner' }), update('partner', 'My partner does not like tea.', 'my partner does not like tea', { scope: 'owner' })]);
    assert.equal((await readMuseLearning(owner, 'board:page')).entries.length, 3);
  } finally { Date.now = originalNow; }
});

test('capacity retires automatic facts, bounds retirement metadata, and keeps pins and deletions', async () => {
  const owner = 'memory-capacity';
  const active = Array.from({ length: 160 }, (_, i) => entry('fact_' + i, { updatedAt: i + 1000 }));
  const pinned = entry('manual', { pinned: true, manualBody: '- My own pinned instruction.', text: 'My own pinned instruction.' });
  const deleted = entry('removed', { deleted: true, deletedBy: 'owner' });
  const retired = Array.from({ length: 520 }, (_, i) => entry('old_' + i, { inactiveReason: 'expired', inactiveAt: i, expiresAt: '2000-01-01' }));
  await seed(owner, [...active, pinned, deleted, ...retired]);
  const result = await turn(owner, 'The new venue is Cedar Hall.', [update('venue', 'Venue is Cedar Hall.', 'new venue is Cedar Hall')]);
  const state = (await stored(owner)).learning;
  assert.equal(result.learningStats.active, 161);
  assert.equal(result.learningStats.retired, 512);
  assert.equal(result.learningStats.skipped, 0);
  assert.equal(state.entries.find(value => value.key === 'manual').pinned, true);
  assert.equal(state.entries.find(value => value.key === 'removed').deletedBy, 'owner');
  assert.equal(state.entries.find(value => value.key === 'fact_0').inactiveReason, 'capacity');
  assert.ok(state.entries.find(value => value.key === 'venue'));
  assert.ok(state.entries.filter(value => value.inactiveReason).every(value => value.text === undefined && value.evidence === undefined));
  assert.equal(Buffer.from(state.retiredSourceFilter, 'base64').length, 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 4000000);
});

test('archive retrieval keeps complete exchanges and finds rare terms outside the top-term index', async () => {
  const owner = 'archive-rarity', thread = 'board:page';
  const rare = Array.from({ length: 350 }, (_, i) => 'uniqueitem' + String(i).padStart(4, '0'));
  const messages = [{ id: 'rare-user', role: 'user', content: rare.join(' ') }, { id: 'rare-answer', role: 'assistant', content: 'The requested inventory is stored in Cedar Hall.' }];
  for (let i = 0; i < 40; i++) messages.push({ id: 'extra-' + i, role: i % 2 ? 'assistant' : 'user', content: 'Different discussion ' + i });
  await saveMuseChat(owner, thread, messages);
  const envelope = await readMuseConversation(owner, thread);
  assert.equal(envelope.archives[0].terms.length, 256);
  assert.ok(!envelope.archives[0].terms.includes(rare.at(-1)));
  const retrieved = await readMuseArchive(owner, thread, rare.at(-1));
  assert.deepEqual(retrieved.map(value => value.id), ['rare-user', 'rare-answer']);
  assert.deepEqual(await readMuseArchive(owner, thread, rare.at(-1), 1), []);
});

test('archive boundaries preserve pairs and multilingual retrieval returns chronological exchanges', async () => {
  const owner = 'archive-exchanges', thread = 'board:page';
  const messages = Array.from({ length: 300 }, (_, i) => ({ id: 'exchange-' + i, role: i % 2 ? 'assistant' : 'user', content: [0, 100, 240].includes(i) ? 'The workshop budget is $' + (500 + i) : 'Discussion item ' + i }));
  await saveMuseChat(owner, thread, messages);
  const envelope = await readMuseConversation(owner, thread);
  for (let i = 0; i < envelope.archiveCount; i++) {
    const chunk = JSON.parse(await readFile(chatArchivePath(owner, thread, i), 'utf8'));
    assert.equal(chunk[0].role, 'user'); assert.equal(chunk.at(-1).role, 'assistant');
  }
  const result = await readMuseArchive(owner, thread, 'presupuesto', 6);
  assert.deepEqual(result.map(value => value.id), ['exchange-0', 'exchange-1', 'exchange-100', 'exchange-101', 'exchange-240', 'exchange-241']);
  assert.deepEqual(await readMuseArchive(owner, 'other:page', 'presupuesto', 6), []);
});

test('legacy split exchanges are repaired by reading the neighboring archive section', async () => {
  const owner = 'legacy-archive-boundary', thread = 'board:page';
  await readMuseLearning(owner, thread);
  const first = Array.from({ length: 126 }, (_, i) => ({ id: 'legacy-' + i, role: i % 2 ? 'assistant' : 'user', content: 'Unrelated item ' + i }));
  first.push({ id: 'legacy-question', role: 'user', content: 'What name did we agree on?' });
  const second = [{ id: 'legacy-answer', role: 'assistant', content: 'The project name is Maplefjord.' }];
  await writeFile(chatArchivePath(owner, thread, 0), JSON.stringify(first));
  await writeFile(chatArchivePath(owner, thread, 1), JSON.stringify(second));
  await writeFile(join(museDirectory(owner), 'chat-' + digest(thread) + '.json'), JSON.stringify({ version: 2, messages: [], archiveCount: 2, archives: [{ index: 0, terms: ['question'] }, { index: 1, terms: ['maplefjord'] }] }));
  assert.deepEqual((await readMuseArchive(owner, thread, 'Maplefjord')).map(value => value.id), ['legacy-question', 'legacy-answer']);
});

test('a full archive index reads only relevant sections and does not scan every archived file', async () => {
  const owner = 'large-archive-index', thread = 'board:page';
  await readMuseLearning(owner, thread);
  const archives = Array.from({ length: 256 }, (_, index) => ({ index, count: 128, terms: [index === 127 ? 'beaconstone' : 'ordinary'] }));
  await writeFile(chatArchivePath(owner, thread, 127), JSON.stringify([{ id: 'bounded-question', role: 'user', content: 'Use Beaconstone as the name.' }, { id: 'bounded-answer', role: 'assistant', content: 'I updated the notes.' }]));
  await writeFile(join(museDirectory(owner), 'chat-' + digest(thread) + '.json'), JSON.stringify({ version: 2, messages: [], archiveCount: 256, archives }));
  assert.deepEqual((await readMuseArchive(owner, thread, 'Beaconstone')).map(value => value.id), ['bounded-question', 'bounded-answer']);
});
