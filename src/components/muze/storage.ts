export type Drawing = { objects: Record<string, unknown>[]; viewport: number[] };
export type BoardPage = Drawing & { id: string; name: string };
export type Board = { id: string; name: string; activePage: string; pages: BoardPage[] };
export type Workspace = { version: 1; activeBoard: string; boards: Board[] };
export const uid = () => crypto.randomUUID();
export const newPage = (name = 'Page 1'): BoardPage => ({ id: uid(), name, objects: [], viewport: [1, 0, 0, 1, 0, 0] });
export function newBoard(name = 'Untitled board'): Board { const page = newPage(); return { id: uid(), name, activePage: page.id, pages: [page] }; }
export function newWorkspace(): Workspace { const board = newBoard(); return { version: 1, activeBoard: board.id, boards: [board] }; }

export function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('muze-whiteboards', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local storage is unavailable.'));
  });
}
export function readStorage(db: IDBDatabase): Promise<Workspace> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result || newWorkspace());
    request.onerror = () => reject(request.error);
  });
}
export function saveStorage(db: IDBDatabase, workspace: Workspace): Promise<void> {
  // Start the transaction immediately. Do not debounce the last stroke or defer it until unload.
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(workspace, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const allowedTypes = new Set(['Rect', 'Ellipse', 'Triangle', 'Polygon', 'Polyline', 'Line', 'Path', 'Textbox', 'IText', 'Text', 'Group', 'Image', 'MuzeArrow', 'MuzeNote', 'MuzeText', 'MuzeLabel', 'MuzeShape']);
const color = (value: unknown) => value == null || typeof value === 'string' && /^(#[\da-f]{3,8}|rgba?\([\d.,% ]+\)|transparent|none|black|white|)$/i.test(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
function validTextStyle(style: unknown): boolean {
  if (!record(style)) return false;
  if (['fill', 'stroke', 'textBackgroundColor', 'textDecorationColor'].some(key => !color(style[key]))) return false;
  if (style.fontFamily !== undefined && (typeof style.fontFamily !== 'string' || !/^[\w ,'-]{1,100}$/.test(style.fontFamily))) return false;
  return ['fontSize', 'deltaY', 'strokeWidth'].every(key => style[key] === undefined || finite(style[key]));
}
function validObject(value: unknown, depth = 0): boolean {
  if (!record(value) || depth > 12 || !allowedTypes.has(String(value.type))) return false;
  if (['left', 'top', 'width', 'height', 'scaleX', 'scaleY', 'angle', 'opacity', 'strokeWidth', 'fontSize', 'bend', 'boxHeight', 'inset'].some(key => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key] as number) > 1_000_000))) return false;
  if (value.src !== undefined && (typeof value.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(value.src))) return false;
  if (['fill', 'stroke', 'backgroundColor'].some(key => value[key] != null && (typeof value[key] !== 'string' || !/^(#[\da-f]{3,8}|rgba?\([\d.,% ]+\)|transparent|none|black|white|)$/i.test(value[key] as string)))) return false;
  if (!validTextStyle(value) || !color(value.backgroundColor)) return false;
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 100000)) return false;
  if (value.path !== undefined && value.path !== null) {
    const lengths: Record<string, number> = { M: 3, L: 3, H: 2, V: 2, C: 7, S: 5, Q: 5, T: 3, A: 8, Z: 1 };
    if (!Array.isArray(value.path) || value.path.length > 100000 || !value.path.every(part => Array.isArray(part) && part.length === lengths[String(part[0]).toUpperCase()] && part.slice(1).every(finite))) return false;
  }
  if (value.points !== undefined && (!Array.isArray(value.points) || value.points.length > 100000 || !value.points.every(point => record(point) && finite(point.x) && finite(point.y)))) return false;
  if (value.styles !== undefined) {
    if (Array.isArray(value.styles)) { if (!value.styles.every(run => record(run) && finite(run.start) && finite(run.end) && validTextStyle(run.style))) return false; }
    else if (!record(value.styles) || !Object.values(value.styles).every(line => record(line) && Object.values(line).every(validTextStyle))) return false;
  }
  if (value.shadow && (!record(value.shadow) || !color(value.shadow.color))) return false;
  if (value.clipPath || value.resizeFilter || value.filters !== undefined && (!Array.isArray(value.filters) || value.filters.length)) return false;
  return value.objects === undefined || Array.isArray(value.objects) && value.objects.length < 10000 && value.objects.every(child => validObject(child, depth + 1));
}
export function parseObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000 || !value.every(item => validObject(item))) throw new Error('This drawing contains invalid data.');
  return value;
}
export function parseBoardFile(text: string): Board {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.format !== 'muze' || value.version !== 1 || !record(value.board)) throw new Error('Choose a valid Muze board file.');
  const board = value.board;
  if (typeof board.name !== 'string' || !Array.isArray(board.pages) || !board.pages.length || board.pages.length > 100) throw new Error('This board file is incomplete.');
  const ids = new Set<string>();
  for (const page of board.pages) {
    if (!record(page) || typeof page.id !== 'string' || ids.has(page.id) || typeof page.name !== 'string' || !Array.isArray(page.objects) || page.objects.length > 10000 || !page.objects.every(item => validObject(item)) || !Array.isArray(page.viewport) || page.viewport.length !== 6 || !page.viewport.every(Number.isFinite) || page.viewport[0] < .1 || page.viewport[0] > 8) throw new Error('This board contains invalid drawing data.');
    ids.add(page.id);
  }
  return { ...board, id: uid(), name: board.name.slice(0, 160), activePage: ids.has(String(board.activePage)) ? String(board.activePage) : (board.pages[0] as BoardPage).id } as Board;
}
export function filename(name: string) { return name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 120) || 'Untitled board'; }
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
