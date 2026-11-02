"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { museRequest } from './shared';
import type { Board } from '../muze/storage';
import { reconcileMuseNameSave } from '@/lib/muse-name';
import { reconcileMuseCanvas, type MuseCanvasSnapshot as Snapshot } from '@/lib/muse-canvas-sync';
type Options = { active?: boolean; canReceiveChanges?: () => boolean };
export function useMuseCanvas(owner?:string, options:Options={}) {
  const [board,setBoard]=useState<Board|null>(null),[status,setStatus]=useState(''),[error,setError]=useState('');
  const [refreshVersion,setRefreshVersion]=useState(0);
  const settings=useRef(options);settings.current=options;
  const currentBoard=useRef<Board|null>(null);
  const snapshot=useRef<Snapshot|null>(null),pending=useRef<Board|null>(null),running=useRef<Promise<void>|null>(null),generation=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const refreshNeeded=useRef(false),refreshSequence=useRef(0),refreshing=useRef<Promise<void>|null>(null);
  const refresh=useCallback(async()=>{
    if(refreshing.current){await refreshing.current;return;}
    const epoch=generation.current;
    const work=async()=>{
      if(running.current)await running.current;
      // A focused document can contain a draft that has not reached the canvas
      // snapshot yet. Wait for its edit/drag to finish before rebasing anything.
      while(epoch===generation.current&&settings.current.canReceiveChanges?.()===false)await new Promise(resolve=>setTimeout(resolve,100));
      while(epoch===generation.current&&refreshNeeded.current){
        const base=snapshot.current,sequence=refreshSequence.current;
        if(!base)return;
        const result=await museRequest<Snapshot>('canvas');
        if(epoch!==generation.current||!currentBoard.current)return;
        while(epoch===generation.current&&settings.current.canReceiveChanges?.()===false)await new Promise(resolve=>setTimeout(resolve,100));
        if(epoch!==generation.current||!currentBoard.current)return;
        if(snapshot.current!==base)continue;
        const next=reconcileMuseCanvas(base.board,currentBoard.current,result.board);
        snapshot.current={...result,ownerId:base.ownerId};currentBoard.current=next;
        if(pending.current)pending.current=next;
        refreshNeeded.current=sequence!==refreshSequence.current;setBoard(next);setRefreshVersion(value=>value+1);setError('');
      }
    };
    const task=work();refreshing.current=task;
    try{await task;}finally{if(refreshing.current===task)refreshing.current=null;}
  },[]);
  const flush=useCallback(async()=>{
    if(timer.current)clearTimeout(timer.current);
    if(refreshNeeded.current){await refresh();}
    if(running.current) {await running.current;if(pending.current) return flush();return;}
    const epoch=generation.current;
    const work=async()=>{
      while(pending.current && snapshot.current && epoch===generation.current) {
        const next=pending.current;pending.current=null;setStatus('Saving…');setError('');
        try {
          const result=await museRequest<Omit<Snapshot,'board'>>('canvas',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot.current,board:next})});
          if(epoch!==generation.current)return;
          snapshot.current={board:reconcileMuseNameSave(next,next,result),ownerId:snapshot.current.ownerId,...result};
          const latest=currentBoard.current;
          if(latest){const reconciled=reconcileMuseNameSave(latest,next,result);currentBoard.current=reconciled;setBoard(reconciled);if(pending.current===latest)pending.current=reconciled;}
          if(result.name)window.dispatchEvent(new CustomEvent('muse-name-saved',{detail:{name:result.name,ownerId:snapshot.current.ownerId}}));
        }
        catch(e) {if(epoch===generation.current){pending.current ||= next;setStatus('Not saved');setError((e as Error).message);}throw e;}
      }
      if(epoch===generation.current)setStatus('Saved');
    };
    const task=work();running.current=task;
    try {await task;} finally {if(running.current===task)running.current=null;}
  },[refresh]);
  useEffect(()=>{
    const epoch=++generation.current,controller=new AbortController();snapshot.current=null;pending.current=null;running.current=null;refreshing.current=null;refreshNeeded.current=false;currentBoard.current=null;setBoard(null);setError('');setStatus(owner?'Opening…':'');
    if(owner) void museRequest<Snapshot>('canvas',{signal:controller.signal}).then(value=>{if(epoch===generation.current){snapshot.current={...value,ownerId:owner};currentBoard.current=value.board;setBoard(value.board);setStatus('Saved');}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>{controller.abort();generation.current++;if(timer.current)clearTimeout(timer.current);};
  },[owner]);
  useEffect(()=>{
    if(!owner)return;
    const changed=(event:Event)=>{
      if((event as CustomEvent<{ownerId?:string}>).detail?.ownerId!==owner)return;
      const epoch=generation.current;refreshNeeded.current=true;refreshSequence.current++;
      void refresh().then(()=>epoch===generation.current&&pending.current?flush():undefined).catch(cause=>{if(epoch===generation.current)setError((cause as Error).message);});
    };
    window.addEventListener('muse-personalization-updated',changed);
    return()=>window.removeEventListener('muse-personalization-updated',changed);
  },[owner,refresh,flush]);
  useEffect(()=>{
    if(!owner||!options.active)return;
    const epoch=generation.current;refreshNeeded.current=true;refreshSequence.current++;
    void refresh().catch(cause=>{if(epoch===generation.current)setError((cause as Error).message);});
  },[owner,options.active,refresh]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(pending.current||running.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  const update=useCallback((change:(board:Board)=>Board)=>{const current=currentBoard.current;if(!current)return;const next=change(current);currentBoard.current=next;setBoard(next);pending.current=next;setStatus('Saving…');if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void flush().catch(()=>{}),350);},[flush]);
  return {board,status,error,update,flush,refreshVersion};
}
