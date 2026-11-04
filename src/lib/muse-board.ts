export type MuseActions = {
  layout?: 'organic' | 'aligned';
  focusIds?: string[];
  anchorIds?: string[];
  images?: {id:string;src:string;sourceUrl?:string;sourceTitle:string;retrievedAt:string;imageUrl?:string;attribution?:string}[];
  cards: { id: string; title: string; body: string }[];
  updates: { id: string; text: string; expectedText: string }[];
};
export type MuseApplyResult = { ids: string[]; skipped: number };
export type MuseSceneItem = { id?: string; x: number; y: number; w: number; h: number };
type Bounds = Omit<MuseSceneItem, 'id'>;
type BoardObject = { id: string; type: string; text: string; editable: boolean; bounds?: Bounds; parentId?: string; frameId?: string; startBinding?: string; endBinding?: string };
export type MuseBoard = { board: string; page: string; objects: BoardObject[]; selectedIds?: string[]; selectionIncomplete?: boolean };
const textTypes = new Set(['MuzeText', 'MuzeNote', 'Textbox', 'IText']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const references = ['parentId', 'frameId', 'startBinding', 'endBinding'] as const;
function bounds(value: unknown): Bounds | undefined {
  if (!record(value) || ![value.x, value.y, value.w, value.h].every(bounded) || (value.w as number) < 0 || (value.h as number) < 0) return;
  return { x: value.x as number, y: value.y as number, w: value.w as number, h: value.h as number };
}

export function boardContext(board: string, page: string, objects: Record<string, unknown>[], selectedIds: string[] = [], sceneItems?: MuseSceneItem[]): string {
  const selected = new Set(selectedIds.filter(validId)), found = new Set<string>(), seen = new Set<string>();
  const geometry = new Map((sceneItems || []).filter(item => record(item) && validId(item.id)).map(item => [item.id!, bounds(item)]));
  const candidates: { item: BoardObject; selected: boolean }[] = [], visited = new WeakSet<object>();
  let scanned = 0, incompleteTree = false;
  const visit = (items: unknown[], parentId?: string, inheritedSelection = false, inheritedLock = false, depth = 0) => {
    if (depth > 12) { if (inheritedSelection) incompleteTree = true; return; }
    for (const object of items) {
      if (++scanned > 10_000) { if (selected.size) incompleteTree = true; return; }
      if (!record(object) || visited.has(object)) continue;
      visited.add(object);
      if (!validId(object.id) || seen.has(object.id)) continue;
      seen.add(object.id);
      const directlySelected = selected.has(object.id), focused = directlySelected || inheritedSelection;
      if (directlySelected) found.add(object.id);
      const grouped = object.type === 'Group' && Array.isArray(object.objects) && object.objects.length > 0;
      const text = typeof object.markdown === 'string' ? object.markdown : typeof object.text === 'string' ? object.text : '';
      const item: BoardObject = { id: object.id, type: String(object.type).slice(0, 40), text: text.slice(0, 4000), editable: !parentId && !inheritedLock && !grouped && textTypes.has(String(object.type)) && !object.isLocked && !object.labelFor && text.length <= 4000 };
      if (parentId) item.parentId = parentId;
      for (const key of references.slice(1)) if (validId(object[key])) item[key] = object[key] as string;
      // Fabric supplies world bounds, including group transforms. Legacy callers
      // can supply simple top-level positions without importing the canvas engine.
      const fallback = !parentId && !object.angle && !object.skewX && !object.skewY && !object.flipX && !object.flipY && (object.originX === undefined || object.originX === 'left') && (object.originY === undefined || object.originY === 'top')
        ? bounds({ x: object.left, y: object.top, w: typeof object.width === 'number' ? object.width * (typeof object.scaleX === 'number' ? object.scaleX : 1) : undefined, h: typeof object.height === 'number' ? object.height * (typeof object.scaleY === 'number' ? object.scaleY : 1) : undefined }) : undefined;
      const box = sceneItems ? geometry.get(object.id) : fallback;
      if (box) item.bounds = box;
      candidates.push({ item, selected: focused && !grouped });
      if (grouped) visit(object.objects as unknown[], object.id, focused, inheritedLock || !!object.isLocked, depth + 1);
    }
  };
  visit(objects);
  const focused = candidates.filter(candidate => candidate.selected), others = candidates.filter(candidate => !candidate.selected);
  const context: MuseBoard = { board: board.slice(0, 160), page: page.slice(0, 160), selectedIds: [], objects: [] };
  let incomplete = incompleteTree || found.size !== selected.size || selected.size !== selectedIds.length;
  let size = JSON.stringify(context).length;
  for (const candidate of [...focused, ...others]) {
    if (context.objects.length >= 150) { if (candidate.selected) incomplete = true; continue; }
    const added = JSON.stringify(candidate.item).length + (context.objects.length ? 1 : 0) + (candidate.selected ? JSON.stringify(candidate.item.id).length + (context.selectedIds!.length ? 1 : 0) : 0);
    if (size + added > 34_950) { if (candidate.selected) incomplete = true; continue; }
    context.objects.push(candidate.item); size += added;
    if (candidate.selected) context.selectedIds!.push(candidate.item.id);
  }
  if (selected.size && !focused.length) incomplete = true;
  const included = new Set(context.objects.map(item => item.id));
  for (const item of context.objects) for (const key of references) if (item[key] && (!included.has(item[key]!) || item[key] === item.id)) delete item[key];
  if (incomplete) context.selectionIncomplete = true;
  return JSON.stringify(context);
}

export function parseBoardContext(value: unknown): MuseBoard {
  if (typeof value !== 'string' || value.length > 40_000) throw new Error('This board is too large to send.');
  let board: unknown;
  try { board = JSON.parse(value); } catch { throw new Error('This board could not be read.'); }
  if (!record(board) || typeof board.board !== 'string' || board.board.length > 160 || typeof board.page !== 'string' || board.page.length > 160 || !Array.isArray(board.objects) || board.objects.length > 150) throw new Error('This board could not be read.');
  if (board.selectionIncomplete === true) throw new Error('Select fewer notes or select them again, then retry.');
  if (board.selectionIncomplete !== undefined && board.selectionIncomplete !== false) throw new Error('This selection could not be read.');
  const ids = new Set<string>();
  const objects: BoardObject[] = [];
  for (const object of board.objects) {
    if (!record(object) || !validId(object.id) || ids.has(object.id) || typeof object.type !== 'string' || object.type.length > 40 || typeof object.text !== 'string' || object.text.length > 4000 || typeof object.editable !== 'boolean') throw new Error('This board could not be read.');
    ids.add(object.id);
    const item: BoardObject = { id: object.id, type: object.type, text: object.text, editable: object.editable && textTypes.has(object.type) && object.parentId === undefined };
    if (object.bounds !== undefined) {
      const box = bounds(object.bounds);
      if (!box) throw new Error('This board position could not be read.');
      item.bounds = box;
    }
    for (const key of references) if (object[key] !== undefined) {
      if (!validId(object[key])) throw new Error('This board relationship could not be read.');
      item[key] = object[key] as string;
    }
    objects.push(item);
  }
  for (const item of objects) for (const key of references) if (item[key] && (!ids.has(item[key]!) || item[key] === item.id)) delete item[key];
  const selectedIds = board.selectedIds === undefined ? [] : board.selectedIds;
  if (!Array.isArray(selectedIds) || selectedIds.length > 150 || selectedIds.some(id => !validId(id) || !ids.has(id)) || new Set(selectedIds).size !== selectedIds.length) throw new Error('This selection could not be read. Select the notes again.');
  return { board: board.board, page: board.page, objects, selectedIds };
}

export const museResponseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'A short response to the person, without repeating the full cards.' },
    cards: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, body: { type: 'string', description: 'Plain text with short lines or bullets. No markdown headings or tables. At most 900 characters.' } }, required: ['title', 'body'] } },
    updates: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string', description: 'Complete replacement text, including the title when present.' } }, required: ['id', 'text'] } },
    suggestions: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 100 }, description: 'Zero to two short, complete follow-up requests the person could send. Use an empty array when no useful next move is needed.' },
  }, required: ['reply', 'cards', 'updates', 'suggestions'],
};

