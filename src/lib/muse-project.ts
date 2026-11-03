import type { Board, Drawing } from '../components/muze/storage';
import type { MuseBoard, MuseSceneItem } from './muse-board';

type Bounds = Omit<MuseSceneItem, 'id'>;
type SceneObject = MuseBoard['objects'][number];
type PageOverview = { id: string; name: string; objectCount: number; commentCount: number; preview: string };
type Excerpt = { pageId: string; objectId: string; type: string; text: string; start: number; end: number; sourceLength: number; partial: boolean; bounds?: Bounds };
type Comment = { pageId: string; id: string; author: string; text: string; partial: boolean };
export type MuseProjectImageCandidate = { pageId: string; objectId: string; selected: boolean; reason: 'selected' | 'related' | 'page' | 'visual-region'; caption?: string; kind?: 'image' | 'scene' };
export type MuseProjectContext = {
  version: 1;
  readOnly: true;
  boardId: string;
  board: string;
  activePageId: string;
  pages: PageOverview[];
  excerpts: Excerpt[];
  comments: Comment[];
  images: MuseProjectImageCandidate[];
  coverage: {
    pages: { total: number; included: number; omitted: number };
    objects: { total: number; scanned: number; activeIncluded: number; excerpts: number; omitted: number };
    comments: { total: number; included: number; omitted: number };
    images: { total: number; included: number; omitted: number };
    scanLimited: boolean;
  };
};
type Candidate = { pageId: string; item: SceneObject; fullText: string; title: string; selected: boolean; order: number; score: number; image: boolean; changedAt: number };
type ScannedPage = { id: string; name: string; objects: Candidate[]; objectCount: number; limited: boolean };
export const MUSE_PROJECT_MAX_CHARS = 40_000;
// The client may append one active-page scene preview after rasterizing it.
const preparedContextLimit = MUSE_PROJECT_MAX_CHARS - 512;
const MAX_SCANNED_OBJECTS = 30_000;
const MAX_TEXT = 512_000;
const MAX_EXCERPTS = 24;
const MAX_COMMENTS = 16;
const MAX_IMAGES = 4;
const refs = ['parentId', 'frameId', 'startBinding', 'endBinding'] as const;
const textTypes = new Set(['MuzeText', 'MuzeNote', 'Textbox', 'IText']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000;
const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const short = (value: unknown, length: number) => typeof value === 'string' ? value.slice(0, length) : '';
const key = (pageId: string, objectId: string) => JSON.stringify([pageId, objectId]);
function readBounds(value: unknown): Bounds | undefined {
  if (!record(value) || ![value.x, value.y, value.w, value.h].every(bounded) || Number(value.w) < 0 || Number(value.h) < 0) return;
  return { x: Number(value.x), y: Number(value.y), w: Number(value.w), h: Number(value.h) };
}
function objectBounds(value: Record<string, unknown>, parentId?: string) {
  if (parentId || value.angle || value.skewX || value.skewY || value.flipX || value.flipY || value.originX && value.originX !== 'left' || value.originY && value.originY !== 'top') return;
  return readBounds({ x: value.left, y: value.top, w: Number(value.width) * (typeof value.scaleX === 'number' ? value.scaleX : 1), h: Number(value.height) * (typeof value.scaleY === 'number' ? value.scaleY : 1) });
}
const stopWords = new Set(['the', 'and', 'this', 'that', 'these', 'those', 'with', 'from', 'your', 'please', 'could', 'would', 'make', 'have', 'into', 'about', 'help', 'what', 'when', 'where', 'which', 'continue']);
function terms(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const words = (normalized.match(/[\p{L}\p{N}]{2,}/gu) || []).filter(word => !stopWords.has(word));
  const result = new Set(words.slice(0, 32));
  // Word segmentation is not reliable for every language. Short ideographic
  // phrases still match a note without requiring the whole sentence to repeat.
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) || []) {
    for (let index = 0; index < run.length - 1 && result.size < 48; index++) result.add(run.slice(index, index + 2));
  }
  return [...result];
}
function relevance(value: string, query: string[]) {
  const text = value.toLocaleLowerCase();
  return query.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}
