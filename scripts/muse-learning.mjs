import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, rename, writeFile } from './muse-storage.mjs';
import { digest } from './muse-local.mjs';
import { completeExchanges, retrievalTerms, retrievalScore, filterAdd, filterHas, factForms } from './muse-retrieval.mjs';
import { DEFAULT_MUSE_STYLE, MUSE_NOTE_TEMPLATES, LEGACY_NOTE_TEMPLATES } from './muse-defaults.mjs';
import { ensureMuse, museDirectory, readMuseNote, saveMuseNoteUnlocked, withMuseOwner, validThread, readMuseConversation, saveMuseConversationUnlocked, chatArchivePath, NOTE_LIMIT } from './muse-store.mjs';

export { DEFAULT_MUSE_STYLE };
const START = '<!-- muze-learned:start -->', END = '<!-- muze-learned:end -->';
const blockPattern = /<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/g;
const entryPattern = /<!-- muze-entry:([a-f0-9]{24}):start -->\n([\s\S]*?)\n<!-- muze-entry:\1:end -->/g;
const MAX_ENTRIES = 160, MAX_RETIREMENTS = 512, MAX_LEARNING_BYTES = 4_000_000;
const SUPPRESSION_BYTES = 8192;
const emptyState = () => ({ version: 1, entries: [], lastTurnIds: [] });
const safeText = value => typeof value === 'string' && value.length <= 360 && value.trim() && !/[\u0000-\u001f\u007f]|<!--|-->/u.test(value);
const escapeMarkdown = value => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
const identityPath = owner => join(museDirectory(owner), 'identity.json');
const entryId = (update, boardId) => digest([update.target, update.scope, update.scope === 'board' ? boardId : '', update.key].join(':')).slice(0, 24);
const scopeMatches = (entry, boardId) => entry.scope === 'owner' || entry.boardId === boardId;
const expired = entry => !entry.pinned && entry.scope === 'board' && entry.target === 'memory' && typeof entry.expiresAt === 'string' && Date.now() > Date.parse(entry.expiresAt + 'T23:59:59.999Z');
const activeEntry = entry => !entry.deleted && !entry.inactiveReason && !expired(entry);
const factHashes = entry => [...new Set([...(entry.factHashes || []), ...[entry.text, entry.previousText].filter(value => typeof value === 'string').flatMap(value => factForms(value).map(digest))])];
const sameScope = (entry, update, boardId) => entry.target === update.target && entry.scope === update.scope && (entry.scope === 'owner' || entry.boardId === boardId);
function rememberSuppression(state, entry) {
  const prefix = entry.scope === 'owner' ? 'owner:' : 'board:' + entry.boardId + ':';
  const ids = [...(entry.sourceMessageIds || []), entry.sourceMessageId].filter(value => typeof value === 'string');
  if (ids.length) state.retiredSourceFilter = filterAdd(state.retiredSourceFilter, ids.map(id => prefix + id), SUPPRESSION_BYTES);
}
function retireExpired(state) {
  let changed = false;
  for (const entry of state.entries) if (!entry.deleted && expired(entry) && entry.inactiveReason !== 'expired') {
    entry.inactiveReason = 'expired'; entry.inactiveAt = Date.now(); rememberSuppression(state, entry); changed = true;
  }
  return changed;
}
function compactState(state) {
  state.entries = state.entries.map(entry => {
    if (!entry.deleted && (entry.pinned || !entry.inactiveReason)) return entry;
    if (entry.deleted || entry.inactiveReason === 'expired') rememberSuppression(state, entry);
    const keep = ['id','key','target','scope','boardId','createdAt','updatedAt','pinned','deleted','deletedBy','inactiveReason','inactiveAt','expiresAt','aliasIds'];
    return { ...Object.fromEntries(keep.filter(key => entry[key] !== undefined).map(key => [key, entry[key]])), factHashes: factHashes(entry).slice(-12), bodyHash: entry.bodyHash || digest(entryBody(entry)) };
  });
  const retired = state.entries.filter(entry => !entry.deleted && entry.inactiveReason).sort((a, b) => (b.inactiveAt || 0) - (a.inactiveAt || 0));
  const keep = new Set(retired.slice(0, MAX_RETIREMENTS).map(entry => entry.id));
  // Explicit owner/request deletion markers and pinned entries are never pruned.
  // Old automatic retirements lose full metadata, but expired sources remain in
  // the scoped suppression filter. Its only precision loss is excess omission.
  state.entries = state.entries.filter(entry => entry.deleted || !entry.inactiveReason || keep.has(entry.id));
}


