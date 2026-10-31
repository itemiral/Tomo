import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, privateDirectory } from './muse-local.mjs';

export const NOTE_LIMIT = 512_000;
const templates = {
  soul: '# Soul\n\n## Who I am\nI’m Muse, your companion inside Muze. I help turn rough ideas into clear plans on a shared whiteboard.\n\n## How I work\n- Start with the goal, then break it into useful steps.\n- Keep related ideas together and the board easy to read.\n- Offer a clear next step when a plan feels stuck.\n- Ask when a preference or constraint is missing.\n\n## My voice\nCalm, curious, and direct. Use plain language and keep explanations concise.\n\n## Make me yours\nEdit this note to choose my role, working style, and the way I communicate.\n',
  memory: '# Memory\n\n## About you\nAdd the context you want Muse to remember about you.\n\n## Preferences\n- How I like to plan:\n- How much detail I prefer:\n- Things to keep in mind:\n\n## Current focus\nAdd what you’re working on and what a good result looks like.\n\n## Decisions worth keeping\nRecord choices, useful discoveries, and things to revisit.\n',
};

export class MuseStoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const museDirectory = ownerId => join(privateDirectory, 'muses', digest(ownerId));
const queues = new Map();
async function serial(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = previous.then(() => gate);
  queues.set(key, pending);
  await previous;
  try { return await operation(); }
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
    return { id: identity.id, name: 'Muse' };
  });
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
export async function saveMuseNote(ownerId, key, content, revision) {
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
export async function readMuseChat(ownerId, thread) {
  await ensureMuse(ownerId);
  try { return JSON.parse(await readFile(threadPath(ownerId, thread), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}
export async function saveMuseChat(ownerId, thread, messages) {
  await ensureMuse(ownerId);
  await replaceFile(threadPath(ownerId, thread), JSON.stringify(messages.slice(-32)));
}