function textWindow(value: string, query: string[], length: number) {
  if (value.length <= length) return { text: value, start: 0, end: value.length, sourceLength: value.length, partial: false };
  const lower = value.toLocaleLowerCase(), starts = new Set([0]);
  for (const term of query) {
    const index = lower.indexOf(term);
    if (index >= 0) starts.add(Math.min(value.length - length, Math.max(0, index - Math.floor(length / 3))));
  }
  const start = [...starts].sort((a, b) => relevance(value.slice(b, b + length), query) - relevance(value.slice(a, a + length), query) || a - b)[0];
  return { text: value.slice(start, start + length), start, end: start + length, sourceLength: value.length, partial: true };
}
/** Select from the entire supplied board before applying the request limits. */
export function prepareMuseProject(input: {
  board: Board;
  message: string;
  selectedIds?: string[];
  activeDrawing?: Pick<Drawing, 'objects'>;
  sceneItems?: MuseSceneItem[];
  activePageId?: string;
}): { boardContext: string; projectContext: string; imageCandidates: MuseProjectImageCandidate[]; anchorIds: string[] } {
  const { board } = input, activePageId = input.activePageId || board.activePage;
  if (!id(board.id) || !id(activePageId) || !Array.isArray(board.pages)) throw new Error('This board could not be read.');
  const active = board.pages.find(page => page.id === activePageId);
  if (!active) throw new Error('This page is not part of this board.');
  const selectedIds = input.selectedIds || [], selected = new Set(selectedIds.filter(id)), found = new Set<string>();
  const query = terms(short(input.message, 8000));
  const geometry = new Map((input.sceneItems || []).filter(item => id(item.id)).map(item => [item.id!, readBounds(item)]));
  const byPage = new Map<string, ScannedPage>();
  let scanned = 0, allKnownObjects = 0, selectionIncomplete = selected.size !== selectedIds.length;
  // Reserve the scan allowance for the active page, even if it is the last tab.
  const pageOrder = [active, ...board.pages.filter(page => page !== active)].slice(0, 100);
  for (const page of pageOrder) {
    if (!id(page.id) || byPage.has(page.id)) continue;
    const result: ScannedPage = { id: page.id, name: short(page.name, 160), objects: [], objectCount: 0, limited: false };
    byPage.set(page.id, result);
    const seen = new Set<string>(), visited = new WeakSet<object>();
    const roots = page.id === activePageId && input.activeDrawing ? input.activeDrawing.objects : page.objects;
    const visit = (items: unknown[], parentId?: string, inheritedSelection = false, inheritedLock = false, depth = 0) => {
      if (depth > 12) { result.limited = true; if (inheritedSelection) selectionIncomplete = true; return; }
      for (let index = 0; index < items.length; index++) {
        if (scanned >= MAX_SCANNED_OBJECTS) {
          // Nested objects in the unscanned remainder are unknown. Coverage
          // explicitly marks this count as a lower bound through scanLimited.
          result.objectCount += items.length - index; allKnownObjects += items.length - index;
          result.limited = true;
          if (page.id === activePageId && selected.size) selectionIncomplete = true;
          return;
        }
        scanned++; result.objectCount++; allKnownObjects++;
        const value = items[index];
        if (!record(value) || visited.has(value)) continue;
        visited.add(value);
        if (!id(value.id) || seen.has(value.id)) { if (inheritedSelection) selectionIncomplete = true; continue; }
        seen.add(value.id);
        const direct = page.id === activePageId && selected.has(value.id), focused = direct || inheritedSelection;
        if (direct) found.add(value.id);
        const group = value.type === 'Group' && Array.isArray(value.objects) && value.objects.length > 0;
        const source = typeof value.markdown === 'string' ? value.markdown : typeof value.text === 'string' ? value.text : '';
        const fullText = source.slice(0, MAX_TEXT);
        const item: SceneObject = { id: value.id, type: short(value.type, 40), text: fullText.slice(0, 4000), editable: !parentId && !inheritedLock && !group && !value.isLocked && !value.labelFor && textTypes.has(String(value.type)) && source.length <= 4000 };
        if (parentId) item.parentId = parentId;
        for (const ref of refs.slice(1)) if (id(value[ref])) item[ref] = value[ref] as string;
        const box = page.id === activePageId && input.sceneItems ? geometry.get(value.id) : objectBounds(value, parentId);
        if (box) item.bounds = box;
        const title = short(value.documentTitle || value.caption || value.alt || value.sourceTitle, 160);
        const changedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? Math.max(0, value.updatedAt) : 0;
        result.objects.push({ pageId: page.id, item, fullText, title, selected: focused && !group, order: result.objects.length, score: 0, image: value.type === 'Image', changedAt });
        if (source.length > MAX_TEXT) result.limited = true;
        if (group) visit(value.objects as unknown[], value.id, focused, inheritedLock || !!value.isLocked, depth + 1);
      }
    };
    visit(Array.isArray(roots) ? roots : []);
  }
  const currentPage = byPage.get(activePageId)!;
  const focus = currentPage.objects.filter(candidate => candidate.selected);
  if (found.size !== selected.size || selected.size && !focus.length) selectionIncomplete = true;
  const focusSample = focus.slice(0, 150);
  const focusTerms = terms(focusSample.map(candidate => candidate.fullText.slice(0, 600)).join(' '));
  const neighbors = new Map(currentPage.objects.map(candidate => [candidate.item.id, new Set<string>()]));
  for (const { item } of currentPage.objects) for (const ref of refs) if (item[ref] && neighbors.has(item[ref]!)) {
    neighbors.get(item.id)!.add(item[ref]!); neighbors.get(item[ref]!)!.add(item.id);
  }
  const related = new Set(focusSample.map(candidate => candidate.item.id));
  // An arrow is a scene object between two notes, so two hops reach its other
  // endpoint. The same walk keeps a selected note's containing frame nearby.
  let frontier = [...related];
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = [];
    for (const focusId of frontier) for (const neighbor of neighbors.get(focusId) || []) if (!related.has(neighbor)) { related.add(neighbor); next.push(neighbor); }
    frontier = next;
  }
  const recentIntent = /\b(recent|latest|last|continue|resume|changed)\b/i.test(input.message);
  const latestChange = Math.max(0, ...[...byPage.values()].flatMap(page => page.objects.map(candidate => candidate.changedAt)));
  for (const page of byPage.values()) for (const candidate of page.objects) {
    const local = candidate.pageId === activePageId;
    const linked = local && related.has(candidate.item.id);
    const distance = local && candidate.item.bounds && focusSample.length ? Math.min(...focusSample.map(point => point.item.bounds ? Math.hypot(point.item.bounds.x - candidate.item.bounds!.x, point.item.bounds.y - candidate.item.bounds!.y) : Infinity)) : Infinity;
    candidate.score = (candidate.selected ? 100_000 : 0) + relevance(candidate.fullText, query) * 100 + relevance(candidate.title + ' ' + page.name, query) * 160
      + (linked ? 80 : 0) + (Number.isFinite(distance) ? 20 / (1 + distance / 600) : 0)
      + relevance(candidate.fullText.slice(0, 4000), focusTerms) * 8 + (local ? 5 : 0) + (candidate.fullText ? 1 : 0)
      + (recentIntent ? (latestChange ? candidate.changedAt / latestChange : candidate.order / Math.max(1, page.objects.length - 1)) * 12 : 0);
  }
  const ranked = (items: Candidate[]) => [...items].sort((a, b) => b.score - a.score || a.order - b.order || a.pageId.localeCompare(b.pageId));
  const selectedBoard: MuseBoard = { board: short(board.name, 160), page: currentPage.name, objects: [], selectedIds: [] };
  let boardSize = JSON.stringify(selectedBoard).length;
  for (const candidate of ranked(currentPage.objects)) {
    const extra = JSON.stringify(candidate.item).length + 1 + (candidate.selected ? JSON.stringify(candidate.item.id).length + 1 : 0);
    if (selectedBoard.objects.length >= 150 || boardSize + extra > 34_900) { if (candidate.selected) selectionIncomplete = true; continue; }
    selectedBoard.objects.push({ ...candidate.item }); boardSize += extra;
    if (candidate.selected) selectedBoard.selectedIds!.push(candidate.item.id);
  }
  const activeIds = new Set(selectedBoard.objects.map(item => item.id));
  for (const item of selectedBoard.objects) for (const ref of refs) if (item[ref] && (!activeIds.has(item[ref]!) || item[ref] === item.id)) delete item[ref];
  if (selectionIncomplete) selectedBoard.selectionIncomplete = true;

  const candidates = [...byPage.values()].flatMap(page => page.objects);
  const boardComments = (Array.isArray(board.comments) ? board.comments : []).slice(0, 1000);
  const comments = boardComments.filter(comment => id(comment.id) && typeof comment.text === 'string' && byPage.has(comment.pageId || board.pages[0]?.id));
  const commentPage = (comment: typeof comments[number]) => comment.pageId || board.pages[0].id;
  const images = ranked(candidates.filter(candidate => candidate.image));
  const imageCandidates: MuseProjectImageCandidate[] = images.slice(0, MAX_IMAGES).map(candidate => ({
    pageId: candidate.pageId, objectId: candidate.item.id, selected: candidate.selected,
    reason: candidate.selected ? 'selected' : candidate.score > 6 ? 'related' : 'page',
    ...(candidate.title ? { caption: candidate.title } : {}),
  }));
  const includedKeys = new Set(selectedBoard.objects.map(item => key(activePageId, item.id)));
  const possible = ranked(candidates.filter(candidate => candidate.fullText && (!includedKeys.has(key(candidate.pageId, candidate.item.id)) || candidate.fullText.length > 4000)));
  // Favor a spread of pages when relevance is similar, without letting an
  // unrelated page displace several strong matches from the same section.
  const chosen: Candidate[] = [], used = new Set<Candidate>(), pageUses = new Map<string, number>();
  for (let slot = 0; slot < MAX_EXCERPTS && slot < possible.length; slot++) {
    let best: Candidate | undefined, bestScore = -Infinity;
    for (const candidate of possible) if (!used.has(candidate)) {
      const score = (candidate.score - (candidate.pageId === activePageId ? 5 : 0)) / (1 + (pageUses.get(candidate.pageId) || 0) * .6);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best) break;
    chosen.push(best); used.add(best); pageUses.set(best.pageId, (pageUses.get(best.pageId) || 0) + 1);
  }
  const excerpts: Excerpt[] = chosen.map(candidate => ({ pageId: candidate.pageId, objectId: candidate.item.id, type: candidate.item.type, ...textWindow(candidate.fullText, query, 1200), ...(candidate.item.bounds ? { bounds: candidate.item.bounds } : {}) }));
  const context: MuseProjectContext = {
    version: 1, readOnly: true, boardId: board.id, board: short(board.name, 160), activePageId,
    pages: [...byPage.values()].sort((a, b) => board.pages.findIndex(page => page.id === a.id) - board.pages.findIndex(page => page.id === b.id)).map(page => ({
      id: page.id, name: page.name.slice(0, 80), objectCount: page.objectCount,
      commentCount: comments.filter(comment => commentPage(comment) === page.id).length,
      preview: ranked(page.objects).filter(candidate => candidate.fullText || candidate.title).slice(0, 3).map(candidate => [candidate.title, candidate.fullText.split('\n').find(line => line.trim()) || ''].filter(Boolean).join(': ')).join(' · ').slice(0, 160),
    })),
    excerpts,
    comments: [...comments].sort((a, b) => relevance(b.text, query) - relevance(a.text, query) || Number(commentPage(b) === activePageId) - Number(commentPage(a) === activePageId)).slice(0, MAX_COMMENTS).map(comment => ({ pageId: commentPage(comment), id: comment.id, author: short(comment.author, 120), text: textWindow(comment.text, query, 1000).text, partial: comment.text.length > 1000 })),
    images: imageCandidates,
    coverage: {
      pages: { total: board.pages.length, included: byPage.size, omitted: board.pages.length - byPage.size },
      objects: { total: allKnownObjects, scanned, activeIncluded: selectedBoard.objects.length, excerpts: 0, omitted: 0 },
      comments: { total: Array.isArray(board.comments) ? board.comments.length : 0, included: 0, omitted: 0 },
      images: { total: images.length, included: imageCandidates.length, omitted: images.length - imageCandidates.length },
      scanLimited: byPage.size < board.pages.length || [...byPage.values()].some(page => page.limited) || boardComments.length < (board.comments?.length || 0),
    },
  };
  const updateCoverage = () => {
    const read = new Set([...includedKeys, ...context.excerpts.map(item => key(item.pageId, item.objectId)), ...context.images.map(item => key(item.pageId, item.objectId))]);
    context.coverage.objects.excerpts = context.excerpts.length;
    context.coverage.objects.omitted = Math.max(0, allKnownObjects - read.size);
    context.coverage.comments.included = context.comments.length;
    context.coverage.comments.omitted = context.coverage.comments.total - context.comments.length;
  };
  updateCoverage();
  while (JSON.stringify(context).length > preparedContextLimit && (context.excerpts.length || context.comments.length)) {
    if (context.excerpts.length) context.excerpts.pop(); else context.comments.pop();
    updateCoverage();
  }
  // Every legal page keeps its identity in the overview even for very long names.
  if (JSON.stringify(context).length > preparedContextLimit) for (const page of context.pages) page.preview = page.preview.slice(0, 40);
  const projectContext = JSON.stringify(context);
  if (projectContext.length > preparedContextLimit) throw new Error('This project overview is too large to send.');
  const anchorIds = ranked(currentPage.objects).filter(candidate => activeIds.has(candidate.item.id) && candidate.score > 6).slice(0, 3).map(candidate => candidate.item.id);
  return { boardContext: JSON.stringify(selectedBoard), projectContext, imageCandidates: context.images.map(image => ({ ...image })), anchorIds };
}

