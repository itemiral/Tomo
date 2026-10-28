'use client';

import { createContext, useContext, type CSSProperties } from 'react';
import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { AGENTS, type AgentId, type MuseNode } from '@/lib/muse/types';

export const BoardActions = createContext<{
  edit: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  toggle: (id: string, item: string) => void;
  ask: (agent: AgentId) => void;
  read: (id: string) => void;
  working: AgentId | null;
}>({ edit() {}, duplicate() {}, remove() {}, toggle() {}, ask() {}, read() {}, working: null });

export function MuseGlyph({ agent, className = '' }: { agent?: AgentId; className?: string }) {
  return <span className={`muse-glyph ${agent || 'all'} ${className}`} aria-hidden="true">
    <svg viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="17" fill="currentColor"/>
      <rect x="13" y="16" width="4" height="9" rx="2" fill="#202124"/>
      <rect x="23" y="16" width="4" height="9" rx="2" fill="#202124"/>
    </svg>
  </span>;
}

export function MuseCard({ id, data, selected }: NodeProps<MuseNode>) {
  const actions = useContext(BoardActions);
  const agent = data.agent ? AGENTS[data.agent] : undefined;
  if (data.kind === 'heading') return <div className="muse-board-heading" onDoubleClick={() => actions.edit(id)}>
    <span>{data.eyebrow || 'A SPACE FOR YOUR NEXT IDEA'}</span>
    <h1>{data.title}</h1><p>{data.body}</p>
  </div>;
  if (data.kind === 'agent' && data.agent) return <div className={`muse-agent-node ${actions.working === data.agent ? 'is-working' : ''}`} style={{ '--agent-color': agent?.color } as CSSProperties}>
    <div className="muse-agent-aura"/>
    <MuseGlyph agent={data.agent}/>
    <div className="muse-agent-identity"><div><strong>{agent?.name}</strong><span className="muse-agent-label">MUSE</span></div><p>{actions.working === data.agent ? 'Thinking with you…' : data.body}</p></div>
    <button className="nodrag muse-agent-ask" aria-label={`Talk to ${agent?.name}`} title={`Talk to ${agent?.name}`} onClick={() => actions.ask(data.agent!)}><ArrowUpRight size={17}/></button>
    <Handle type="source" position={Position.Bottom}/>
  </div>;
  return <>
    <NodeToolbar isVisible={selected} position={Position.Top} className="muse-node-toolbar">
      <button aria-label="Edit card" title="Edit card" onClick={() => actions.edit(id)}><Pencil size={14}/></button>
      <button aria-label="Duplicate card" title="Duplicate card" onClick={() => actions.duplicate(id)}><Copy size={14}/></button>
      <button aria-label="Delete card" title="Delete card" onClick={() => actions.remove(id)}><Trash2 size={14}/></button>
    </NodeToolbar>
    <article className={`muse-card kind-${data.kind} color-${data.color} ${selected ? 'is-selected' : ''}`} onDoubleClick={() => actions.edit(id)}>
      <Handle type="target" position={Position.Left}/>
      {data.kind === 'photo' && data.image && <div className="muse-card-image"><img draggable={false} src={`/muse/${data.image}.webp`} alt={data.image === 'kyoto' ? 'A quiet street and traditional pagoda in Kyoto' : 'A shrine in Kyoto'}/><span>{data.eyebrow || 'INSPIRATION'}</span></div>}
      <div className="muse-card-content">
        {data.kind !== 'photo' && <div className="muse-card-eyebrow">{data.eyebrow || (data.kind === 'checklist' ? 'THE NEXT STEPS' : data.kind === 'text' ? 'THE OUTLINE' : 'A THOUGHT')}<span className="muse-card-dot" style={{ background: agent?.color || '#777' }}/></div>}
        <h2>{data.title}</h2>
        {data.body && <p>{data.body.length > 165 ? `${data.body.slice(0, 162)}…` : data.body}</p>}
        {data.items.length > 0 && (data.kind === 'checklist' ? <ul className="muse-checklist">{data.items.slice(0, 3).map((item, index) => <li key={`${index}-${item}`}><button className="nodrag" role="checkbox" aria-checked={data.checked.includes(item)} onClick={() => actions.toggle(id, item)}><span className="muse-check-box">{data.checked.includes(item) && <Check size={11}/>}</span><span>{item.length > 75 ? `${item.slice(0, 72)}…` : item}</span></button></li>)}</ul> : <ol className="muse-outline">{data.items.slice(0, 3).map((item, index) => <li key={`${index}-${item}`}><span>{String(index + 1).padStart(2, '0')}</span>{item.length > 75 ? `${item.slice(0, 72)}…` : item}</li>)}</ol>)}
        <button className="muse-read-section nodrag" onClick={() => actions.read(id)}>Read in plan<ArrowUpRight size={11}/></button>
        {agent && <div className="muse-card-signature"><span style={{ background: agent.color }}/>{agent.name}</div>}
      </div>
      <Handle type="source" position={Position.Right}/>
    </article>
  </>;
}

export const museNodeTypes = { muse: MuseCard };
