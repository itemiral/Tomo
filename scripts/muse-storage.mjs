import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as disk from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, privateDirectory } from './muse-local.mjs';

const requests = new AsyncLocalStorage();
const transactions = new AsyncLocalStorage();
const leases = new AsyncLocalStorage();
const filename = /^(?:identity\.json|soul\.md|memory\.md|canvas\.json|board\.json|icon\.png|avatar(?:-previous|-operations)?\.json|(?:search|image)-usage\.json|(?:chat|task)-[a-f0-9]{64}\.json)$/;
const profileFiles = ['identity.json', 'soul.md', 'memory.md', 'canvas.json', 'avatar.json', 'icon.png'];

export class StorageError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function usesCloudStorage() {
  if (process.env.VERCEL && process.env.MUZE_STORAGE === 'local') throw new StorageError(503, 'Persistent storage is required for this workspace.');
  const mode = process.env.MUZE_STORAGE || (process.env.VERCEL ? 'supabase' : 'local');
  if (!['local', 'supabase'].includes(mode)) throw new StorageError(503, 'Workspace storage is not configured.');
  return mode === 'supabase';
}

export function withMuseStorage(ownerId, client, operation) {
  if (!ownerId || !client) throw new StorageError(401, 'Sign in to open your Muse.');
  return requests.run({ ownerId, client, temporary: new Map() }, () =>
    transactions.run(undefined, () => leases.run([], operation)));
}

function context() {
  const current = requests.getStore();
  if (!current && usesCloudStorage()) throw new StorageError(401, 'Sign in to open your Muse.');
  return current;
}

function fileName(path, current, allowDirectory = false) {
  const root = join(privateDirectory, 'muses', digest(current.ownerId));
  const name = relative(root, String(path));
  if (allowDirectory && name === '') return '';
  const base = name.replace(/\.[a-f0-9-]{36}$/, '');
  if (!filename.test(base)) throw new StorageError(403, 'This Muse belongs to another owner.');
  return name;
}

function databaseError(error, operation) {
  if (['PT409', '40001'].includes(error.code)) return new StorageError(409, 'This notebook changed elsewhere. Reload before saving.', error.code);
  if (error.status === 401 || error.name === 'SupabaseSessionError' || error.message?.startsWith('SupabaseSessionError:') || error.code === '42501' || error.code === 'PGRST301' || error.code === 'PGRST303') return new StorageError(401, 'Sign in again to open your Muse.', error.code);
  // Database details can contain document data. Log only fixed operation names and error codes.
  console.error('Muse storage request failed', { operation, code: /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(error.code || '') ? error.code : 'transport' });
  return new StorageError(503, 'Muse storage is unavailable. Try again.', error.code);
}

async function row(name, current) {
  const transaction = transactions.getStore();
  if (transaction?.rows.has(name)) return transaction.rows.get(name);
  const { data, error } = await current.client.from('muse_private_files')
    .select('name,content,version,updated_at').eq('owner_id', current.ownerId).eq('name', name).maybeSingle();
  if (error) throw databaseError(error, 'read_file');
  const value = data || { name, content: null, version: null, updated_at: null };
  transaction?.rows.set(name, value);
  return value;
}

async function commit(current, transaction) {
  if (!transaction.writes.size) return;
  const changes = [...transaction.rows.values()].map(value => ({
    name: value.name, expected_version: value.version,
    ...(transaction.writes.has(value.name) ? { content: transaction.writes.get(value.name) } : {}),
  }));
  const arguments_ = {
    changes, held_leases: leases.getStore() || [],
  };
  for (let attempt = 0; ; attempt++) {
    const { error } = await current.client.rpc('commit_muse_files', arguments_);
    if (!error) return;
    if (error.code !== '57014' || attempt > 0) throw databaseError(error, 'commit_files');
    // A statement timeout rolls the database transaction back. Retry the same fenced
    // write once; never rerun the operation that may already have generated an image.
    console.warn('Muse storage commit retry', { code: '57014' });
    await delay(150);
  }
}

