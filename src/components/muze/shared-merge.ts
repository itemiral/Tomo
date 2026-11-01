import type { Board } from './storage';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identified = (items: unknown[]): items is (Record<string, unknown> & {id: string})[] => items.every(item => record(item) && typeof item.id === 'string');
export class BoardConflict extends Error {
  constructor() { super('Someone else changed the same part of this board. Your draft is kept. Save a copy before reloading the shared version.'); }
}

function merge(base: unknown, local: unknown, remote: unknown): unknown {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote) && identified(base) && identified(local) && identified(remote)) {
    const previous = new Map(base.map(item => [item.id, item])), ours = new Map(local.map(item => [item.id, item])), theirs = new Map(remote.map(item => [item.id, item]));
    const baseOrder = base.filter(item => ours.has(item.id)).map(item => item.id);
    const localOrder = local.filter(item => previous.has(item.id)).map(item => item.id);
    const ordered = equal(baseOrder, localOrder) ? [...remote, ...local] : [...local, ...remote];
    const ids = [...new Set(ordered.map(item => item.id))];
    return ids.map(id => merge(previous.get(id), ours.get(id), theirs.get(id))).filter(item => item !== undefined);
  }
  if (record(base) && record(local) && record(remote)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = merge(base[key], local[key], remote[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw new BoardConflict();
}

// Navigation belongs to each browser, even when the drawing is shared.
export function sceneContent(board: Board) {
  const { activePage: _activePage, ...value } = board;
  return {...value, pages: board.pages.map(({viewport: _viewport, ...page}) => page)};
}
export const sameScene = (a: Board, b: Board) => equal(sceneContent(a), sceneContent(b));
export function mergeSharedBoard(base: Board, local: Board, remote: Board): Board {
  const result = merge(sceneContent(base), sceneContent(local), sceneContent(remote)) as Board;
  if (!result.pages.length) throw new BoardConflict();
  result.pages = result.pages.map(page => ({...page, viewport: local.pages.find(p => p.id === page.id)?.viewport || remote.pages.find(p => p.id === page.id)?.viewport || [1,0,0,1,0,0]}));
  result.activePage = result.pages.some(page => page.id === local.activePage) ? local.activePage : result.pages[0].id;
  return result;
}
