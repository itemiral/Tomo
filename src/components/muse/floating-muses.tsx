'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useViewport } from '@xyflow/react';
import { CanvasAgentNode } from '../canvas-agent-node';
import { AGENTS, type AgentId, type Board } from '@/lib/muse/types';
import { agentFootprint, clipRect, findAgentPosition, type Point, type Rect, type Size } from '@/lib/muse/agent-placement';

export const AGENT_ACTIVITY: Record<AgentId, string> = {
  planner: 'Shaping the shared outline…', explorer: 'Finding useful possibilities…',
  critic: 'Checking the gaps & assumptions…', organizer: 'Connecting the next steps…',
};
const CONTENT = '.muse-plan-surface, .react-flow__node';
const CHROME = '.muse-topbar > *, .muse-tools, .muse-bottom-controls, .muse-canvas-help, .muse-chat-dock, .muse-popover, .muse-work-status, .muse-toast, .muse-recovery, .muse-node-toolbar';
type Geometry = { size: Size; obstacles: Rect[]; targets: Rect[] };

export function FloatingMuses({ board, working, ask, running }: { board: Board; working: AgentId | null; ask: (agent: AgentId) => void; running: boolean }) {
  const viewport = useViewport();
  const layer = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);
  const [manual, setManual] = useState<Partial<Record<AgentId, Point>>>({});
  const [dragging, setDragging] = useState<AgentId | null>(null);
  const drag = useRef<{ agent: AgentId; pointerX: number; pointerY: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const releaseTimers = useRef(new Map<AgentId, ReturnType<typeof setTimeout>>());
  const [geometry, setGeometry] = useState<Geometry>({ size: { width: 1400, height: 900 }, obstacles: [], targets: [] });
  const measure = useCallback(() => {
    const root = layer.current?.closest('.muse-shell');
    if (!root) return;
    const size = { width: window.innerWidth, height: window.innerHeight };
    const screen = { x: 0, y: 0, ...size };
    const rectOf = (element: Element, bounds = screen) => clipRect(element.getBoundingClientRect(), bounds);
    const rectsOf = (selector: string) => Array.from(root.querySelectorAll(selector)).map(element => rectOf(element)).filter((rect): rect is Rect => !!rect);
    const plan = root.querySelector('.muse-document-scroll');
    const planBounds = plan && rectOf(plan);
    const sections = planBounds ? Array.from(plan!.querySelectorAll('[data-plan-section]')).map(element => rectOf(element, planBounds)).filter((rect): rect is Rect => !!rect) : [];
    const next = { size, obstacles: rectsOf(`${CONTENT}, ${CHROME}`), targets: [...(sections.length ? sections : rectsOf('.muse-plan-surface')), ...rectsOf('.react-flow__node')] };
    setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  // Screen coordinates change when panning even though the document's size does not.
  useLayoutEffect(measure, [measure, viewport.x, viewport.y, viewport.zoom, board.nodes]);
  useEffect(() => {
    const root = layer.current?.closest('.muse-shell');
    if (!root) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect(); resize.observe(root);
      root.querySelectorAll(`${CONTENT}, ${CHROME}`).forEach(element => resize.observe(element));
    };
    const mutation = new MutationObserver(records => {
      if (records.every(record => layer.current?.contains(record.target))) return;
      observe(); schedule();
    });
    observe(); schedule();
    mutation.observe(root, { childList: true, subtree: true });
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, [measure, board.id]);
  useEffect(() => {
    setPhase(0);
    for (const timer of releaseTimers.current.values()) clearTimeout(timer);
    releaseTimers.current.clear();
    // A new assignment releases parked agents, but never steals one being held.
    setManual(previous => { const held = drag.current?.agent; return held && previous[held] ? { [held]: previous[held] } : {}; });
    if (!working) return;
    const timer = setInterval(() => setPhase(value => value + 1), 5500);
    return () => clearInterval(timer);
  }, [working, running, board.id]);
  useEffect(() => {
    const timers = releaseTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); };
  }, []);
  const release = (agent: AgentId, delay = 1200) => {
    clearTimeout(releaseTimers.current.get(agent));
    releaseTimers.current.set(agent, setTimeout(() => {
      releaseTimers.current.delete(agent);
      setManual(value => { const next = { ...value }; delete next[agent]; return next; });
    }, delay));
  };
  const finishDrag = (agent: AgentId) => {
    if (drag.current?.agent !== agent) return;
    drag.current = null; setDragging(null);
    release(agent);
  };
  const { size, obstacles, targets } = geometry;
  const compact = size.width < 700;
  const roles = Object.keys(AGENTS) as AgentId[];
  const homeStart = compact ? Math.max(0, (size.width - 350) / 2) : Math.max(120, (size.width - 460) / 2 - 90);
  const homeGap = compact ? 84 : 115;
  const homes = roles.map((_, index) => ({ x: homeStart + index * homeGap, y: compact ? 85 : 81 }));
  const positions: Partial<Record<AgentId, Point | null>> = { ...manual };
  const occupied = [...obstacles, ...roles.filter(agent => manual[agent]).map(agent => agentFootprint(manual[agent]!, working === agent, compact))];
  // Reserve every waiting agent's space before placing the one at work.
  for (const agent of [...roles.filter(role => role !== working), ...(working ? [working] : [])]) {
    if (manual[agent]) continue;
    const active = working === agent;
    const point = findAgentPosition({ preferred: homes[roles.indexOf(agent)], target: active && targets.length ? targets[phase % targets.length] : undefined, obstacles: occupied, size, active, compact });
    positions[agent] = point;
    if (point) occupied.push(agentFootprint(point, active, compact));
  }
  return <div ref={layer} className="muse-agents-layer" aria-label="Your Muses on the whiteboard">{roles.map((agent, index) => {
    const active = working === agent;
    const latest = board.messages.filter(message => message.agent === agent).at(-1);
    const position = positions[agent];
    const { x, y } = position || homes[index];
    const preview = latest?.text || AGENTS[agent].description;
    return <div key={agent} className={`muse-floating-agent ${active ? 'is-working' : ''} ${dragging === agent ? 'is-dragging' : ''}`} data-agent={agent} data-home-x={homes[index].x} data-home-y={homes[index].y} data-positioned={!!position} aria-hidden={!position || undefined} inert={!position || undefined} style={{ transform: `translate(${x}px, ${y}px)`, '--agent-color': AGENTS[agent].color, '--float-delay': `${-index * 1.8}s` } as CSSProperties}
      onPointerDown={event => {
        if (drag.current || (event.target as HTMLElement).closest('.canvas-agent-process,.muse-agent-name') || event.button !== 0) return;
        clearTimeout(releaseTimers.current.get(agent)); releaseTimers.current.delete(agent);
        const bounds = event.currentTarget.getBoundingClientRect();
        drag.current = { agent, pointerX: event.clientX, pointerY: event.clientY, x: bounds.x, y: bounds.y, moved: false };
        setManual(value => ({ ...value, [agent]: { x: bounds.x, y: bounds.y } }));
        suppressClick.current = false; event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.agent !== agent) return;
        const dx = event.clientX - current.pointerX, dy = event.clientY - current.pointerY;
        if (!current.moved && Math.hypot(dx, dy) < 4) return;
        current.moved = true; suppressClick.current = true; setDragging(agent);
        setManual(value => ({ ...value, [agent]: { x: Math.max(0, Math.min(size.width - 104, current.x + dx)), y: Math.max(65, Math.min(size.height - 160, current.y + dy)) } }));
      }}
      onPointerUp={event => {
        finishDrag(agent);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { finishDrag(agent); suppressClick.current = false; }}
      onLostPointerCapture={() => { if (drag.current?.agent === agent) { finishDrag(agent); suppressClick.current = false; } }}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    >
      <div className="muse-agent-body">
        <CanvasAgentNode id={`muse-${agent}`} type="agent" selected={false} dragging={dragging === agent} draggable={false} selectable={false} deletable={false} isConnectable={false} zIndex={20} positionAbsoluteX={x} positionAbsoluteY={y} data={{
          title: AGENTS[agent].name, status: active ? AGENT_ACTIVITY[agent] : latest ? 'Contribution ready' : 'Ready', preview,
          activity: [...(latest ? [{ id: latest.id, kind: 'commentary' as const, text: latest.text, status: 'completed' as const }] : []), ...(active ? [{ id: `${agent}-working`, kind: 'tool' as const, text: AGENT_ACTIVITY[agent], status: 'running' as const }] : [])],
          working: active, active, state: active ? 'working' : latest ? 'finished' : 'idle', noticeKey: `muse.${board.id}.${agent}`, noticeId: latest?.id, viewing: false,
          onOpen: () => { ask(agent); return true; }, onHide: () => {},
        }}/>
        <button className="muse-agent-name" onClick={() => ask(agent)} aria-label={`Talk to ${AGENTS[agent].name}`}>{AGENTS[agent].name}</button>
        {active && <div className="muse-agent-thought" role="status"><span className="muse-activity-pulse"/>{AGENT_ACTIVITY[agent]}</div>}
        {!active && running && <span className="muse-agent-listening">{latest ? 'Contributed' : 'Following along'}</span>}
      </div>
    </div>;
  })}</div>;
}
