import { parseBoardFile, type Board } from '@/components/muze/storage';
import { PrivateError } from '@/server/muse/error';

export const BOARD_BODY_LIMIT = 3_000_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function boardId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new PrivateError(400, 'This board link is invalid.');
  return value;
}
export function boardRevision(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new PrivateError(400, 'Reload this board before saving.');
  return value;
}
export function inviteToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new PrivateError(400, 'This invitation is invalid.');
  return value;
}
const privateIds = new Set(['muse-private', 'muse-file-soul', 'muse-file-memory', 'muse-appearance', 'muse-name']);
function containsPrivate(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    const object = current as Record<string, unknown>;
    if (privateIds.has(String(object.id))) return true;
    for (const child of Object.values(object)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}

export function sharedBoard(value: unknown, id?: string): Board {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > BOARD_BODY_LIMIT - 512) throw new PrivateError(413, 'This board is too large to share. Use smaller images.');
  if (containsPrivate(value)) throw new PrivateError(400, 'Your Muse notebook stays private. Share a regular board.');
  try {
    const board = parseBoardFile(JSON.stringify({ format: 'muze', version: 1, board: value }));
    if (!board.name.trim()) throw new Error('Missing name');
    for (const page of board.pages) {
      if (!page.id || page.id.length > 160) throw new Error('Invalid page ID');
      const ids = new Set<string>();
      const walk = (objects: Record<string, unknown>[], nested = false) => {
        for (const object of objects) {
          if (object.id !== undefined || !nested) {
            if (typeof object.id !== 'string' || !object.id || object.id.length > 160 || ids.has(object.id)) throw new Error('Invalid object ID');
            ids.add(object.id);
          }
          if (Array.isArray(object.objects)) walk(object.objects, true);
        }
      };
      walk(page.objects);
    }
    const commentIds = new Set<string>();
    for (const comment of board.comments || []) {
      if (!comment.id || comment.id.length > 160 || commentIds.has(comment.id)) throw new Error('Invalid comment ID');
      commentIds.add(comment.id);
    }
    return { id: id || board.id, name: board.name.trim(), activePage: board.activePage,
      pages: board.pages.map(page => ({ id: page.id, name: page.name.slice(0, 160), objects: page.objects, viewport: page.viewport })),
      ...(board.comments ? { comments: board.comments } : {}) };
  } catch { throw new PrivateError(400, 'This board contains invalid drawing data.'); }
}


// Optional source links must not make an otherwise valid saved drawing unreadable.
// Writes still use sharedBoard directly; this repair never changes stored data.
export function readSharedBoard(value: unknown, id?: string): Board {
  const board = structuredClone(value);
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const clean = (objects: unknown, depth = 0) => {
    if (!Array.isArray(objects) || depth > 12) return;
    for (const item of objects) {
      if (!object(item)) continue;
      for (const field of ['sourceUrl', 'imageUrl']) if (item[field] !== undefined) {
        try {
          const reference = item[field];
          if (typeof reference !== 'string' || reference.length > 2048) throw new Error('Invalid reference');
          const url = new URL(reference);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid reference');
        } catch { delete item[field]; }
      }
      clean(item.objects, depth + 1);
    }
  };
  if (object(board) && Array.isArray(board.pages)) for (const page of board.pages) if (object(page)) clean(page.objects);
  return sharedBoard(board, id);
}