export function parseMuseResponse(value: unknown, board: MuseBoard, turnId: string): { reply: string; actions: MuseActions; suggestions: string[] } {
  const invalid = () => new Error('Muse returned an incomplete response. Try again.');
  if (!record(value) || typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 8000 || !Array.isArray(value.cards) || value.cards.length > 6 || !Array.isArray(value.updates) || value.updates.length > 12) throw invalid();
  const cards = value.cards.map((card, index) => {
    if (!record(card) || typeof card.title !== 'string' || !card.title.trim() || card.title.length > 100 || typeof card.body !== 'string' || !card.body.trim() || card.body.length > 900) throw invalid();
    return { id: `muse-${turnId}-${index}`, title: card.title.trim(), body: card.body.trim() };
  });
  const ids = new Set<string>();
  const focused = new Set(board.selectedIds || []);
  const updates = value.updates.map(update => {
    if (!record(update) || typeof update.id !== 'string' || ids.has(update.id) || typeof update.text !== 'string' || !update.text.trim() || update.text.length > 2000) throw invalid();
    const original = board.objects.find(object => object.id === update.id && object.editable && textTypes.has(object.type));
    if (!original || focused.size && !focused.has(update.id)) throw invalid();
    ids.add(update.id);
    return { id: update.id, text: update.text.trim(), expectedText: original.text };
  });
  const suggestions = value.suggestions === undefined ? [] : value.suggestions;
  if (!Array.isArray(suggestions) || suggestions.length > 2 || suggestions.some(suggestion => typeof suggestion !== 'string' || !suggestion.trim() || suggestion.length > 100 || /[\r\n]/.test(suggestion))) throw invalid();
  return { reply: value.reply.trim(), actions: { cards, updates, ...(focused.size ? { focusIds: [...focused] } : {}) }, suggestions: [...new Set(suggestions.map((suggestion: string) => suggestion.trim()))] };
}
