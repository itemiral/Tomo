export type MuseActions = {
  layout?: 'organic' | 'aligned';
  cards: { id: string; title: string; body: string }[];
  updates: { id: string; text: string; expectedText: string }[];
};
export type MuseApplyResult = { ids: string[]; skipped: number };
type BoardObject = { id: string; type: string; text: string; editable: boolean };
export type MuseBoard = { board: string; page: string; objects: BoardObject[] };
const textTypes = new Set(['MuzeText', 'MuzeNote', 'Textbox', 'IText']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function boardContext(board: string, page: string, objects: Record<string, unknown>[]): string {
  const context: MuseBoard = { board: board.slice(0, 160), page: page.slice(0, 160), objects: [] };
  for (const object of objects.slice(0, 150)) {
    if (typeof object.id !== 'string') continue;
    const text = typeof object.markdown === 'string' ? object.markdown : typeof object.text === 'string' ? object.text : '';
    const item = { id: object.id.slice(0, 100), type: String(object.type).slice(0, 40), text: text.slice(0, 4000), editable: textTypes.has(String(object.type)) && !object.isLocked && !object.labelFor && text.length <= 4000 };
    context.objects.push(item);
    if (JSON.stringify(context).length > 35_000) { context.objects.pop(); break; }
  }
  return JSON.stringify(context);
}

export function parseBoardContext(value: unknown): MuseBoard {
  if (typeof value !== 'string' || value.length > 40_000) throw new Error('This board is too large to send.');
  let board: unknown;
  try { board = JSON.parse(value); } catch { throw new Error('This board could not be read.'); }
  if (!record(board) || typeof board.board !== 'string' || typeof board.page !== 'string' || !Array.isArray(board.objects) || board.objects.length > 150) throw new Error('This board could not be read.');
  const ids = new Set<string>();
  for (const object of board.objects) {
    if (!record(object) || typeof object.id !== 'string' || object.id.length > 100 || ids.has(object.id) || typeof object.type !== 'string' || typeof object.text !== 'string' || object.text.length > 4000 || typeof object.editable !== 'boolean') throw new Error('This board could not be read.');
    ids.add(object.id);
  }
  return board as MuseBoard;
}

export const museResponseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'A short response to the person, without repeating the full cards.' },
    cards: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, body: { type: 'string', description: 'Plain text with short lines or bullets. No markdown headings or tables. At most 900 characters.' } }, required: ['title', 'body'] } },
    updates: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string', description: 'Complete replacement text, including the title when present.' } }, required: ['id', 'text'] } },
  }, required: ['reply', 'cards', 'updates'],
};

export function parseMuseResponse(value: unknown, board: MuseBoard, turnId: string): { reply: string; actions: MuseActions } {
  const invalid = () => new Error('Muse returned an incomplete response. Try again.');
  if (!record(value) || typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 8000 || !Array.isArray(value.cards) || value.cards.length > 6 || !Array.isArray(value.updates) || value.updates.length > 12) throw invalid();
  const cards = value.cards.map((card, index) => {
    if (!record(card) || typeof card.title !== 'string' || !card.title.trim() || card.title.length > 100 || typeof card.body !== 'string' || !card.body.trim() || card.body.length > 900) throw invalid();
    return { id: `muse-${turnId}-${index}`, title: card.title.trim(), body: card.body.trim() };
  });
  const ids = new Set<string>();
  const updates = value.updates.map(update => {
    if (!record(update) || typeof update.id !== 'string' || ids.has(update.id) || typeof update.text !== 'string' || !update.text.trim() || update.text.length > 2000) throw invalid();
    const original = board.objects.find(object => object.id === update.id && object.editable && textTypes.has(object.type));
    if (!original) throw invalid();
    ids.add(update.id);
    return { id: update.id, text: update.text.trim(), expectedText: original.text };
  });
  return { reply: value.reply.trim(), actions: { cards, updates } };
}
