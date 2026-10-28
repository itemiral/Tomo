'use client';

import { useEffect, useRef } from 'react';
import { Check, FileText, Pencil } from 'lucide-react';
import type { Board, CardData } from '@/lib/muse/types';

function EditableText({ text, label, change, start, className = '' }: { text: string; label: string; change: (text: string) => void; start: () => void; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const changed = useRef(false);
  useEffect(() => {
    if (element.current && document.activeElement !== element.current && element.current.textContent !== text) element.current.textContent = text;
  }, [text]);
  return <div ref={element} role="textbox" aria-label={label} contentEditable suppressContentEditableWarning className={`muse-editable ${className}`} onFocus={() => { changed.current = false; }} onInput={event => { if (!changed.current) { start(); changed.current = true; } change(event.currentTarget.textContent || ''); }} onBlur={event => { if (!event.currentTarget.textContent?.trim()) change(text); }}/ >;
}

export function PlanView({ board, edit, toggle, update, record }: { board: Board; edit: (id: string) => void; toggle: (id: string, item: string) => void; update: (id: string, data: Partial<CardData>) => void; record: () => void }) {
  const sections = board.nodes.filter(node => !['heading', 'agent'].includes(node.data.kind) && node.id !== 'user-brief');
  const brief = board.nodes.find(node => node.id === 'user-brief');
  return <article className="muse-plan-surface" aria-label="Readable plan">
    <div className="muse-document-titlebar"><span><FileText size={14}/>Plan</span><span>Click any text to edit</span></div>
    <div className="muse-document-scroll">
      <header><h1>{sections.length ? board.title : 'The brief'}</h1>{brief && <details className="muse-plan-brief" open={!sections.length}><summary>Your direction</summary><EditableText start={record} text={brief.data.body} label="Edit your direction" change={body => update(brief.id, { body })}/></details>}</header>
      {!sections.length && brief && <div className="muse-plan-start" data-plan-section={brief.id}><span className="muse-activity-pulse"/>Your team is preparing the outline.</div>}
      {sections.map((node, index) => <section key={node.id} data-plan-section={node.id} className="muse-plan-section">
        <div className="muse-plan-section-heading"><span className="muse-plan-number">{String(index + 1).padStart(2, '0')}</span><EditableText start={record} text={node.data.title} label={`Edit title: ${node.data.title}`} className="muse-plan-section-title" change={title => update(node.id, { title })}/><button aria-label={`Edit ${node.data.title}`} title="Edit this section" onClick={() => edit(node.id)}><Pencil size={13}/></button></div>
        {node.data.body && <EditableText start={record} text={node.data.body} label={`Edit details: ${node.data.title}`} className="muse-plan-body" change={body => update(node.id, { body })}/>}
        {!!node.data.items.length && <ul className={node.data.kind === 'checklist' ? 'muse-plan-checklist' : 'muse-plan-points'}>{node.data.items.map((item, i) => <li key={`${node.id}-${i}`}>
          {node.data.kind === 'checklist' && <button className="muse-plan-check" role="checkbox" aria-label={item} aria-checked={node.data.checked.includes(item)} onClick={() => toggle(node.id, item)}>{node.data.checked.includes(item) && <Check size={12}/>}</button>}
          <EditableText start={record} text={item} label={`Edit item ${i + 1}: ${node.data.title}`} change={text => { const items = [...node.data.items]; items[i] = text; update(node.id, { items, checked: node.data.checked.map(value => value === item ? text : value) }); }}/>
        </li>)}</ul>}
      </section>)}
    </div>
  </article>;
}