export async function withStorageTransaction(operation, retries = 0) {
  const current = context();
  if (!current || transactions.getStore()) return operation();
  for (let attempt = 0; ; attempt++) {
    const transaction = { rows: new Map(), writes: new Map() };
    try {
      return await transactions.run(transaction, async () => {
        const result = await operation();
        await commit(current, transaction);
        return result;
      });
    } catch (error) {
      if (!['PT409', '40001'].includes(error.code) || attempt >= retries) throw error;
    }
  }
}

// Short profile reads share one owner-scoped snapshot. The snapshot ends with
// this operation; generation and later requests must read fresh file versions.
export async function withMuseProfileSnapshot(operation) {
  const current = context();
  if (!current) return operation();
  return withStorageTransaction(async () => {
    const transaction = transactions.getStore();
    const names = profileFiles.filter(name => !transaction.rows.has(name));
    if (names.length) {
      const { data, error } = await current.client.from('muse_private_files')
        .select('name,content,version,updated_at').eq('owner_id', current.ownerId).in('name', names);
      if (error) throw databaseError(error, 'read_profile');
      const rows = new Map((data || []).map(value => [value.name, value]));
      for (const name of names) transaction.rows.set(name, rows.get(name) || { name, content: null, version: null, updated_at: null });
    }
    return operation();
  }, 2);
}

export async function hasMuseLease(ownerId, resource, token) {
  const current = context();
  if (!current) return true;
  if (current.ownerId !== ownerId) throw new StorageError(403, 'This Muse belongs to another owner.');
  const { data, error } = await current.client.from('muse_private_leases').select('token,expires_at')
    .eq('owner_id', ownerId).eq('resource', resource).maybeSingle();
  if (error) throw databaseError(error, 'read_lease');
  return data?.token === token && Date.parse(data.expires_at) > Date.now();
}

export async function cancelMuseLease(ownerId, resource, token) {
  const current = context();
  if (!current) return;
  if (current.ownerId !== ownerId) throw new StorageError(403, 'This Muse belongs to another owner.');
  const { error } = await current.client.rpc('release_muse_lease', { resource, lease_token: token });
  if (error) throw databaseError(error, 'release_lease');
  // An empty commit takes the same owner lock as notebook writes. Wait for any
  // commit already past its lease check before acknowledging cancellation.
  const { error: fenceError } = await current.client.rpc('commit_muse_files', {changes: [], held_leases: []});
  if (fenceError) throw databaseError(fenceError, 'cancel_fence');
}

/** A supplied request token lets another worker cancel only this operation.
 * @param {{token?: string, signal?: AbortSignal}} [options]
 */
export async function withMuseLease(ownerId, resource, operation, options = {}) {
  const { token = randomUUID(), signal } = options;
  const current = context();
  if (!current) return operation(signal);
  if (current.ownerId !== ownerId) throw new StorageError(403, 'This Muse belongs to another owner.');
  signal?.throwIfAborted();
  const { data, error } = await current.client.rpc('acquire_muse_lease', { resource, lease_token: token });
  if (error) throw databaseError(error, 'acquire_lease');
  if (!data) throw new StorageError(409, 'Muse is still working. Try again in a moment.');
  const cancelled = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, cancelled.signal]) : undefined;
  let monitoring = false, finished = false;
  const timer = signal ? setInterval(async () => {
    if (monitoring || finished || activeSignal.aborted) return;
    monitoring = true;
    try {
      if (!await hasMuseLease(ownerId, resource, token)) cancelled.abort(new DOMException('Request cancelled.', 'AbortError'));
    } catch { /* A temporary read failure does not cancel work; commits remain lease-fenced. */ }
    finally { monitoring = false; }
  }, 1000) : undefined;
  timer?.unref?.();
  try {
    activeSignal?.throwIfAborted();
    return await leases.run([...(leases.getStore() || []), { resource, token }], () => operation(activeSignal));
  } finally {
    finished = true; clearInterval(timer);
    // An interrupted request leaves a bounded lease; it never unlocks a newer worker.
    await Promise.resolve(current.client.rpc('release_muse_lease', { resource, lease_token: token })).catch(() => {});
  }
}

