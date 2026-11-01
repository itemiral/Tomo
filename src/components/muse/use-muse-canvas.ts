"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { museRequest } from './shared';
import type { Board } from '../muze/storage';
type Snapshot = { name?:string; ownerId?:string; board:Board; revision:string; notes:{soul:string;memory:string} };
export function useMuseCanvas(owner?:string) {
  const [board,setBoard]=useState<Board|null>(null),[status,setStatus]=useState(''),[error,setError]=useState('');
  const currentBoard=useRef<Board|null>(null);
  const snapshot=useRef<Snapshot|null>(null),pending=useRef<Board|null>(null),running=useRef<Promise<void>|null>(null),generation=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const flush=useCallback(async()=>{
    if(timer.current)clearTimeout(timer.current);
    if(running.current) {await running.current;if(pending.current) return flush();return;}
    const epoch=generation.current;
    const work=async()=>{
      while(pending.current && snapshot.current && epoch===generation.current) {
        const next=pending.current;pending.current=null;setStatus('Saving…');setError('');
        try {const result=await museRequest<Omit<Snapshot,'board'>>('canvas',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot.current,board:next})});if(epoch!==generation.current)return;snapshot.current={board:next,ownerId:snapshot.current.ownerId,...result};if(result.name){const named={...next,museName:result.name};currentBoard.current=named;setBoard(named);}if(result.name)window.dispatchEvent(new CustomEvent('muse-name-saved',{detail:{name:result.name,ownerId:snapshot.current.ownerId}}));}
        catch(e) {if(epoch===generation.current){pending.current ||= next;setStatus('Not saved');setError((e as Error).message);}throw e;}
      }
      if(epoch===generation.current)setStatus('Saved');
    };
    const task=work();running.current=task;
    try {await task;} finally {if(running.current===task)running.current=null;}
  },[]);
  useEffect(()=>{
    const epoch=++generation.current,controller=new AbortController();snapshot.current=null;pending.current=null;running.current=null;currentBoard.current=null;setBoard(null);setError('');setStatus(owner?'Opening…':'');
    if(owner) void museRequest<Snapshot>('canvas',{signal:controller.signal}).then(value=>{if(epoch===generation.current){snapshot.current={...value,ownerId:owner};currentBoard.current=value.board;setBoard(value.board);setStatus('Saved');}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>{controller.abort();generation.current++;if(timer.current)clearTimeout(timer.current);};
  },[owner]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(pending.current||running.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  const update=useCallback((change:(board:Board)=>Board)=>{const current=currentBoard.current;if(!current)return;const next=change(current);currentBoard.current=next;setBoard(next);pending.current=next;setStatus('Saving…');if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void flush().catch(()=>{}),350);},[flush]);
  return {board,status,error,update,flush};
}
