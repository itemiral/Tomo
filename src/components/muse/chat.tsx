'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, X } from 'lucide-react';
import { MuseMarkdown, museRequest, RequestError, type MuseProfile } from './shared';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';

type Message = { id: string; role: 'user' | 'assistant'; content: string };
type Props = { attachImage: (file: File, signal: AbortSignal) => Promise<void>; expand: () => void; beforeSend?: () => Promise<void>; profile: MuseProfile; thread: string; boardContext: string; hidden: boolean; close: () => void; locked: () => void; onThinking: (busy: boolean) => void; applyActions: (actions: MuseActions) => MuseApplyResult };
export function MuseChat({ attachImage, expand, beforeSend, profile, thread, boardContext, hidden, close, locked, onThinking, applyActions }: Props) {
  const [messages, setMessages] = useState<Message[]>([]), [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [pending, setPending] = useState(''), [applied, setApplied] = useState<Record<string, MuseApplyResult>>({});
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
  async function send() {
    if (busy || imageBusy || !text.trim() || !ready) return;
    const message = text.trim(); setBusy(true); setError(''); setText(''); setPending(message); onThinking(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      await beforeSend?.(); expand();
      const result = await museRequest<{ messages: Message[]; actions: MuseActions }>('chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread, board: boardContext, message }), signal: abort.signal });
      if (mounted.current && !abort.signal.aborted) {
        setMessages(result.messages); onThinking(false);
        if (result.actions.cards.length || result.actions.updates.length || result.actions.images?.length) {
          const applied = applyActions({...result.actions,layout:/\b(align(?:ed)?|grid|table|timeline|kanban|rows?|columns?)\b/i.test(message)?'aligned':'organic'}), id = result.messages.at(-1)!.id;
          setApplied(values => ({ ...values, [id]: applied }));
        }
      }
    } catch (cause) {
      if (abort.signal.aborted || !mounted.current) return;
      onThinking(false); setText(message);
      if (cause instanceof RequestError && cause.status === 401) locked(); else setError((cause as Error).message);
    } finally { if (mounted.current && controller.current === abort) { setBusy(false); setPending(''); } }
  }
  async function image(file: File) {
    if (imageController.current) return;
    const abort = new AbortController(); imageController.current = abort; setImageBusy(true); setError('');
    try { await attachImage(file, abort.signal); }
    catch (cause) { if (mounted.current && !abort.signal.aborted) { expand(); setError((cause as Error).message); } }
    finally { if (imageController.current === abort) { imageController.current = null; if (mounted.current && !abort.signal.aborted) setImageBusy(false); } }
  }
  return <aside className={"muse-chat" + (hidden ? " collapsed" : "")} aria-label="Chat with Muse" data-muse-ui="true" onKeyDown={event => event.stopPropagation()}>
    <header hidden={hidden}><div><strong>{profile.muse.name}</strong><span>{busy ? 'Thinking…' : 'Here with you'}</span></div><button aria-label="Close Muse chat" onClick={close}><X size={18}/></button></header>
    <div hidden={hidden} className="muse-chat-messages" aria-live="polite">{!messages.length && !pending && <p className="muse-chat-intro">What would you like to work on?</p>}{messages.map(message => <div className={'muse-message ' + message.role} key={message.id}><MuseMarkdown text={message.content}/>{!!applied[message.id]?.skipped && <div className="muse-applied" role="status"><span>Kept {applied[message.id].skipped} card{applied[message.id].skipped === 1 ? '' : 's'} you changed or locked.</span></div>}</div>)}{pending && <div className="muse-message user"><MuseMarkdown text={pending}/></div>}{busy && <div className="muse-chat-thinking" role="status"><i/><i/><i/><span>Muse is thinking</span></div>}<div ref={tail}/></div>
    {busy && <button type="button" onClick={()=>{controller.current?.abort();controller.current=null;setBusy(false);setPending('');onThinking(false);}}>Stop response</button>}
    {error && <p className="muse-chat-error" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <button type="button" className="muse-chat-attach" aria-label="Attach image" title={imageBusy ? 'Attaching image…' : 'Attach image'} disabled={imageBusy || busy} aria-busy={imageBusy} onClick={() => imageInput.current?.click()}><Plus size={18}/></button>
      <input ref={imageInput} type="file" hidden aria-label="Choose image attachment" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void image(file); }}/>
      <textarea ref={input} rows={1} onFocus={expand} aria-label="Message Muse" value={text} maxLength={8000} disabled={busy || !ready} placeholder="A thought, a question…" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button aria-label="Send to Muse" disabled={!text.trim() || busy || imageBusy || !ready}><ArrowUp size={17}/></button>
    </form>
  </aside>;
}
