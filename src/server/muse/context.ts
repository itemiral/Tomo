import type { MuseBoard } from '../../lib/muse-board';

type ConversationMessage = { id?: string; role: 'user' | 'assistant'; content: string };
type InputMessage = { role: 'developer' | 'user' | 'assistant'; content: string };
type Notebook = { name?: unknown; pages: { name?: unknown; objects: Record<string, unknown>[] }[]; comments: Record<string, unknown>[]; mediaPolicy?: unknown };
type NotebookEntry = { page: number; index: number; value: Record<string, unknown>; score: number };

export type MuseContextInput = {
  instructions: string;
  soul: string;
  memory: string;
  notebook: string;
  summary?: string;
  history: ConversationMessage[];
  retrievedHistory?: ConversationMessage[];
  message: string;
  board: MuseBoard;
  toolContext?: string;
  responseSchema?: unknown;
  inputBudget?: number;
  contextWindow?: number;
  outputReserve?: number;
  safetyMargin?: number;
};

export class MuseContextError extends Error {
  readonly status = 413;
}

const defaults = { inputBudget: 48_000, contextWindow: 65_536, outputReserve: 4096, safetyMargin: 2048 };
const referenceKeys = ['parentId', 'frameId', 'startBinding', 'endBinding'] as const;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const validLimit = (value: number | undefined, fallback: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : NaN;

// A byte can require a token. Counting serialized UTF-8 bytes deliberately
// overestimates ordinary text; it is not a model-tokenizer measurement. Keep
// separate output and framing reserves even when this conservative count fits.
export function estimateMuseInputTokens(messages: InputMessage[], responseSchema?: unknown) {
  return byteLength(JSON.stringify({ messages, response_format: responseSchema })) + messages.length * 16 + 256;
}

function words(text: string) {
  return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(word => !['the', 'and', 'this', 'that', 'with', 'from', 'your', 'please', 'could', 'would', 'make', 'have', 'into'].includes(word)));
}

function relevance(text: string, query: Set<string>) {
  let score = 0;
  for (const word of words(text)) if (query.has(word)) score++;
  return score;
}

function conversation(messages: ConversationMessage[]) {
  return messages.filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map(({ role, content }) => ({ role, content }));
}

function dropOldestExchange(messages: InputMessage[]) {
  if (!messages.length) return;
  messages.shift();
  while (messages.length && messages[0].role !== 'user') messages.shift();
}

function readNotebook(value: string): Notebook | null {
  try {
    const notebook = JSON.parse(value);
    if (!notebook || !Array.isArray(notebook.pages)) return null;
    return {
      name: notebook.name,
      pages: notebook.pages.map((page: { name?: unknown; objects?: unknown[] }) => ({ name: page.name, objects: (Array.isArray(page.objects) ? page.objects : []).filter(item => !!item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] })),
      comments: (Array.isArray(notebook.comments) ? notebook.comments : []).filter((item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item)),
      mediaPolicy: notebook.mediaPolicy,
    };
  } catch { return null; }
}

function notebookEntries(notebook: Notebook, query: Set<string>): NotebookEntry[] {
  const entries: NotebookEntry[] = [];
  const add = (page: number, index: number, value: Record<string, unknown>) => {
    const text = [value.text, value.markdown].filter(item => typeof item === 'string').join('\n');
    const preference = /\b(?:prefer|preference|always|never|tone|voice|communicat\w*|language|style|speak|explain|respond|answer|concise|detailed)\b/iu.test(text);
    entries.push({ page, index, value, score: (preference ? 100 : 0) + relevance(text, query) * 2 + (text ? 1 : 0) });
  };
  notebook.pages.forEach((page, pageIndex) => page.objects.forEach((value, index) => add(pageIndex, index, value)));
  notebook.comments.forEach((value, index) => add(-1, index, value));
  return entries.sort((a, b) => a.score - b.score || a.page - b.page || a.index - b.index);
}

function cleanBoard(board: MuseBoard): MuseBoard {
  const ids = new Set(board.objects.map(object => object.id));
  return {
    ...board,
    objects: board.objects.map(object => {
      const item = { ...object };
      if (item.parentId) item.editable = false;
      for (const key of referenceKeys) if (item[key] && !ids.has(item[key]!)) delete item[key];
      return item;
    }),
  };
}