export async function readFile(path, encoding) {
  // Packaged images remain ordinary, read-only application assets.
  if (path instanceof URL) return disk.readFile(path, encoding);
  const current = context();
  if (!current) return disk.readFile(path, encoding);
  const name = fileName(path, current);
  let content = current.temporary.get(name);
  if (content === undefined) {
    const transaction = transactions.getStore();
    content = transaction?.writes.has(name) ? transaction.writes.get(name) : (await row(name, current)).content;
  }
  if (content == null) throw new StorageError(404, 'File not found.', 'ENOENT');
  const bytes = Buffer.from(content, 'base64');
  return encoding ? bytes.toString(typeof encoding === 'string' ? encoding : encoding.encoding) : bytes;
}

export async function writeFile(path, content, options = {}) {
  const current = context();
  if (!current) return disk.writeFile(path, content, options);
  const name = fileName(path, current);
  const encoded = Buffer.from(content).toString('base64');
  if (!filename.test(name)) {
    if (current.temporary.has(name) && options.flag === 'wx') throw new StorageError(409, 'File exists.', 'EEXIST');
    current.temporary.set(name, encoded);
    return;
  }
  return withStorageTransaction(async () => {
    const previous = await row(name, current);
    const transaction = transactions.getStore();
    if (options.flag === 'wx' && (previous.version || transaction.writes.has(name))) throw new StorageError(409, 'File exists.', 'EEXIST');
    transaction.writes.set(name, encoded);
  });
}

export async function rename(source, destination) {
  const current = context();
  if (!current) return disk.rename(source, destination);
  const name = fileName(source, current);
  const content = current.temporary.get(name);
  if (content === undefined) throw new StorageError(404, 'File not found.', 'ENOENT');
  await writeFile(destination, Buffer.from(content, 'base64'));
  current.temporary.delete(name);
}

export async function stat(path) {
  const current = context();
  if (!current) return disk.stat(path);
  const name = fileName(path, current), value = await row(name, current);
  const content = transactions.getStore()?.writes.get(name) ?? value.content;
  if (content == null) throw new StorageError(404, 'File not found.', 'ENOENT');
  return { isFile: () => true, size: Buffer.byteLength(content, 'base64'), mtimeMs: transactions.getStore()?.writes.has(name) ? Date.now() : value.updated_at ? Date.parse(value.updated_at) : Date.now() };
}

export async function mkdir(path, options) {
  const current = context();
  if (!current) return disk.mkdir(path, options);
  fileName(path, current, true);
}

export async function chmod(path, mode) {
  const current = context();
  if (!current) return disk.chmod(path, mode);
  fileName(path, current, true);
}

export async function migrateLocalMuse(ownerId, client) {
  if (process.env.VERCEL) throw new StorageError(403, 'Run this migration on the computer with your Muse files.');
  const directory = join(privateDirectory, 'muses', digest(ownerId));
  let files;
  try { files = (await disk.readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && filename.test(file.name)); }
  catch (error) { if (error.code === 'ENOENT') return { migrated: 0 }; throw error; }
  if (!files.some(file => file.name === 'identity.json')) return { migrated: 0 };
  const identity = JSON.parse(await disk.readFile(join(directory, 'identity.json'), 'utf8'));
  if (identity.ownerId !== ownerId) throw new StorageError(403, 'This Muse belongs to another owner.');
  if (files.length > 256) throw new StorageError(413, 'This Muse needs a larger migration batch.');
  return withMuseStorage(ownerId, client, () => withStorageTransaction(async () => {
    for (const file of files) {
      const current = await row(file.name, context());
      if (current.version) throw new StorageError(409, 'A cloud Muse already exists. Your local files have not been changed.');
      await writeFile(join(directory, file.name), await disk.readFile(join(directory, file.name)), { flag: 'wx' });
    }
    return { migrated: files.length };
  }));
}
