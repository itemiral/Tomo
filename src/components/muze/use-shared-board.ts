'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {parseBoardFile, type Board, type Drawing} from './storage';
import {BoardConflict, mergeSharedBoard, mergeSharedDrawing, sameScene} from './shared-merge';
import {MUSE_NOTES_PROTECTED, readProtectedObjects, removesProtectedObjects, restoreProtectedObjects, type ProtectedBoardObject} from '@/lib/shared-board-leases';

export type SharedSnapshot = {board: Board; revision: string; role: 'owner' | 'editor'; protectedObjects?: ProtectedBoardObject[]};
export type SharedListing = {id: string; name: string; role: 'owner' | 'editor'; updatedAt: string};
class BoardRequestError extends Error { constructor(message: string, readonly status: number) {super(message);} }
export async function boardRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(15_000), signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    const response = await fetch('/api/boards' + path, {...init, signal, cache: 'no-store', headers: {'Content-Type':'application/json', ...init.headers}});
    const data = await response.json().catch(error => { if (signal.aborted) throw error; if(response.ok)throw new Error('This shared board could not be read.'); return {}; });
    if (!response.ok) throw new BoardRequestError(data?.error || 'Could not reach this board. Try again.', response.status);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This shared board could not be read.');
    const method=(init.method||'GET').toUpperCase();
    const expectsBoard=path==='/join'||/^\/[a-f0-9-]{36}$/i.test(path)||path===''&&method==='POST';
    if(expectsBoard&&!data.board||path===''&&method==='GET'&&!Array.isArray(data.boards))throw new Error('This shared board could not be read.');
    if (data.board) {
      const id = data.board.id;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || typeof data.revision !== 'string' || !['owner','editor'].includes(data.role)) throw new Error('This shared board could not be read.');
      data.board = {...parseBoardFile(JSON.stringify({format:'muze',version:1,board:data.board})),id};
      data.protectedObjects = readProtectedObjects(data.protectedObjects);
    }
    return data;
  } catch (error) {
    if (!init.signal?.aborted && timeout.aborted) throw new BoardRequestError('Saving or loading this board took too long. Try again.', 504);
    throw error;
  }
}
const locationBoard = () => ({id: new URL(location.href).searchParams.get('board'), token: new URLSearchParams(location.hash.slice(1)).get('invite')});
function writeLocation(id: string | null, token: string | null = null) {
  const url = new URL(location.href); if (id) url.searchParams.set('board',id); else url.searchParams.delete('board');
  url.hash = token ? new URLSearchParams({invite:token}).toString() : '';
  history.replaceState(null,'',url);
}

