import 'server-only';
import type {NextRequest} from 'next/server';
import {boardContext, boardJson, databaseFailure} from './api';
import {boardId} from './validation';
import {jsonBody, PrivateError} from '../muse/private';
import {parseBoardContext} from '@/lib/muse-board';
import {parseMuseProjectContext} from '@/lib/muse-project';

export async function manageRequestLease(request: NextRequest, id: string, operation: 'renew' | 'release') {
  const {client} = await boardContext(request, true), body = await jsonBody(request, 1024);
  const {data, error} = await client.rpc('shared_board_lease', {operation, board_id: boardId(id), request_id: boardId(body.requestId)});
  if (error) databaseFailure(error);
  return boardJson(data);
}

/** Only shared object references cross this boundary. Owner memory stays in askMuse. */
export async function acquireMuseBoardLease(request: NextRequest, body: Record<string, unknown>, signal: AbortSignal) {
  if (body.sharedBoardId === undefined) return null;
  const id = boardId(body.sharedBoardId), requestId = boardId(body.requestId);
  const [threadBoard, pageId] = String(body.thread).split(':');
  if (threadBoard !== id || !pageId) throw new PrivateError(400, 'Open this board before messaging Muse.');
  let board, project;
  try { board = parseBoardContext(body.board); project = parseMuseProjectContext(body.project, {boardId: id, activePageId: pageId}); }
  catch (error) { throw new PrivateError(400, (error as Error).message); }
  const refs = new Map<string, {pageId: string; objectId: string}>();
  const add = (pageId: string, objectId: string) => refs.set(JSON.stringify([pageId,objectId]), {pageId,objectId});
  board.objects.forEach(item => add(pageId,item.id));
  project?.excerpts.forEach(item => add(item.pageId,item.objectId));
  project?.images.filter(item => item.kind !== 'scene').forEach(item => add(item.pageId,item.objectId));
  const {client} = await boardContext(request, true);
  const previewPages = new Set(project?.images.filter(item => item.kind === 'scene').map(item => item.pageId));
  if (previewPages.size) {
    const {data,error} = await client.from('shared_boards').select('scene').eq('id',id).maybeSingle();
    if(error)databaseFailure(error);
    if(!data)throw new PrivateError(403,'This board is unavailable or you do not have access.');
    const collect=(pageId:string,objects:Record<string,unknown>[])=>{for(const item of objects){if(typeof item.id==='string')add(pageId,item.id);if(Array.isArray(item.objects))collect(pageId,item.objects);}};
    // A raster preview can include shapes outside the text packet's limit.
    // Protect that page's scene without locking unrelated pages.
    for(const page of data.scene.pages)if(previewPages.has(page.id))collect(page.id,page.objects);
  }
  const rpc = async (operation: 'acquire' | 'renew' | 'release') => {
    const {error} = await client.rpc('shared_board_lease', {operation, board_id: id, request_id: requestId, ...(operation === 'acquire' ? {objects: [...refs.values()]} : {})});
    if (error) databaseFailure(error);
  };
  signal.throwIfAborted();
  await rpc('acquire');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, released = false;
  const release = async () => {
    stopped = true; if (timer) clearTimeout(timer);
    if (released) return; released = true;
    signal.removeEventListener('abort', abort);
    // A crashed client/server is also bounded by the database expiry.
    await rpc('release').catch(() => {});
  };
  const abort = () => { controller.abort(signal.reason); void release(); };
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) { abort(); signal.throwIfAborted(); }
  const renew = () => { timer = setTimeout(async () => {
    if (stopped) return;
    try { await rpc('renew'); if (!stopped) renew(); }
    catch (error) { controller.abort(error); await release(); }
  }, 15_000); };
  renew();
  return {
    signal: AbortSignal.any([signal,controller.signal]),
    release,
    async finish() {
      stopped = true; if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // Keep protection while the browser applies and saves the completed turn.
      await rpc('renew');
    },
  };
}
