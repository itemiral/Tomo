'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, FilePlus2, Pencil, X } from 'lucide-react';
import { MuseIcon, MuseMarkdown, museRequest, RequestError, type MuseProfile } from './shared';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';

type Message = { id: string; role: 'user' | 'assistant'; content: string };
type Props = { profile: MuseProfile; thread: string; boardContext: string; hidden: boolean; close: () => void; edit: () => void; locked: () => void; addToBoard: (text: string) => void; onThinking: (busy: boolean) => void; applyActions: (actions: MuseActions) => MuseApplyResult };
export function MuseChat({ profile, thread, boardContext, hidden, close, edit, locked, addToBoard, onThinking, applyActions }: Props) {
  const [messages, setMessages] = useState<Message[]>([]), [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [pending, setPending] = useState(''), [applied, setApplied] = useState<Record<string, MuseApplyResult>>({});
  const controller = useRef<AbortController | null>(null), tail = useRef<HTMLDivElement>(null), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void museRequest<{ messages: Message[] }>('chat?thread=' + encodeURIComponent(thread), { signal: abort.signal }).then(result => { if (mounted.current) { setMessages(result.messages); setReady(true); } }).catch(cause => { if (abort.signal.aborted) return; if (cause instanceof RequestError && cause.status === 401) locked(); else { setError(cause.message); setReady(true); } });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); onThinking(false); };
  }, [thread, locked, onThinking]);
  useEffect(() => { tail.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);
  async function send() {
    if (busy || !text.trim() || !ready) return;
    const message = text.trim(); setBusy(true); setError(''); setText(''); setPending(message); onThinking(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await museRequest<{ messages: Message[]; actions: MuseActions }>('chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread, board: boardContext, message }), signal: abort.signal });
      if (mounted.current && !abort.signal.aborted) {
        setMessages(result.messages); onThinking(false);
        if (result.actions.cards.length || result.actions.updates.length) {
          const applied = applyActions(result.actions), id = result.messages.at(-1)!.id;
          setApplied(values => ({ ...values, [id]: applied }));
        }
      }
    } catch (cause) {
      if (abort.signal.aborted || !mounted.current) return;
      onThinking(false); setText(message);
      if (cause instanceof RequestError && cause.status === 401) locked(); else setError((cause as Error).message);
    } finally { if (mounted.current) { setBusy(false); setPending(''); } }
  }
  return <aside className="muse-chat" hidden={hidden} aria-label="Chat with Muse" data-muse-ui="true" onKeyDown={event => event.stopPropagation()}>
    <header><MuseIcon profile={profile}/><div><strong>Muse</strong><span>{busy ? 'Thinking…' : 'Here with you'}</span></div><button aria-label="Edit my Muse" title="Edit my Muse" onClick={edit}><Pencil size={16}/></button><button aria-label="Close Muse chat" onClick={close}><X size={18}/></button></header>
    <div className="muse-chat-messages" aria-live="polite">{!messages.length && !pending && <p className="muse-chat-intro">What would you like to work on?</p>}{messages.map(message => <div className={'muse-message ' + message.role} key={message.id}><MuseMarkdown text={message.content}/>{applied[message.id] ? <div className="muse-applied" role="status">{!!applied[message.id].ids.length && <span><Check size={12}/>Updated your board · Undo available</span>}{!!applied[message.id].skipped && <span>Kept {applied[message.id].skipped} card{applied[message.id].skipped === 1 ? '' : 's'} you changed or locked.</span>}</div> : message.role === 'assistant' && <button className="muse-add-reply" onClick={() => addToBoard(message.content)}><FilePlus2 size={13}/>Add to board</button>}</div>)}{pending && <div className="muse-message user"><MuseMarkdown text={pending}/></div>}{busy && <div className="muse-chat-thinking" role="status"><i/><i/><i/><span>Muse is thinking</span></div>}<div ref={tail}/></div>
    {error && <p className="muse-chat-error" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}><textarea aria-label="Message Muse" value={text} maxLength={8000} disabled={busy || !ready} placeholder="Ask about your whiteboard…" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button aria-label="Send to Muse" disabled={!text.trim() || busy || !ready}><ArrowUp size={17}/></button></form>
  </aside>;
}