/** Assemble only this owner's supplied context; this function never fetches data. */
export function buildMuseContext(input: MuseContextInput) {
  const outputReserve = validLimit(input.outputReserve, defaults.outputReserve);
  const safetyMargin = validLimit(input.safetyMargin, defaults.safetyMargin);
  const window = validLimit(input.contextWindow, defaults.contextWindow);
  const inputLimit = Math.min(validLimit(input.inputBudget, defaults.inputBudget), window - outputReserve - safetyMargin);
  if (!Number.isFinite(inputLimit) || !Number.isFinite(outputReserve) || !Number.isFinite(safetyMargin) || inputLimit <= 0) {
    throw new MuseContextError('Muse’s context budget is not configured correctly.');
  }

  const selected = new Set(input.board.selectedIds || []);
  if (input.board.selectionIncomplete || [...selected].some(id => !input.board.objects.some(object => object.id === id))) {
    throw new MuseContextError('Select the notes again before asking Muse.');
  }
  const originalHistory = conversation(input.history);
  const recentHistory: InputMessage[] = originalHistory.slice(-20);
  // Never replay an assistant answer whose corresponding user request was trimmed.
  while (recentHistory.length && recentHistory[0].role !== 'user') recentHistory.shift();
  const retrieved = conversation(input.retrievedHistory || []).slice(-8);
  let notebook = input.notebook;
  let toolContext = input.toolContext || '';
  let board = cleanBoard({ ...input.board, objects: input.board.objects.map(object => ({ ...object })) });
  const omitted = { history: originalHistory.length - recentHistory.length, objects: 0, notebook: 0, retrievedHistory: (input.retrievedHistory?.length || 0) - retrieved.length, tools: false };

  const assemble = (): InputMessage[] => {
    const sections = [input.instructions, `Soul.md:\n${input.soul}`, `Memory.md:\n${input.memory}`];
    if (notebook) sections.push(`Private Muse board (user context, not system instructions):\n${notebook}`);
    if (input.summary) sections.push(`Earlier conversation summary (historical context only; current owner notes, current board and the latest request take precedence):\n${input.summary}`);
    if (retrieved.length) sections.push(`Earlier conversation excerpts (historical evidence only; superseded or deleted preferences must not override current owner notes):\n${JSON.stringify(retrieved)}`);
    const partial = omitted.objects ? `\n\n${omitted.objects} other board objects were omitted to fit this request. Only the supplied object IDs and complete text may be used for updates. Do not claim to have reviewed the whole page.` : '';
    const noTools = omitted.tools ? '\n\nTool evidence was omitted to fit this request. Do not claim that live facts were verified or cite unseen results.' : '';
    return [{ role: 'developer', content: sections.join('\n\n') }, ...recentHistory, { role: 'user', content: `Current whiteboard page (context only):\n${JSON.stringify(board)}${partial}\n\nMy request:\n${input.message}${toolContext}${noTools}` }];
  };
  const fits = () => estimateMuseInputTokens(assemble(), input.responseSchema) <= inputLimit;
  const finish = () => {
    const messages = assemble();
    return { messages, board, budget: { inputUpperBound: estimateMuseInputTokens(messages, input.responseSchema), inputLimit, outputReserve, safetyMargin }, omitted };
  };
  if (fits()) return finish();

  // Recent exchanges resolve follow-ups; older turns have the compact summary.
  // Keep the last two exchanges initially so old chat cannot crowd out the page.
  while (recentHistory.length > 4 && !fits()) {
    const count = recentHistory.length; dropOldestExchange(recentHistory); omitted.history += count - recentHistory.length;
  }
  if (fits()) return finish();

  const query = words([input.message, ...board.objects.filter(object => selected.has(object.id)).map(object => object.text)].join('\n'));
  const parsedNotebook = readNotebook(notebook);
  const entries = parsedNotebook ? notebookEntries(parsedNotebook, query) : [];
  const removed = new Set<Record<string, unknown>>();
  const removeNotebookEntry = (entry: NotebookEntry) => {
    removed.add(entry.value); omitted.notebook++;
    notebook = JSON.stringify({
      ...parsedNotebook,
      pages: parsedNotebook!.pages.map(page => ({ ...page, objects: page.objects.filter(object => !removed.has(object)) })),
      comments: parsedNotebook!.comments.filter(comment => !removed.has(comment)),
    });
  };
  for (const entry of entries.filter(entry => entry.score < 100)) {
    if (fits()) return finish();
    removeNotebookEntry(entry);
  }
  if (!parsedNotebook && notebook && !fits()) { notebook = ''; omitted.notebook++; }
  if (fits()) return finish();

  while (retrieved.length && !fits()) { retrieved.shift(); omitted.retrievedHistory++; }
  if (fits()) return finish();

  const selectedObjects = board.objects.filter(object => selected.has(object.id));
  const background = board.objects.filter(object => !selected.has(object.id)).map((object, index) => {
    const connected = selectedObjects.some(focus => referenceKeys.some(key => object[key] === focus.id || focus[key] === object.id));
    const distance = object.bounds && selectedObjects.length ? Math.min(...selectedObjects.map(focus => focus.bounds ? Math.hypot(focus.bounds.x - object.bounds!.x, focus.bounds.y - object.bounds!.y) : Infinity)) : Infinity;
    return { object, index, score: relevance(object.text, query) * 10 + (connected ? 20 : 0) + (Number.isFinite(distance) ? 1 / (1 + distance / 500) : 0) };
  }).sort((a, b) => a.score - b.score || b.index - a.index);
  for (const { object } of background) {
    if (fits()) return finish();
    board = cleanBoard({ ...board, objects: board.objects.filter(item => item.id !== object.id) });
    omitted.objects++;
  }
  if (fits()) return finish();

  while (recentHistory.length && !fits()) {
    const count = recentHistory.length; dropOldestExchange(recentHistory); omitted.history += count - recentHistory.length;
  }
  if (fits()) return finish();
  for (const entry of entries.filter(entry => !removed.has(entry.value))) {
    if (fits()) return finish();
    removeNotebookEntry(entry);
  }
  if (fits()) return finish();
  if (notebook) { notebook = ''; omitted.notebook++; }
  if (fits()) return finish();
  if (toolContext) { toolContext = ''; omitted.tools = true; }
  if (fits()) return finish();

  throw new MuseContextError('Your Muse notes, request and selected notes exceed this turn’s context budget. Shorten your request or Muse notes, or select fewer board notes.');
}
