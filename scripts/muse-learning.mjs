import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, rename, writeFile } from './muse-storage.mjs';
import { digest } from './muse-local.mjs';
import { DEFAULT_MUSE_STYLE, MUSE_NOTE_TEMPLATES, LEGACY_NOTE_TEMPLATES } from './muse-defaults.mjs';
import { ensureMuse, museDirectory, readMuseNote, saveMuseNoteUnlocked, withMuseOwner, validThread, readMuseConversation, saveMuseConversationUnlocked, chatArchivePath, NOTE_LIMIT } from './muse-store.mjs';

export { DEFAULT_MUSE_STYLE };
const START = '<!-- muze-learned:start -->', END = '<!-- muze-learned:end -->';
const blockPattern = /<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/g;
const entryPattern = /<!-- muze-entry:([a-f0-9]{24}):start -->\n([\s\S]*?)\n<!-- muze-entry:\1:end -->/g;
const MAX_ENTRIES = 160;
const emptyState = () => ({ version: 1, entries: [], lastTurnIds: [] });
const safeText = value => typeof value === 'string' && value.length <= 360 && value.trim() && !/[\u0000-\u001f\u007f]|<!--|-->/u.test(value);
const escapeMarkdown = value => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
const identityPath = owner => join(museDirectory(owner), 'identity.json');
const entryId = (update, boardId) => digest([update.target, update.scope, update.scope === 'board' ? boardId : '', update.key].join(':')).slice(0, 24);
const scopeMatches = (entry, boardId) => entry.scope === 'owner' || entry.boardId === boardId;

async function identity(owner) {
  const profile = await ensureMuse(owner);
  const value = JSON.parse(await readFile(identityPath(owner), 'utf8'));
  return { value, state: value.learning?.version === 1 ? structuredClone(value.learning) : emptyState(), name: profile.name };
}