async function identity(owner) {
  const profile = await ensureMuse(owner);
  const value = JSON.parse(await readFile(identityPath(owner), 'utf8'));
  return { value, state: value.learning?.version === 1 ? structuredClone(value.learning) : emptyState(), name: profile.name };
}

function entryBody(entry) {
  if (entry.pinned) return entry.manualBody;
  const prefix = entry.scope === 'board' ? `**${escapeMarkdown(entry.boardName || 'Project')}:** ` : '';
  return '- ' + prefix + escapeMarkdown(entry.text || '');
}
function entryBlock(entry) {
  return `<!-- muze-entry:${entry.id}:start -->\n${entryBody(entry)}\n<!-- muze-entry:${entry.id}:end -->`;
}
function generatedBlock(target, entries) {
  const visible = entries.filter(entry => entry.target === target && activeEntry(entry));
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
      if (body === undefined) { if (entry.inactiveReason) continue; entry.deleted = true; entry.deletedBy = 'owner'; changed = true; }
      else if (entry.bodyHash ? digest(body) !== entry.bodyHash : body !== entryBody(entry)) {
        entry.previousText = entry.text;
        entry.text = body.replace(/^\s*-\s*/, '').trim();
        entry.manualBody = body;
        entry.pinned = true; entry.inactiveReason = undefined; entry.bodyHash = undefined;
        entry.updatedAt = Date.now();
        changed = true;
      }
    }
  }
  return changed;
}
function personalRevision(state, notes, boardId) {
  return digest(JSON.stringify({ soul: splitNote(notes.soul.content).ownerText, memory: splitNote(notes.memory.content).ownerText, entries: state.entries.filter(entry => scopeMatches(entry, boardId)).map(entry => ({ id: entry.id, deleted: entry.deleted, pinned: entry.pinned, text: entry.text, inactive: entry.inactiveReason || (expired(entry) ? 'expired' : null), expiresAt: entry.expiresAt })) }));
}
function view(state, notes, boardId) {
  const ownerText = Object.fromEntries(['soul', 'memory'].map(target => [target, splitNote(notes[target].content).ownerText]));
  const entries = state.entries.filter(entry => activeEntry(entry) && scopeMatches(entry, boardId));
  const contextNotes = Object.fromEntries(['soul', 'memory'].map(target => {
    const learned = entries.filter(entry => entry.target === target).map(entry => entryBody(entry)).join('\n');
    return [target, ownerText[target] + (learned ? '\n\n' + (target === 'soul' ? 'Learned working style' : 'Learned context') + ':\n' + learned : '')];
  }));
  return { entries, ownerText, contextNotes, suppressed: state.entries.filter(entry => (entry.deleted || entry.pinned || entry.inactiveReason === 'expired' || expired(entry)) && scopeMatches(entry, boardId)).map(entry => ({ key: entry.key, target: entry.target, scope: entry.scope, boardId: entry.boardId, deleted: !!entry.deleted || entry.inactiveReason === 'expired' || expired(entry), expired: entry.inactiveReason === 'expired' || expired(entry) })) };
}