/** Validate text-only, read-only scene context independently of editable IDs. */
export function parseMuseProjectContext(value: unknown, expected: { boardId?: string; activePageId?: string } = {}): MuseProjectContext | null {
  if (value === undefined || value === null || value === '') return null;
  const invalid = () => new Error('This project context could not be read.');
  if (typeof value !== 'string' || value.length > MUSE_PROJECT_MAX_CHARS) throw invalid();
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw invalid(); }
  if (!record(data) || data.version !== 1 || data.readOnly !== true || !id(data.boardId) || !id(data.activePageId) || typeof data.board !== 'string' || data.board.length > 160
    || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 100 || !Array.isArray(data.excerpts) || data.excerpts.length > MAX_EXCERPTS
    || !Array.isArray(data.comments) || data.comments.length > MAX_COMMENTS || !Array.isArray(data.images) || data.images.length > MAX_IMAGES + 1
    || expected.boardId !== undefined && data.boardId !== expected.boardId || expected.activePageId !== undefined && data.activePageId !== expected.activePageId) throw invalid();
  const pageIds = new Set<string>();
  const pages = data.pages.map(page => {
    if (!record(page) || !id(page.id) || pageIds.has(page.id) || typeof page.name !== 'string' || page.name.length > 80 || typeof page.preview !== 'string' || page.preview.length > 160 || !count(page.objectCount) || !count(page.commentCount)) throw invalid();
    pageIds.add(page.id);
    return { id: page.id, name: page.name, objectCount: page.objectCount, commentCount: page.commentCount, preview: page.preview };
  });
  if (!pageIds.has(data.activePageId)) throw invalid();
  const excerptIds = new Set<string>();
  const excerpts = data.excerpts.map(item => {
    if (!record(item) || !id(item.pageId) || !pageIds.has(item.pageId) || !id(item.objectId) || excerptIds.has(key(item.pageId, item.objectId)) || typeof item.type !== 'string' || item.type.length > 40 || typeof item.text !== 'string' || item.text.length > 1200
      || !count(item.start) || !count(item.end) || !count(item.sourceLength) || item.sourceLength > MAX_TEXT || item.start > item.end || item.end > item.sourceLength || item.end - item.start !== item.text.length
      || typeof item.partial !== 'boolean' || item.partial !== (item.start !== 0 || item.end !== item.sourceLength)) throw invalid();
    const box = item.bounds === undefined ? undefined : readBounds(item.bounds);
    if (item.bounds !== undefined && !box) throw invalid();
    excerptIds.add(key(item.pageId, item.objectId));
    return { pageId: item.pageId, objectId: item.objectId, type: item.type, text: item.text, start: item.start, end: item.end, sourceLength: item.sourceLength, partial: item.partial, ...(box ? { bounds: box } : {}) };
  });
  const commentIds = new Set<string>();
  const comments = data.comments.map(item => {
    if (!record(item) || !id(item.pageId) || !pageIds.has(item.pageId) || !id(item.id) || commentIds.has(item.id) || typeof item.author !== 'string' || item.author.length > 120 || typeof item.text !== 'string' || item.text.length > 1000 || typeof item.partial !== 'boolean') throw invalid();
    commentIds.add(item.id);
    return { pageId: item.pageId, id: item.id, author: item.author, text: item.text, partial: item.partial };
  });
  const imageIds = new Set<string>();
  const images = data.images.map(item => {
    if (!record(item) || !id(item.pageId) || !pageIds.has(item.pageId) || !id(item.objectId) || imageIds.has(key(item.pageId, item.objectId)) || typeof item.selected !== 'boolean'
      || !['selected', 'related', 'page', 'visual-region'].includes(String(item.reason)) || item.selected && item.pageId !== data.activePageId || item.selected !== (item.reason === 'selected')
      || item.kind !== undefined && !['image', 'scene'].includes(String(item.kind))
      || item.kind === 'scene' && (item.objectId !== 'scene-preview' || item.pageId !== data.activePageId || item.reason !== 'visual-region' || item.selected)
      || item.reason === 'visual-region' && item.kind !== 'scene'
      || item.caption !== undefined && (typeof item.caption !== 'string' || item.caption.length > 160)) throw invalid();
    imageIds.add(key(item.pageId, item.objectId));
    return { pageId: item.pageId, objectId: item.objectId, selected: item.selected, reason: item.reason as MuseProjectImageCandidate['reason'], ...(typeof item.caption === 'string' ? { caption: item.caption } : {}), ...(item.kind ? { kind: item.kind as 'image' | 'scene' } : {}) };
  });
  if (images.filter(item => item.kind !== 'scene').length > MAX_IMAGES) throw invalid();
  const coverage = data.coverage;
  if (!record(coverage) || typeof coverage.scanLimited !== 'boolean') throw invalid();
  for (const [name, fields] of Object.entries({ pages: ['total', 'included', 'omitted'], objects: ['total', 'scanned', 'activeIncluded', 'excerpts', 'omitted'], comments: ['total', 'included', 'omitted'], images: ['total', 'included', 'omitted'] })) {
    const section = coverage[name];
    if (!record(section) || fields.some(field => !count(section[field]))) throw invalid();
  }
  const coverageValue = coverage as MuseProjectContext['coverage'];
  if (coverageValue.pages.included !== pages.length || coverageValue.objects.excerpts !== excerpts.length || coverageValue.comments.included !== comments.length || coverageValue.images.included !== images.length
    || coverageValue.objects.activeIncluded > 150 || coverageValue.objects.scanned > MAX_SCANNED_OBJECTS || coverageValue.objects.omitted > coverageValue.objects.total
    || [coverageValue.pages, coverageValue.comments, coverageValue.images].some(section => section.total !== section.included + section.omitted)) throw invalid();
  return { version: 1, readOnly: true, boardId: data.boardId, board: data.board, activePageId: data.activePageId, pages, excerpts, comments, images, coverage: {
    pages: { total: coverageValue.pages.total, included: pages.length, omitted: coverageValue.pages.omitted },
    objects: { total: coverageValue.objects.total, scanned: coverageValue.objects.scanned, activeIncluded: coverageValue.objects.activeIncluded, excerpts: excerpts.length, omitted: coverageValue.objects.omitted },
    comments: { total: coverageValue.comments.total, included: comments.length, omitted: coverageValue.comments.omitted },
    images: { total: coverageValue.images.total, included: images.length, omitted: coverageValue.images.omitted },
    scanLimited: coverageValue.scanLimited,
  } };
}
