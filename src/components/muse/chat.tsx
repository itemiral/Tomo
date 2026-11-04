'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, X } from 'lucide-react';
import { MuseMarkdown, museRequest, RequestError, type MuseProfile } from './shared';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';
import { museProgressLabel, type MusePreparedContext, type MuseProgress } from '@/lib/muse-request';
import { sendMuseChat } from './chat-request';
import {museRequestLease} from './request-lease';
import {MUSE_SCENE_CHANGED} from '@/lib/shared-board-leases';

type Message = { id: string; role: 'user' | 'assistant'; content: string };
type Props = { attachImage: (file: File, signal: AbortSignal) => Promise<void>; expand: () => void; beforeSend?: () => Promise<void>; prepareContext?:(message?:string,signal?:AbortSignal)=>Promise<string|MusePreparedContext>; selectedIds?:string[]; profile: MuseProfile; thread: string; boardContext: string; hidden: boolean; close: () => void; locked: () => void; onThinking: (busy: boolean, selectedIds?:string[],phase?:MuseProgress) => void; applyActions: (actions: MuseActions) => MuseApplyResult };
export function MuseChat({ attachImage, expand, beforeSend, prepareContext, selectedIds=[], profile, thread, boardContext, hidden, close, locked, onThinking, applyActions }: Props) {
  const [messages, setMessages] = useState<Message[]>([]), [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [pending, setPending] = useState(''), [applied, setApplied] = useState<Record<string, MuseApplyResult>>({});
  const [suggestions,setSuggestions]=useState<string[]>([]);
  const [phase,setPhase]=useState<MuseProgress>('context');
  const selectionKey=JSON.stringify([...selectedIds].sort()),selectionLabel=selectedIds.length===1?'1 selected item':`${selectedIds.length} selected items`;
  const currentSelection=useRef(selectionKey);currentSelection.current=selectionKey;
  useEffect(()=>{setSuggestions([]);},[selectionKey]);
  const [imageBusy, setImageBusy] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null), imageController = useRef<AbortController | null>(null);
  useEffect(() => () => imageController.current?.abort(), [thread]);
  const input=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{const element=input.current;if(!element)return;const resize=()=>{element.style.height='0px';element.style.height=Math.min(126,Math.max(38,element.scrollHeight))+'px';element.style.overflowY=element.scrollHeight>126?'auto':'hidden';};resize();const observer=new ResizeObserver(resize);observer.observe(element.parentElement!);return()=>observer.disconnect();},[text,hidden]);
  const controller = useRef<AbortController | null>(null), tail = useRef<HTMLDivElement>(null), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void museRequest<{ messages: Message[] }>('chat?thread=' + encodeURIComponent(thread), { signal: abort.signal }).then(result => { if (mounted.current) { setMessages(result.messages); setReady(true); } }).catch(cause => { if (abort.signal.aborted) return; if (cause instanceof RequestError && cause.status === 401) locked(); else { setError(cause.message); setReady(true); } });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); onThinking(false); };
  }, [thread, locked, onThinking]);
  useEffect(() => { tail.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);
  async function send(suggestion?:string) {
    const message=(suggestion??text).trim();
    if (controller.current || busy || imageBusy || !message || !ready) return;
    setBusy(true); setError(''); setText(''); setPending(message); setSuggestions([]); setPhase('context'); onThinking(true,selectedIds,'context');
    const abort = new AbortController(); controller.current = abort;
    let lease: ReturnType<typeof museRequestLease> | undefined;
    try {
      let packet: MusePreparedContext = {board: boardContext}, requestFocus: string[] = [];
      let result!: {messages: Message[]; actions: MuseActions; suggestions?: string[]; personalizationUpdated?: boolean};
      for(let attempt=0;attempt<2;attempt++) {
        let prepared: string | MusePreparedContext = boardContext;
        if(prepareContext)prepared=await prepareContext(message,abort.signal);else await beforeSend?.();
        if(!mounted.current||abort.signal.aborted)return;
        packet = typeof prepared === 'string' ? {board:prepared} : prepared;
        const focus=JSON.parse(packet.board).selectedIds;
        requestFocus=Array.isArray(focus)?focus.filter((id:unknown):id is string=>typeof id==='string'):[];
        const workingIds = requestFocus.length ? requestFocus : packet.anchorIds || [];
        onThinking(true,workingIds,'context');expand();
        const requestId=packet.sharedBoardId?crypto.randomUUID():undefined;
        lease=packet.sharedBoardId&&requestId?museRequestLease(packet.sharedBoardId,requestId,abort.signal):undefined;
        try {
          result = await sendMuseChat({thread,board:packet.board,project:packet.project,images:packet.images,message,sharedBoardId:packet.sharedBoardId,requestId},abort.signal,phase=>{if(mounted.current&&!abort.signal.aborted){setPhase(phase);onThinking(true,workingIds,phase);}});
          break;
        } catch(cause) {
          await lease?.release();lease=undefined;
          if(attempt===0&&packet.sharedBoardId&&cause instanceof RequestError&&cause.status===409&&cause.message===MUSE_SCENE_CHANGED)continue;
          throw cause;
        }
      }
      if (mounted.current && !abort.signal.aborted) {
        setMessages(result.messages); onThinking(false);
        if (result.actions.cards.length || result.actions.updates.length || result.actions.images?.length) {
          const applied = applyActions({...result.actions,focusIds:requestFocus,anchorIds:packet.anchorIds,layout:/\b(align(?:ed)?|grid|table|timeline|kanban|rows?|columns?)\b/i.test(message)?'aligned':'organic'}), id = result.messages.at(-1)!.id;
          setApplied(values => ({ ...values, [id]: applied }));
        }
        await packet.complete?.();
        if(currentSelection.current===JSON.stringify([...requestFocus].sort()))setSuggestions(Array.isArray(result.suggestions)?[...new Set(result.suggestions.filter(value=>typeof value==='string'&&value.trim()&&value.length<=100).map(value=>value.trim()))].slice(0,2):[]);
        if(result.personalizationUpdated)window.dispatchEvent(new CustomEvent('muse-personalization-updated',{detail:{ownerId:profile.ownerId}}));
      }
    } catch (cause) {
      if (abort.signal.aborted || !mounted.current) return;
      onThinking(false); setText(message);
      if (cause instanceof RequestError && cause.status === 401) locked(); else setError((cause as Error).message);
    } finally { await lease?.release(); if (mounted.current && controller.current === abort) { controller.current=null;setBusy(false); setPending(''); } }
  }
  async function image(file: File) {
    if (imageController.current) return;
    const abort = new AbortController(); imageController.current = abort; setImageBusy(true); setError('');
    try { await attachImage(file, abort.signal); }
    catch (cause) { if (mounted.current && !abort.signal.aborted) { expand(); setError((cause as Error).message); } }
    finally { if (imageController.current === abort) { imageController.current = null; if (mounted.current && !abort.signal.aborted) setImageBusy(false); } }
  }
  return <aside className={"muse-chat" + (hidden ? " collapsed" : "")} aria-label="Chat with Muse" data-muse-ui="true" onKeyDown={event => event.stopPropagation()}>
    <header hidden={hidden}><div><strong>{profile.muse.name}</strong><span>{busy ? museProgressLabel[phase] : selectedIds.length?selectionLabel:'Here with you'}</span></div><button aria-label="Close Muse chat" onClick={close}><X size={18}/></button></header>
    <div hidden={hidden} className="muse-chat-messages" aria-live="polite">{!messages.length && !pending && <p className="muse-chat-intro">What would you like to work on?</p>}{messages.map(message => <div className={'muse-message ' + message.role} key={message.id}><MuseMarkdown text={message.content}/>{!!applied[message.id]?.skipped && <div className="muse-applied" role="status"><span>Kept {applied[message.id].skipped} card{applied[message.id].skipped === 1 ? '' : 's'} you changed or locked.</span></div>}</div>)}{pending && <div className="muse-message user"><MuseMarkdown text={pending}/></div>}{busy && <div className="muse-chat-thinking" role="status"><i/><i/><i/><span>{museProgressLabel[phase]}</span></div>}{!busy&&!text.trim()&&!!suggestions.length&&<div className="muse-next-moves" aria-label="Suggested next steps">{suggestions.map(value=><button key={value} type="button" disabled={imageBusy||!ready} onClick={()=>void send(value)}>{value}</button>)}</div>}<div ref={tail}/></div>
    {busy && <button type="button" onClick={()=>{controller.current?.abort();controller.current=null;setBusy(false);setPending('');onThinking(false);}}>Stop response</button>}
    {error && <p className="muse-chat-error" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <button type="button" className="muse-chat-attach" aria-label="Attach image" title={imageBusy ? 'Attaching image…' : 'Attach image'} disabled={imageBusy || busy} aria-busy={imageBusy} onClick={() => imageInput.current?.click()}><Plus size={18}/></button>
      <input ref={imageInput} type="file" hidden aria-label="Choose image attachment" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void image(file); }}/>
      <textarea ref={input} rows={1} onFocus={expand} aria-label="Message Muse" value={text} maxLength={8000} disabled={busy || !ready} placeholder={selectedIds.length?'Ask about your selection…':'A thought, a question…'} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button aria-label="Send to Muse" disabled={!text.trim() || busy || imageBusy || !ready}><ArrowUp size={17}/></button>
    </form>
  </aside>;
}
