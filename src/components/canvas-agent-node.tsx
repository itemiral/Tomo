'use client';

import { memo, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Check, CircleAlert, Clapperboard, Hand, Image, Layers, Lightbulb, Link, LoaderCircle, MessageSquare, Music, Palette, PencilLine, Search, Sparkles, Type, WandSparkles, Wrench, X } from 'lucide-react';
import type { Node, NodeProps } from '@xyflow/react';
import type { ChatActivity } from '@/lib/chat-activity';
import type { CanvasAgentState } from '@/lib/canvas-agent-state';
import { AgentAvatar } from './agent-avatar';
import './canvas-agent-node.css';
import './canvas-agent-states.css';

export const CANVAS_AGENT_PREFIX = 'chat-agent:';
export const CANVAS_AGENT_SIZE = { width: 96, height: 96 };
// A 10.4s staggered cycle keeps each idea visible for 1.3s, with gentle overlap.
const IDEA_CYCLE = 10.4;
const AGENT_IDEAS = [
  [Lightbulb, -42, -28, -60, -65, -22],
  [Sparkles, 28, -23, 48, -62, 20],
  [PencilLine, -9, -42, 2, -80, 16],
  [Image, -44, -1, -65, -34, -25],
  [Clapperboard, 31, -5, 54, -37, 26],
  [Music, -28, -40, -45, -74, -14],
  [Search, 17, -37, 34, -77, 21],
  [Link, -43, -16, -66, -50, -28],
  [Layers, 28, -30, 49, -70, 18],
  [WandSparkles, -3, -43, -16, -83, -16],
  [Type, -44, 4, -62, -22, -18],
  [Palette, 33, 2, 55, -30, 23],
] as const;
export type CanvasAgentData = {
  title: string;
  status: string;
  preview: string;
  activity: ChatActivity[];
  working: boolean;
  active: boolean;
  state: CanvasAgentState;
  noticeId?: string;
  noticeKey: string;
  viewing: boolean;
  onOpen: () => boolean;
  onHide: () => void;
};

export const CanvasAgentNode = memo(function CanvasAgentNode({ data, dragging }: NodeProps<Node<CanvasAgentData>>) {
  const t = (text: string, values: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
  const root = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const [dismissed, setDismissed] = useState(false);
  const [acknowledged, setAcknowledged] = useState({ key: '', notice: '' });
  const notice = `${data.noticeId ?? ''}:${data.state}`;
  useEffect(() => {
    let saved = '';
    try { saved = localStorage.getItem(data.noticeKey) ?? ''; } catch { /* Keep read state in this tab when storage is unavailable. */ }
    setAcknowledged({ key: data.noticeKey, notice: saved });
  }, [data.noticeKey]);
  const read = acknowledged.key === data.noticeKey && acknowledged.notice === notice;
  const state = read && data.state !== 'working' && data.state !== 'attention' ? 'idle' : data.state;
  const Badge = state === 'approval' ? Hand : state === 'input' ? MessageSquare : state === 'attention' ? CircleAlert : state === 'finished' ? Check : null;
  const [placement, setPlacement] = useState({ above: false, left: -97, width: 290, arrow: 145 });
  const reveal = () => {
    setDismissed(false);
    const bounds = root.current?.getBoundingClientRect();
    if (bounds) {
      const scale = bounds.width / CANVAS_AGENT_SIZE.width;
      const width = Math.min(290, (window.innerWidth - 32) / scale);
      const center = bounds.left + bounds.width / 2;
      const left = Math.max(16, Math.min(window.innerWidth - width * scale - 16, center - width * scale / 2));
      const below = window.innerHeight - bounds.bottom - 24;
      const above = bounds.top - 24;
      setPlacement({ above: (panel.current?.offsetHeight ?? 200) * scale + 12 > below && above > below,
        left: (left - bounds.left) / scale, width, arrow: Math.max(18, Math.min(width - 18, (center - left) / scale)) });
    }
  };
  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!data.onOpen()) return;
    setAcknowledged({ key: data.noticeKey, notice });
    try { localStorage.setItem(data.noticeKey, notice); } catch { /* The visible acknowledgment still applies in this tab. */ }
  };
  return <article ref={root} className="canvas-agent-node" data-working={data.working || undefined} data-active={data.active || undefined}
    data-state={state} data-acknowledged={data.viewing || read || undefined}
    data-dragging={dragging || undefined} data-dismissed={dismissed || undefined} data-above={placement.above || undefined}
    onPointerEnter={reveal} onFocusCapture={reveal}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDismissed(true); } }}>
    <button type="button" className="canvas-agent-open canvas-agent-drag-handle nopan" aria-label={t('Open conversation {title}', { title: data.title })} aria-describedby={panelId} onClick={open}>
      {data.working && <span className="canvas-agent-ideas" aria-hidden="true">
        {AGENT_IDEAS.map(([Icon, x, y, endX, endY, tilt], index) => <span key={index} className="canvas-agent-idea" style={{
          '--idea-x': `${x}px`, '--idea-y': `${y}px`,
          '--idea-end-x': `${x + (endX - x) * .8}px`, '--idea-end-y': `${y + (endY - y) * .8}px`,
          '--idea-tilt': `${tilt}deg`, '--idea-delay': `${-index * IDEA_CYCLE / AGENT_IDEAS.length - .12}s`,
          '--idea-size': `${15 + index % 4}px`,
        } as CSSProperties}><Icon strokeWidth={1.6}/></span>)}
      </span>}
      <AgentAvatar celebrate={state === 'finished'} followPointer={!dragging}/>
      {Badge && <span className="canvas-agent-badge" aria-label={t(data.status)}><Badge size={14} strokeWidth={2}/></span>}
    </button>
    <aside ref={panel} id={panelId} className="canvas-agent-process nodrag nopan nowheel" aria-label={t('Agent activity')}
      style={{ left: placement.left, width: placement.width, '--agent-card-arrow-x': `${placement.arrow}px` } as CSSProperties} onClick={event => event.stopPropagation()}>
      <div className="canvas-agent-heading">
        <strong className="canvas-agent-title">{data.title}</strong>
        <div className="canvas-agent-actions">
          <button type="button" className="canvas-agent-conversation" aria-label={t('Open conversation')} title={t('Open conversation')} onClick={open}><ArrowUpRight size={14}/></button>
          <button type="button" className="canvas-agent-hide" aria-label={t('Hide agent from canvas')} title={t('Hide agent from canvas')}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onHide(); }}><X size={13}/></button>
        </div>
      </div>
      <p className="canvas-agent-preview">{data.preview}</p>
      {!!data.activity.length && <ol className="canvas-agent-activity" aria-label={t('Recent steps')}>
        {data.activity.slice(-4).map(item => {
          const running = data.working && item.status === 'running';
          const Icon = item.status === 'failed' ? CircleAlert : item.kind === 'commentary' ? MessageSquare : running ? LoaderCircle : item.status === 'completed' ? Check : Wrench;
          return <li key={item.id} data-status={running ? 'running' : item.status}>
            <Icon size={13} aria-hidden="true" className={running ? 'canvas-agent-spinner' : undefined}/>
            <span>{item.kind === 'tool' ? t(item.text) : item.text}{item.detail && <small>{t(item.detail)}</small>}</span>
          </li>;
        })}
      </ol>}
    </aside>
  </article>;
});