function contextMessages(messages, state, boardId) {
  const suppressed = state.entries.filter(entry => (entry.deleted || entry.pinned || entry.inactiveReason === 'expired' || expired(entry)) && scopeMatches(entry, boardId));
  const ids = new Set(suppressed.flatMap(entry => [...(entry.sourceMessageIds || []), entry.sourceMessageId]));
  const evidence = suppressed.flatMap(entry => [entry.evidence, ...(entry.evidenceHistory || []), entry.previousText, entry.deleted ? entry.text : null]).filter(value => typeof value === 'string' && value.length >= 4).map(value => value.toLowerCase());
  const groups = [];
  for (const message of messages) {
    if (message.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(message);
  }
  return groups.filter(group => !group.some(message => ids.has(message.id) || filterHas(state.retiredSourceFilter, 'owner:' + message.id, SUPPRESSION_BYTES) || filterHas(state.retiredSourceFilter, 'board:' + boardId + ':' + message.id, SUPPRESSION_BYTES) || evidence.some(value => message.content.toLowerCase().includes(value)))).flat();
}

// A read reconciles owner changes before they can enter the next model request.
export async function readMuseLearning(owner, thread) {
  validThread(thread);
  return withMuseOwner(owner, async () => {
    const { state, name } = await identity(owner);
    const notes = { soul: await readMuseNote(owner, 'soul'), memory: await readMuseNote(owner, 'memory') };
    const ownerEdited = reconcile(state, notes), expiredChanged = retireExpired(state);
    const conversation = await readMuseConversation(owner, thread);
    const revision = personalRevision(state, notes, thread.split(':')[0]);
    const context = view(state, notes, thread.split(':')[0]);
    const normalize = content => content.replace(`I’m ${name}, your companion inside Muze.`, 'I’m Muse, your companion inside Muze.').trim().replace(/\n{3,}/g, '\n\n');
    const ownerCustomized = Object.fromEntries(['soul', 'memory'].map(key => [key, ![MUSE_NOTE_TEMPLATES[key], LEGACY_NOTE_TEMPLATES[key]].some(template => normalize(template) === normalize(context.ownerText[key]))]));
    return {
      ...context, notes, revision, ownerCustomized,
      summary: !ownerEdited && !expiredChanged && conversation.summaryRevision === revision ? conversation.summary || '' : '',
      messages: conversation.messages,
      contextMessages: contextMessages(conversation.messages, state, thread.split(':')[0]),
      defaults: DEFAULT_MUSE_STYLE,
      soulContext: context.contextNotes.soul,
      memoryContext: context.contextNotes.memory,
      promptEntries: context.entries.map(entry => ({ key: entry.key, target: entry.target, scope: entry.scope, text: entry.text, pinned: entry.pinned, expiresAt: entry.expiresAt })),
    };
  });
}

function validateUpdate(update, message) {
  if (!update || !['soul', 'memory'].includes(update.target) || !['owner', 'board'].includes(update.scope) || !['upsert', 'forget'].includes(update.operation)) return false;
  if (typeof update.key !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(update.key)) return false;
  if (update.target === 'soul' && (update.scope !== 'owner' || !Object.hasOwn(DEFAULT_MUSE_STYLE, update.key))) return false;
  if (typeof update.evidence !== 'string' || update.evidence.trim().length < 4 || !message.includes(update.evidence)) return false;
  if (update.expiresAt !== undefined && update.expiresAt !== null && (update.operation !== 'upsert' || update.target !== 'memory' || update.scope !== 'board' || typeof update.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(update.expiresAt) || !update.evidence.includes(update.expiresAt) || !Number.isFinite(Date.parse(update.expiresAt + 'T00:00:00Z')) || new Date(update.expiresAt + 'T00:00:00Z').toISOString().slice(0, 10) !== update.expiresAt)) return false;
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
    const ownerEdited = reconcile(state, notes), expiredChanged = retireExpired(state);
    const userMessage = input.userMessage;
    const stale = new Set(['soul', 'memory'].filter(key => notes[key].revision !== input.snapshot?.notes?.[key]?.revision));
    const malformed = new Set(['soul', 'memory'].filter(key => {
      const content = notes[key].content, count = [...content.matchAll(blockPattern)].length;
      return count > 1 || (!count && /<!-- muze-(?:learned|entry):/.test(content));
    }));
    let learningChanged = expiredChanged, capacitySkipped = 0;
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
        const proposedId = entryId(update, boardId), hashes = update.operation === 'upsert' ? factForms(update.text).map(digest) : [];
        const previous = state.entries.find(entry => entry.id === proposedId || entry.aliasIds?.includes(proposedId)) || state.entries.find(entry => sameScope(entry, update, boardId) && hashes.some(hash => factHashes(entry).includes(hash)));
        const id = previous?.id || proposedId;
        if (previous?.pinned || previous?.deletedBy === 'owner') continue;
        if (update.operation === 'forget') {
          if (previous && !previous.deleted) { previous.deleted = true; previous.deletedBy = 'request'; previous.updatedAt = Date.now(); learningChanged = true; forgotten = true; }
          continue;
        }
        const draft = structuredClone(state);
        const activeCount = draft.entries.filter(entry => activeEntry(entry) && !entry.pinned && entry.id !== id).length;
        if (activeCount >= MAX_ENTRIES) {
          const candidate = draft.entries.filter(entry => activeEntry(entry) && !entry.pinned && entry.target === 'memory' && entry.id !== id && !stale.has(entry.target) && !malformed.has(entry.target))
            .sort((a, b) => (a.scope === 'board' ? 0 : 1) - (b.scope === 'board' ? 0 : 1) || retrievalScore(a.text, userMessage.content) - retrievalScore(b.text, userMessage.content) || a.updatedAt - b.updatedAt)[0];
          if (!candidate) { capacitySkipped++; continue; }
          candidate.inactiveReason = 'capacity'; candidate.inactiveAt = Date.now();
        }
        const next = {
          id, key: previous?.key || update.key, target: update.target, scope: update.scope,
          aliasIds: [...new Set([...(previous?.aliasIds || []), ...(proposedId !== id ? [proposedId] : [])])].slice(-64),
          ...(update.scope === 'board' ? { boardId, boardName: typeof input.boardName === 'string' ? input.boardName.slice(0, 160) : 'Project' } : {}),
          text: update.text.trim(), evidence: update.evidence, sourceMessageId: userMessage.id,
          sourceMessageIds: [...new Set([...(previous?.sourceMessageIds || []), previous?.sourceMessageId, userMessage.id].filter(Boolean))].slice(-32),
          evidenceHistory: [...new Set([...(previous?.evidenceHistory || []), previous?.evidence, update.evidence].filter(Boolean))].slice(-16),
          createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(), pinned: false, deleted: false,
          ...(typeof update.expiresAt === 'string' ? { expiresAt: update.expiresAt } : {}),
        };
        // A corrected stable key supersedes its earlier quoted turns. Keep the
        // displayed conversation, but do not retrieve the outdated preference.
        if (previous && !factHashes(previous).some(hash => hashes.includes(hash))) rememberSuppression(draft, previous);
        draft.entries = draft.entries.map(entry => entry.id === id ? next : entry);
        if (!previous) draft.entries.push(next);
        if (retireExpired(draft)) forgotten = true; compactState(draft);
        if (['soul', 'memory'].some(target => Buffer.byteLength(renderNote(notes[target].content, target, draft.entries)) > NOTE_LIMIT)) { capacitySkipped++; continue; }
        if (Buffer.byteLength(JSON.stringify(draft)) > MAX_LEARNING_BYTES) { capacitySkipped++; continue; }
        Object.assign(state, draft);
        learningChanged = true;
      }
      state.lastTurnIds = [...state.lastTurnIds, userMessage.id].slice(-32);
    }
    for (const target of ['soul', 'memory']) {
      if (stale.has(target) || malformed.has(target)) continue;
      const content = renderNote(notes[target].content, target, state.entries);
      if (content !== notes[target].content && Buffer.byteLength(content) <= NOTE_LIMIT) notes[target] = await saveMuseNoteUnlocked(owner, target, content, notes[target].revision);
    }
    compactState(state);
    value.learning = state;
    const path = identityPath(owner), temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    const summary = input.personalization?.summary;
    const summaryValid = typeof summary === 'string' && summary.length <= 2400 && !summary.includes('\0');
    const revision = personalRevision(state, notes, boardId);
    const updatedConversation = await saveMuseConversationUnlocked(owner, thread, input.messages, {
      summary: ownerEdited || stale.size || forgotten || expiredChanged ? '' : summaryValid ? summary : currentConversation.summaryRevision === revision ? currentConversation.summary || '' : '',
      summaryRevision: revision,
    });
    return { messages: updatedConversation.messages, learningChanged, notes, summary: updatedConversation.summary, revision, learningStats: { active: state.entries.filter(activeEntry).length, pinned: state.entries.filter(entry => entry.pinned).length, retired: state.entries.filter(entry => entry.inactiveReason).length, suppressed: state.entries.filter(entry => entry.deleted).length, skipped: capacitySkipped } };
  });
}

