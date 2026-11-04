import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile, withStorageTransaction } from './muse-storage.mjs';
import { join } from 'node:path';
import { digest, privateDirectory } from './muse-local.mjs';
import { MUSE_NOTE_TEMPLATES, cleanMuseNoteDefaults } from './muse-defaults.mjs';
import { retrievalTerms, filterAdd } from './muse-retrieval.mjs';

export const NOTE_LIMIT = 512_000;
const templates = MUSE_NOTE_TEMPLATES;

export class MuseStoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const museDirectory = ownerId => join(privateDirectory, 'muses', digest(ownerId));
const queues = new Map();
async function serial(key, operation, retries = 0) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = previous.then(() => gate);
  queues.set(key, pending);
  await previous;
  try { return await withStorageTransaction(operation, retries); }
  finally { release(); if (queues.get(key) === pending) queues.delete(key); }
}
async function createFile(path, content) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
async function replaceFile(path, content) {
  const temporary = path + '.' + randomUUID();
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
export async function ensureMuse(ownerId) {
  const directory = museDirectory(ownerId);
  return serial(directory, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    await createFile(join(directory, 'identity.json'), JSON.stringify({ id: randomUUID(), ownerId }));
    const identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'));
    if (identity.ownerId !== ownerId || typeof identity.id !== 'string') throw new MuseStoreError(403, 'This Muse belongs to another owner.');
    for (const key of ['soul', 'memory']) await createFile(join(directory, key + '.md'), templates[key]);
    let name='Muse';try {const board=JSON.parse(await readFile(join(directory,'canvas.json'),'utf8'));if(typeof board.museName==='string')name=board.museName;}catch(e){if(e.code!=='ENOENT')throw e;}
    for (const key of ['soul', 'memory']) {
      const path = join(directory, key + '.md'), content = await readFile(path, 'utf8');
      const cleaned = cleanMuseNoteDefaults(content, key, name);
      if (cleaned !== content) await replaceFile(path, cleaned);
    }
    return { id: identity.id, name };
  }, 2);
}
export function validNoteKey(key) {
  if (key !== 'soul' && key !== 'memory') throw new MuseStoreError(404, 'That note does not exist.');
  return key;
}
export async function readMuseNote(ownerId, key) {
  validNoteKey(key); await ensureMuse(ownerId);
  const path = join(museDirectory(ownerId), key + '.md');
  const info = await stat(path);
  if (!info.isFile() || info.size > NOTE_LIMIT) throw new MuseStoreError(413, 'This note is too large to open.');
  const content = await readFile(path, 'utf8');
  return { key, content, revision: digest(content), updatedAt: info.mtimeMs };
}
export const withMuseOwner = (ownerId, operation) => serial('owner:' + ownerId, operation);
export async function saveMuseNote(ownerId, key, content, revision) {
  return withMuseOwner(ownerId, () => saveMuseNoteUnlocked(ownerId, key, content, revision));
}
export async function saveMuseNoteUnlocked(ownerId, key, content, revision) {
  validNoteKey(key); await ensureMuse(ownerId);
  if (typeof content !== 'string' || Buffer.byteLength(content) > NOTE_LIMIT || content.includes('\0')) throw new MuseStoreError(400, 'Keep this note under 500 KB of text.');
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new MuseStoreError(400, 'Reload this note before saving.');
  const path = join(museDirectory(ownerId), key + '.md');
  return serial(path, async () => {
    const current = await readFile(path, 'utf8');
    if (digest(current) !== revision) throw new MuseStoreError(409, 'This note changed elsewhere. Cancel to reload it.');
    await replaceFile(path, content);
    return readMuseNote(ownerId, key);
  });
}
export async function readMuseIcon(ownerId) {
  await ensureMuse(ownerId);
  try {
    const bytes = await readFile(join(museDirectory(ownerId), 'icon.png'));
    return { bytes, version: digest(bytes) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
export async function saveMuseIcon(ownerId, image) {
  await ensureMuse(ownerId);
  if (typeof image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length > 1_400_000) throw new MuseStoreError(400, 'Choose a PNG, JPEG, WebP, or GIF image.');
  const bytes = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 33 || bytes.length > 1_000_000 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 512 || bytes.readUInt32BE(20) > 512) throw new MuseStoreError(400, 'That image could not be read. Choose another icon.');
  await replaceFile(join(museDirectory(ownerId), 'icon.png'), bytes);
  return digest(bytes);
}

export function validThread(thread) {
  if (typeof thread !== 'string' || !/^[A-Za-z0-9_-]{1,80}:[A-Za-z0-9_-]{1,80}$/.test(thread)) throw new MuseStoreError(400, 'Open a board before talking to Muse.');
  return thread;
}
const threadPath = (ownerId, thread) => join(museDirectory(ownerId), 'chat-' + digest(validThread(thread)) + '.json');
export const chatArchivePath = (ownerId, thread, index) => {
  if (!Number.isSafeInteger(index) || index < 0) throw new MuseStoreError(400, 'That conversation section does not exist.');
  return join(museDirectory(ownerId), 'chat-' + digest('archive:' + validThread(thread) + ':' + index) + '.json');
};
export async function readMuseConversation(ownerId, thread) {
  await ensureMuse(ownerId);
  let value;
  try { value = JSON.parse(await readFile(threadPath(ownerId, thread), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Array.isArray(value)) return { version: 2, messages: value, archives: [], archiveCount: 0, summary: '' };
  if (!value) return { version: 2, messages: [], archives: [], archiveCount: 0, summary: '' };
  if (value.version !== 2 || !Array.isArray(value.messages) || !Array.isArray(value.archives)) throw new MuseStoreError(500, 'This conversation could not be read.');
  return value;
}
export async function readMuseChat(ownerId, thread) {
  return (await readMuseConversation(ownerId, thread)).messages;
}
export async function saveMuseChat(ownerId, thread, messages) {
  return withMuseOwner(ownerId, () => saveMuseConversationUnlocked(ownerId, thread, messages));
}
const archiveIndex = messages => {
  const counts = new Map();
  for (const message of messages) for (const term of retrievalTerms(message.content)) counts.set(term, (counts.get(term) || 0) + 1);
  return { terms: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([term]) => term), termFilter: filterAdd(null, counts.keys()), termsVersion: 2 };
};
// Call under the owner transaction when committing a turn and its private notes.
export async function saveMuseConversationUnlocked(ownerId, thread, messages, extra = {}) {
  await ensureMuse(ownerId);
  const current = await readMuseConversation(ownerId, thread);
  const seen = new Set();
  const previousIds = new Set(current.recentMessageIds || current.messages.map(message => message.id));
  const additions = messages.filter(message => !previousIds.has(message?.id));
  const combined = [...current.messages, ...additions].filter(message => {
    if (!message || typeof message.id !== 'string' || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || seen.has(message.id)) return false;
    seen.add(message.id); return true;
  });
  let split = Math.max(0, combined.length - 32);
  // Keep a user request with its response at the recent/archive boundary.
  while (split > 0 && combined[split]?.role === 'assistant') split--;
  const overflow = combined.slice(0, split);
  const archives = [...current.archives];
  let archiveCount = current.archiveCount || 0;
  while (overflow.length) {
    let index = Math.max(0, archiveCount - 1), chunk = [];
    if (archiveCount) {
      try { chunk = JSON.parse(await readFile(chatArchivePath(ownerId, thread, index), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (chunk.length >= 128) { index = archiveCount; chunk = []; }
    let count = Math.min(overflow.length, 128 - chunk.length);
    while (count > 0 && overflow[count]?.role === 'assistant') count--;
    if (!count) { index = archiveCount; chunk = []; count = Math.min(128, overflow.length); while (count > 0 && overflow[count]?.role === 'assistant') count--; }
    // Legacy imports can contain unusually long runs; preserve their bytes.
    if (!count) count = Math.min(128, overflow.length);
    chunk.push(...overflow.splice(0, count));
    await replaceFile(chatArchivePath(ownerId, thread, index), JSON.stringify(chunk));
    archiveCount = Math.max(archiveCount, index + 1);
    const descriptor = { index, count: chunk.length, ...archiveIndex(chunk) };
    const previous = archives.findIndex(item => item.index === index);
    if (previous === -1) archives.push(descriptor); else archives[previous] = descriptor;
  }
  const recentMessageIds = [...new Set([...previousIds, ...combined.map(message => message.id)])].slice(-512);
  const result = { ...current, ...extra, version: 2, messages: combined.slice(split), recentMessageIds, archiveCount, archives: archives.slice(-256) };
  await replaceFile(threadPath(ownerId, thread), JSON.stringify(result));
  return result;
}

export async function readMuseBoard(ownerId) {
  await ensureMuse(ownerId);
  let content;
  try { content = await readFile(join(museDirectory(ownerId), 'board.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; content = JSON.stringify({ cards: [], comments: [] }); }
  return { ...JSON.parse(content), revision: digest(content) };
}
export async function saveMuseBoard(ownerId, body) {
  await ensureMuse(ownerId);
  if (!Array.isArray(body.cards) || !Array.isArray(body.comments) || body.cards.length > 100 || body.comments.length > 100) throw new MuseStoreError(400, 'Keep this board under 100 cards and 100 comments.');
  const cards = body.cards.map(card => {
    if (!card || typeof card.id !== 'string' || typeof card.text !== 'string' || card.text.length > 8000 || !['text','markdown'].includes(card.kind)) throw new MuseStoreError(400, 'Add text or Markdown cards. Describe images and other media in text first.');
    return { id: card.id.slice(0,80), text: card.text, kind: card.kind };
  });
  const comments = body.comments.map(comment => {
    if (!comment || typeof comment.id !== 'string' || typeof comment.text !== 'string' || comment.text.length > 4000) throw new MuseStoreError(400, 'Keep comments under 4,000 characters.');
    return { id: comment.id.slice(0,80), text: comment.text, author: 'You' };
  });
  const content = JSON.stringify({ cards, comments });
  if (Buffer.byteLength(content) > 64000) throw new MuseStoreError(413, 'This Muse board is full. Shorten some cards before saving.');
  return serial(join(museDirectory(ownerId), 'board.json'), async () => {
    const current = await readMuseBoard(ownerId);
    if (current.revision !== body.revision) throw new MuseStoreError(409, 'This board changed elsewhere. Reload before saving; your draft is still here.');
    await replaceFile(join(museDirectory(ownerId), 'board.json'), content);
    return readMuseBoard(ownerId);
  });
}
export function museBoardContext(board) {
  return [...board.cards.map(card => `[${card.kind} card] ${card.text}`), ...board.comments.map(comment => `[Comment] ${comment.text}`)].join('\n\n');
}