export function useSharedBoard(owner: string | undefined, canReceive: () => boolean) {
  const [route,setRoute] = useState<{id: string|null;token: string|null}>({id:null,token:null});
  const [view,setView] = useState<{owner?: string; snapshot: SharedSnapshot|null}>({snapshot:null});
  const [boards,setBoards] = useState<SharedListing[]>([]), [error,setError] = useState(''), [busy,setBusy] = useState(false), [conflict,setConflict] = useState(false);
  const storedOwner=useRef(owner), navigation=useRef(0);
  const currentRoute=useRef(route); currentRoute.current=route;
  const epoch=useRef(0), base=useRef<SharedSnapshot|null>(null), draft=useRef<Board|null>(null), inFlight=useRef<Promise<void>|null>(null), timer=useRef<ReturnType<typeof setTimeout>|null>(null), blocked=useRef(false);
  const account=useRef(owner); account.current=owner;
  const receiver=useRef(canReceive); receiver.current=canReceive;
  const publishView=useCallback(() => {if(base.current&&draft.current)setView({owner:account.current,snapshot:{...base.current,board:draft.current}});},[]);
  const refreshList=useCallback(async()=>{const version=epoch.current, expectedOwner=account.current;if(!expectedOwner)return;try{const result=await boardRequest<{boards:SharedListing[]}>('');if(version===epoch.current&&expectedOwner===account.current)setBoards(result.boards);}catch{/* Opening a local board does not require cloud access. */}},[]);

  useEffect(()=>{
    if(owner&&!route.token&&route.id&&base.current?.board.id===route.id&&storedOwner.current===owner){void refreshList();return;}
    storedOwner.current=owner;
    const version=++epoch.current;const controller=new AbortController();base.current=null;draft.current=null;inFlight.current=null;blocked.current=false;
    setView({owner,snapshot:null});setError('');setConflict(false);setBoards([]);setBusy(!!route.id&&!!owner);
    if(timer.current)clearTimeout(timer.current);
    if(owner){void refreshList();if(route.id) void (async()=>{
      try{
        const snapshot=route.token ? await boardRequest<SharedSnapshot>('/join',{method:'POST',body:JSON.stringify({boardId:route.id,token:route.token}),signal:controller.signal}) : await boardRequest<SharedSnapshot>('/'+encodeURIComponent(route.id!),{signal:controller.signal});
        if(version!==epoch.current||owner!==account.current)return;
        base.current=snapshot;draft.current=snapshot.board;publishView();setBusy(false);
        if(route.token){writeLocation(snapshot.board.id);setRoute({id:snapshot.board.id,token:null});void refreshList();}
      }catch(cause){if(version===epoch.current&&!controller.signal.aborted){setError((cause as Error).message);setBusy(false);}}
    })();}
    return()=>{controller.abort();epoch.current++;if(timer.current)clearTimeout(timer.current);};
  },[owner,route.id,route.token,publishView,refreshList]);

  const flush=useCallback(async()=>{
    if(inFlight.current)return inFlight.current;
    const version=epoch.current, expectedOwner=account.current;
    if(!expectedOwner||storedOwner.current!==expectedOwner)return;
    const work=async()=>{
      if(blocked.current)throw new BoardConflict();
      try{
        let attempts=0;
        while(base.current&&draft.current&&!sameScene(base.current.board,draft.current)){
          if(blocked.current)throw new BoardConflict();
          const saved=base.current, sent=draft.current;setBusy(true);
          try{
            const result=await boardRequest<SharedSnapshot>('/'+saved.board.id,{method:'PUT',body:JSON.stringify({board:sent,revision:saved.revision})});
            if(version!==epoch.current||expectedOwner!==account.current)return;
            if(blocked.current)throw new BoardConflict();
            const merged=mergeSharedBoard(sent,draft.current!,result.board);base.current=result;draft.current=merged;publishView();setError('');
          }catch(cause){
            if(version!==epoch.current||expectedOwner!==account.current)return;
            if(cause instanceof BoardRequestError&&cause.status===423&&attempts++<3){
              const latest=await boardRequest<SharedSnapshot>('/'+saved.board.id);
              if(version!==epoch.current||expectedOwner!==account.current)return;
              const restored=restoreProtectedObjects(draft.current!,latest.board,latest.protectedObjects||[]);
              draft.current=mergeSharedBoard(saved.board,restored,latest.board);base.current=latest;publishView();setError(MUSE_NOTES_PROTECTED);
              continue;
            }
            if(cause instanceof BoardRequestError&&cause.status===409&&attempts++<3){
              const latest=await boardRequest<SharedSnapshot>('/'+saved.board.id);
              if(version!==epoch.current||expectedOwner!==account.current)return;
              if(!receiver.current())throw new Error('Finish editing, then retry saving the board.');
              const restored=restoreProtectedObjects(draft.current!,latest.board,latest.protectedObjects||[]);
              draft.current=mergeSharedBoard(saved.board,restored,latest.board);base.current=latest;publishView();
            }else throw cause;
          }
        }
      }catch(cause){if(version===epoch.current&&expectedOwner===account.current){setError((cause as Error).message);if(cause instanceof BoardConflict){blocked.current=true;setConflict(true);}}throw cause;}
      finally{if(version===epoch.current&&expectedOwner===account.current)setBusy(false);}
    };
    const promise=work();inFlight.current=promise;try{await promise;}finally{if(inFlight.current===promise)inFlight.current=null;}
  },[publishView]);

  useEffect(()=>{
    setRoute(locationBoard());
    const read=async()=>{
      const target=locationBoard(), previous=currentRoute.current, owner=account.current, version=++navigation.current;
      if(target.id===previous.id&&target.token===previous.token)return;
      try {
        await flush();
        if(version!==navigation.current||owner!==account.current)return;
        setRoute(target);
      } catch {
        if(version===navigation.current&&owner===account.current)writeLocation(previous.id,previous.token);
      }
    };
    addEventListener('popstate',read);addEventListener('hashchange',read);
    return()=>{navigation.current++;removeEventListener('popstate',read);removeEventListener('hashchange',read);};
  },[flush]);

  useEffect(()=>{
    if(!owner||!route.id)return;
    let cancelled=false, polling=false;
    const controller=new AbortController();
    const tick=async()=>{
      if(cancelled||polling||document.hidden||!receiver.current()||inFlight.current||blocked.current||!base.current||!draft.current)return;
      if(!sameScene(base.current.board,draft.current)){await flush().catch(()=>{});return;}
      const version=epoch.current, previous=base.current;polling=true;
      try{
        const latest=await boardRequest<SharedSnapshot>('/'+previous.board.id,{signal:controller.signal});
        if(cancelled||version!==epoch.current||owner!==account.current||base.current!==previous||!receiver.current()||inFlight.current||!draft.current)return;
        if(latest.revision!==previous.revision||JSON.stringify(latest.protectedObjects)!==JSON.stringify(previous.protectedObjects)){draft.current=mergeSharedBoard(previous.board,draft.current,latest.board);base.current=latest;publishView();}
        setError('');
      }catch(cause){if(!cancelled&&version===epoch.current){setError((cause as Error).message);if(cause instanceof BoardConflict){blocked.current=true;setConflict(true);}}}
      finally{polling=false;}
    };
    const resume=()=>void tick();
    const interval=setInterval(resume,2000);addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    return()=>{cancelled=true;controller.abort();clearInterval(interval);removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
  },[owner,route.id,flush,publishView]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(base.current&&draft.current&&!sameScene(base.current.board,draft.current)){event.preventDefault();event.returnValue='';}};addEventListener('beforeunload',warn);return()=>removeEventListener('beforeunload',warn);},[]);

  const update=useCallback((change:(board:Board)=>Board)=>{
    if(!draft.current||!account.current||storedOwner.current!==account.current)return;
    const next=change(draft.current);
    if(removesProtectedObjects(draft.current,next,base.current?.protectedObjects||[])){draft.current={...draft.current};setError(MUSE_NOTES_PROTECTED);publishView();return;}
    draft.current=next;publishView();
    if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void flush().catch(()=>{}),400);
  },[flush,publishView]);
  const updateDrawing=useCallback((pageId:string,drawing:Drawing,previous?:Drawing)=>{
    if(!draft.current||!account.current||storedOwner.current!==account.current)return;
    const page=draft.current.pages.find(value=>value.id===pageId);
    if(!page)return;
    try {
      const merged=previous?mergeSharedDrawing(previous,drawing,page):drawing;
      update(board=>({...board,pages:board.pages.map(value=>value.id===pageId?{...value,...merged}:value)}));
    } catch(cause) {
      if(!(cause instanceof BoardConflict))throw cause;
      draft.current={...draft.current,pages:draft.current.pages.map(value=>value.id===pageId?{...value,...drawing}:value)};
      blocked.current=true;setConflict(true);setError(cause.message);
      if(timer.current)clearTimeout(timer.current);publishView();
    }
  },[update,publishView]);
  const refresh=useCallback(async()=>{
    await flush();
    const saved=base.current,version=epoch.current,expectedOwner=account.current;
    if(!saved||!draft.current)return;
    const latest=await boardRequest<SharedSnapshot>('/'+saved.board.id);
    if(version!==epoch.current||expectedOwner!==account.current||base.current!==saved||!draft.current)throw new Error('The board changed. Try again.');
    draft.current=mergeSharedBoard(saved.board,draft.current,latest.board);base.current=latest;publishView();
  },[flush,publishView]);
  const getSnapshot=useCallback(()=>base.current&&draft.current?{...base.current,board:draft.current}:null,[]);
  const open=useCallback(async(id:string|null)=>{
    const version=++navigation.current, owner=account.current;await flush();
    if(version!==navigation.current||owner!==account.current)throw new Error('The board or account changed. Open the board again.');
    writeLocation(id);setRoute({id,token:null});
  },[flush]);
  const publish=useCallback(async(board:Board)=>{
    const version=epoch.current, expectedOwner=account.current;const result=await boardRequest<SharedSnapshot>('',{method:'POST',body:JSON.stringify({board})});
    if(version!==epoch.current||expectedOwner!==account.current)throw new Error('Your account changed. Open the board again.');
    storedOwner.current=expectedOwner;base.current=result;draft.current=result.board;publishView();writeLocation(result.board.id);setRoute({id:result.board.id,token:null});return result;
  },[publishView]);
  const reload=useCallback(()=>{const id=route.id;if(!id)return;const version=epoch.current, expectedOwner=account.current;setBusy(true);const request=route.token?boardRequest<SharedSnapshot>('/join',{method:'POST',body:JSON.stringify({boardId:id,token:route.token})}):boardRequest<SharedSnapshot>('/'+id);void request.then(result=>{if(version!==epoch.current||expectedOwner!==account.current)return;base.current=result;draft.current=result.board;blocked.current=false;setConflict(false);setError('');setBusy(false);publishView();if(route.token){writeLocation(id);setRoute({id,token:null});}}).catch(cause=>{if(version===epoch.current&&expectedOwner===account.current){setError(cause.message);setBusy(false);}});},[route.id,route.token,publishView]);
  const snapshot=view.owner===owner?view.snapshot:null;
  return {board:snapshot?.board||null,role:snapshot?.role,boardId:route.id,protectedObjects:snapshot?.protectedObjects||[],boards:owner&&view.owner===owner?boards:[],error,busy,conflict,update,updateDrawing,flush,open,publish,reload,refreshList,refresh,getSnapshot};
}