function entryBody(entry) {
  if (entry.pinned) return entry.manualBody;
  const prefix = entry.scope === 'board' ? `**${escapeMarkdown(entry.boardName || 'Project')}:** ` : '';
  return '- ' + prefix + escapeMarkdown(entry.text);
}
function entryBlock(entry) {
  return `<!-- muze-entry:${entry.id}:start -->\n${entryBody(entry)}\n<!-- muze-entry:${entry.id}:end -->`;
}
function generatedBlock(target, entries) {
  const visible = entries.filter(entry => entry.target === target && !entry.deleted);
  if (!visible.length) return '';
  return `${START}\n## ${target === 'soul' ? 'Learned working style' : 'Learned context'}\n\n${visible.map(entryBlock).join('\n\n')}\n${END}`;
}
function splitNote(content) {
  const blocks = [...content.matchAll(blockPattern)];
  const entries = new Map();
  for (const block of blocks) for (const match of block[0].matchAll(entryPattern)) entries.set(match[1], match[2]);
  const extras = blocks.map(block => block[0].slice(START.length, -END.length).replace(entryPattern, '').replace(/^## Learned (?:working style|context)\s*$/gm, '').trim()).filter(Boolean).join('\n\n');
  const ownerText = content.replace(blockPattern, () => extras).trimEnd();
  return { ownerText, entries, blocks, extras };
}
function reconcile(state, notes) {
  let changed = false;
  for (const target of ['soul', 'memory']) {
    const parsed = splitNote(notes[target].content);
    for (const entry of state.entries.filter(entry => entry.target === target && !entry.deleted)) {
      const body = parsed.entries.get(entry.id);
      if (body === undefined) { entry.deleted = true; entry.deletedBy = 'owner'; changed = true; }
      else if (body !== entryBody(entry)) {
        entry.previousText = entry.text;
        entry.text = body.replace(/^\s*-\s*/, '').trim();
        entry.manualBody = body;
        entry.pinned = true;
        entry.updatedAt = Date.now();
        changed = true;
      }
    }
  }
  return changed;
}
function personalRevision(state, notes, boardId) {
  return digest(JSON.stringify({ soul: splitNote(notes.soul.content).ownerText, memory: splitNote(notes.memory.content).ownerText, entries: state.entries.filter(entry => scopeMatches(entry, boardId)).map(entry => ({ id: entry.id, deleted: entry.deleted, pinned: entry.pinned, text: entry.text })) }));
}
function view(state, notes, boardId) {
  const ownerText = Object.fromEntries(['soul', 'memory'].map(target => [target, splitNote(notes[target].content).ownerText]));
  const entries = state.entries.filter(entry => !entry.deleted && scopeMatches(entry, boardId));
  const contextNotes = Object.fromEntries(['soul', 'memory'].map(target => {
    const learned = entries.filter(entry => entry.target === target).map(entry => entryBody(entry)).join('\n');
    return [target, ownerText[target] + (learned ? '\n\n' + (target === 'soul' ? 'Learned working style' : 'Learned context') + ':\n' + learned : '')];
  }));
  return { entries, ownerText, contextNotes, suppressed: state.entries.filter(entry => (entry.deleted || entry.pinned) && scopeMatches(entry, boardId)).map(entry => ({ key: entry.key, target: entry.target, scope: entry.scope, boardId: entry.boardId, deleted: !!entry.deleted })) };
}

function contextMessages(messages, state, boardId) {
  const suppressed = state.entries.filter(entry => (entry.deleted || entry.pinned) && scopeMatches(entry, boardId));
  const ids = new Set(suppressed.flatMap(entry => [...(entry.sourceMessageIds || []), entry.sourceMessageId]));
  const evidence = suppressed.flatMap(entry => [entry.evidence, ...(entry.evidenceHistory || []), entry.previousText, entry.deleted ? entry.text : null]).filter(value => typeof value === 'string' && value.length >= 4).map(value => value.toLowerCase());
  const groups = [];
  for (const message of messages) {
    if (message.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(message);
  }
  return groups.filter(group => !group.some(message => ids.has(message.id) || evidence.some(value => message.content.toLowerCase().includes(value)))).flat();
}

// A read reconciles owner changes before they can enter the next model request.
export async function readMuseLearning(owner, thread) {
  validThread(thread);
  return withMuseOwner(owner, async () => {
    const { state, name } = await identity(owner);
    const notes = { soul: await readMuseNote(owner, 'soul'), memory: await readMuseNote(owner, 'memory') };
    const ownerEdited = reconcile(state, notes);
    const conversation = await readMuseConversation(owner, thread);
    const revision = personalRevision(state, notes, thread.split(':')[0]);
    const context = view(state, notes, thread.split(':')[0]);
    const normalize = content => content.replace(`I’m ${name}, your companion inside Muze.`, 'I’m Muse, your companion inside Muze.').trim().replace(/\n{3,}/g, '\n\n');
    const ownerCustomized = Object.fromEntries(['soul', 'memory'].map(key => [key, ![MUSE_NOTE_TEMPLATES[key], LEGACY_NOTE_TEMPLATES[key]].some(template => normalize(template) === normalize(context.ownerText[key]))]));
    return {
      ...context, notes, revision, ownerCustomized,
      summary: !ownerEdited && conversation.summaryRevision === revision ? conversation.summary || '' : '',
      messages: conversation.messages,
      contextMessages: contextMessages(conversation.messages, state, thread.split(':')[0]),
      defaults: DEFAULT_MUSE_STYLE,
      soulContext: context.contextNotes.soul,
      memoryContext: context.contextNotes.memory,
      promptEntries: context.entries.map(entry => ({ key: entry.key, target: entry.target, scope: entry.scope, text: entry.text, pinned: entry.pinned })),
    };
  });
}

function validateUpdate(update, message) {
  if (!update || !['soul', 'memory'].includes(update.target) || !['owner', 'board'].includes(update.scope) || !['upsert', 'forget'].includes(update.operation)) return false;
  if (typeof update.key !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(update.key)) return false;
  if (update.target === 'soul' && (update.scope !== 'owner' || !Object.hasOwn(DEFAULT_MUSE_STYLE, update.key))) return false;
  if (typeof update.evidence !== 'string' || update.evidence.trim().length < 4 || !message.includes(update.evidence)) return false;
  return update.operation === 'forget' || safeText(update.text);
}
function renderNote(content, target, entries) {
  const parsed = splitNote(content);
  const generated = [parsed.extras, generatedBlock(target, entries)].filter(Boolean).join('\n\n');
  const matches = [...content.matchAll(blockPattern)];
  if (matches.length === 1) return content.slice(0, matches[0].index) + generated + content.slice(matches[0].index + matches[0][0].length);
  // Owner-modified marker structure is preserved verbatim; do not rewrite it.
  if (matches.length > 1 || content.includes(START) || content.includes(END)) return content;
  return generated ? content.trimEnd() + '\n\n' + generated + '\n' : content;
}

export async function commitMuseTurn(owner, thread, input) {
  validThread(thread);
  const boardId = thread.split(':')[0];
  return withMuseOwner(owner, async () => {
    const { value, state } = await identity(owner);
    const notes = { soul: await readMuseNote(owner, 'soul'), memory: await readMuseNote(owner, 'memory') };
    const ownerEdited = reconcile(state, notes);
    const userMessage = input.userMessage;
    const stale = new Set(['soul', 'memory'].filter(key => notes[key].revision !== input.snapshot?.notes?.[key]?.revision));
    const malformed = new Set(['soul', 'memory'].filter(key => {
      const content = notes[key].content, count = [...content.matchAll(blockPattern)].length;
      return count > 1 || (!count && /<!-- muze-(?:learned|entry):/.test(content));
    }));
    let learningChanged = false;
    let forgotten = false;
    const currentConversation = await readMuseConversation(owner, thread);
    const duplicate = state.lastTurnIds.includes(userMessage?.id) || (currentConversation.recentMessageIds || currentConversation.messages.map(message => message.id)).includes(userMessage?.id);
    if (duplicate) {
      const revision = personalRevision(state, notes, boardId);
      return { messages: currentConversation.messages, learningChanged: false, notes, summary: ownerEdited || currentConversation.summaryRevision !== revision ? '' : currentConversation.summary || '', revision };
    }
    if (!duplicate && typeof userMessage?.content === 'string' && typeof userMessage?.id === 'string') {
      for (const update of (Array.isArray(input.personalization?.updates) ? input.personalization.updates : []).slice(0, 6)) {
        if (!validateUpdate(update, userMessage.content) || stale.has(update.target) || malformed.has(update.target)) continue;
        const id = entryId(update, boardId), previous = state.entries.find(entry => entry.id === id);
        if (previous?.pinned || previous?.deletedBy === 'owner') continue;
        if (update.operation === 'forget') {
          if (previous && !previous.deleted) { previous.deleted = true; previous.deletedBy = 'request'; previous.updatedAt = Date.now(); learningChanged = true; forgotten = true; }
          continue;
        }
        if (!previous && state.entries.length >= MAX_ENTRIES) continue;
        const next = {
          id, key: update.key, target: update.target, scope: update.scope,
          ...(update.scope === 'board' ? { boardId, boardName: typeof input.boardName === 'string' ? input.boardName.slice(0, 160) : 'Project' } : {}),
          text: update.text.trim(), evidence: update.evidence, sourceMessageId: userMessage.id,
          sourceMessageIds: [...new Set([...(previous?.sourceMessageIds || []), previous?.sourceMessageId, userMessage.id].filter(Boolean))].slice(-32),
          evidenceHistory: [...new Set([...(previous?.evidenceHistory || []), previous?.evidence, update.evidence].filter(Boolean))].slice(-16),
          createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(), pinned: false, deleted: false,
        };
        const candidateEntries = state.entries.map(entry => entry.id === id ? next : entry);
        if (!previous) candidateEntries.push(next);
        if (Buffer.byteLength(renderNote(notes[update.target].content, update.target, candidateEntries)) > NOTE_LIMIT) continue;
        if (previous) Object.assign(previous, next, { deletedBy: undefined }); else state.entries.push(next);
        learningChanged = true;
      }
      state.lastTurnIds = [...state.lastTurnIds, userMessage.id].slice(-32);
    }
    for (const target of ['soul', 'memory']) {
      if (stale.has(target) || malformed.has(target)) continue;
      const content = renderNote(notes[target].content, target, state.entries);
      if (content !== notes[target].content && Buffer.byteLength(content) <= NOTE_LIMIT) notes[target] = await saveMuseNoteUnlocked(owner, target, content, notes[target].revision);
    }
    value.learning = state;
    const path = identityPath(owner), temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    const summary = input.personalization?.summary;
    const summaryValid = typeof summary === 'string' && summary.length <= 2400 && !summary.includes('\0');
    const revision = personalRevision(state, notes, boardId);
    const updatedConversation = await saveMuseConversationUnlocked(owner, thread, input.messages, {
      summary: ownerEdited || stale.size || forgotten ? '' : summaryValid ? summary : currentConversation.summaryRevision === revision ? currentConversation.summary || '' : '',
      summaryRevision: revision,
    });
    return { messages: updatedConversation.messages, learningChanged, notes, summary: updatedConversation.summary, revision };
  });
}

// Read a few relevant archive sections, never every conversation or another owner.
export async function readMuseArchive(owner, thread, query = '', limit = 6) {
  validThread(thread);
  const conversation = await readMuseConversation(owner, thread);
  const { state } = await identity(owner);
  const notes = { soul: await readMuseNote(owner, 'soul'), memory: await readMuseNote(owner, 'memory') };
  reconcile(state, notes);
  const terms = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,31}/gu) || []);
  if (!terms.size) return [];
  const ranked = conversation.archives.map(chunk => ({ ...chunk, score: chunk.terms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) }))
    .filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 4);
  const candidates = [];
  for (const descriptor of ranked) {
    const messages = contextMessages(JSON.parse(await readFile(chatArchivePath(owner, thread, descriptor.index), 'utf8')), state, thread.split(':')[0]);
    for (const message of messages) {
      const words = new Set(message.content.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,31}/gu) || []);
      const score = [...terms].filter(term => words.has(term)).length;
      if (score) candidates.push({ message, score, index: descriptor.index });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || b.index - a.index).slice(0, Math.max(0, Math.min(12, limit))).map(item => item.message);
}