// Read a few relevant archive sections, never every conversation or another owner.
// Results contain complete exchanges and stay chronological, even though retrieval
// ranks the exchanges by relevance first.
export async function readMuseArchive(owner, thread, query = '', limit = 6) {
  validThread(thread);
  const budget = Math.max(0, Math.min(12, Number.isSafeInteger(limit) ? limit : 6));
  if (budget < 2) return [];
  return withMuseOwner(owner, () => readArchiveUnlocked(owner, thread, query, budget));
}
async function readArchiveUnlocked(owner, thread, query, budget) {
  const conversation = await readMuseConversation(owner, thread);
  const { state } = await identity(owner);
  const notes = { soul: await readMuseNote(owner, 'soul'), memory: await readMuseNote(owner, 'memory') };
  reconcile(state, notes); retireExpired(state);
  const terms = retrievalTerms(query);
  if (!terms.size) return [];
  const ranked = conversation.archives.map(chunk => {
    const indexed = new Set(chunk.terms || []);
    let score = retrievalScore((chunk.terms || []).join(' '), terms);
    for (const term of terms) if (!indexed.has(term) && filterHas(chunk.termFilter, term)) score += term.startsWith('@') ? .2 : .5;
    return { ...chunk, score };
  }).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 4);
  const chunks = new Map();
  const readChunk = async index => {
    if (chunks.has(index) || index < 0 || index >= conversation.archiveCount || chunks.size >= 6) return;
    const value = JSON.parse(await readFile(chatArchivePath(owner, thread, index), 'utf8'));
    chunks.set(index, Array.isArray(value) ? value : []);
  };
  for (const descriptor of ranked) await readChunk(descriptor.index);
  // Old versions could split a user/assistant exchange across archive boundaries.
  // Read at most two adjacent chunks to repair those boundaries, not the archive.
  for (const [index, messages] of [...chunks]) {
    if (messages[0]?.role === 'assistant') await readChunk(index - 1);
    if (messages.at(-1)?.role === 'user') await readChunk(index + 1);
  }
  const archivedIds = new Set([...chunks.values()].flat().map(message => message.id));
  const ranges = [];
  let previous = -2;
  for (const [index, messages] of [...chunks].sort((a, b) => a[0] - b[0])) {
    if (index !== previous + 1) ranges.push({ index, messages: [] });
    ranges.at(-1).messages.push(...messages);
    if (index === conversation.archiveCount - 1 && messages.at(-1)?.role === 'user') ranges.at(-1).messages.push(...conversation.messages);
    previous = index;
  }
  const candidates = ranges.flatMap(range => completeExchanges(contextMessages(range.messages, state, thread.split(':')[0]))
    .map((messages, offset) => ({ messages, order: range.index * 128 + offset, text: messages.map(message => message.content).join('\n') }))
    .filter(group => group.messages.some(message => archivedIds.has(message.id))));
  const frequencies = new Map();
  for (const group of candidates) for (const term of retrievalTerms(group.text)) frequencies.set(term, (frequencies.get(term) || 0) + 1);
  const chosen = [];
  let count = 0, characters = 0;
  for (const group of candidates.map(group => ({ ...group, score: retrievalScore(group.text, terms, frequencies, candidates.length) }))
    .filter(group => group.score > 0).sort((a, b) => b.score - a.score || b.order - a.order)) {
    if (count + group.messages.length > budget || characters + group.text.length > 16_000) continue;
    chosen.push(group); count += group.messages.length; characters += group.text.length;
  }
  return chosen.sort((a, b) => a.order - b.order).flatMap(group => group.messages);
}
