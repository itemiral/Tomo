'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MuseIcon, type MuseProfile } from './shared';

type Position = { x: number; y: number };
export type Obstacle = Position & { id?: string; w: number; h: number };
export type MuseActivity = { label: string; targetId?: string };
type Props = { profile?: MuseProfile | null; open: () => void; obstacles: Obstacle[]; activity: MuseActivity; chatOpen?: boolean };
const controls = '.muze-header,.muze-style-panel,.muze-minimap,.muze-popover,.muse-chat,.muze-toolbar-dock,.muze-navigation,.muze-bottom-right,.muse-tabs';

export function FloatingMuse({ profile, open, obstacles, activity, chatOpen = false }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<Position>(() => ({ x: 24, y: typeof window === 'undefined' ? 400 : Math.max(110, innerHeight - 240) }));
  const [dragging, setDragging] = useState(false), [held, setHeld] = useState(false), [roaming, setRoaming] = useState(false);
  const point = useRef(position), latest = useRef({ obstacles, activity, chatOpen });
  latest.current = { obstacles, activity, chatOpen };
  const drag = useRef<{ id: number; start: Position; from: Position; moved: boolean } | null>(null);
  const moved = useRef(false), hovered = useRef(false), focused = useRef(false), interacting = useRef(false), reduced = useRef(false);
  const nextRoam = useRef(0), step = useRef(0), wasWorking = useRef(false), pendingHome = useRef(false);
  const moveTo = useCallback((p: Position, wander = false) => { point.current = p; setPosition(p); setRoaming(wander); }, []);
  const bounds = useCallback(() => {
    const w = button.current?.offsetWidth || 92, h = (button.current?.offsetHeight || 116) + 10;
    const clamp = (p: Position) => ({ x: Math.max(16, Math.min(innerWidth - w - 16, p.x)), y: Math.max(104, Math.min(innerHeight - h - 120, p.y)) });
    return { w, h, clamp };
  }, []);
  const scene = useCallback(() => {
    const { w, h, clamp } = bounds();
    const ui = [...document.querySelectorAll(controls)].map(el => el.getBoundingClientRect()).filter(b => b.width && b.height).map(b => ({ x: b.x, y: b.y, w: b.width, h: b.height }));
    const boxes = [...latest.current.obstacles, ...ui];
    const overlap = (p: Position) => boxes.reduce((sum, b) => sum + Math.max(0, Math.min(p.x + w + 12, b.x + b.w) - Math.max(p.x - 12, b.x)) * Math.max(0, Math.min(p.y + h + 12, b.y + b.h) - Math.max(p.y - 12, b.y)), 0);
    const spaces = [24, innerWidth * .22, innerWidth * .48, innerWidth * .74, innerWidth - w - 24].flatMap(x => [120, innerHeight * .32, innerHeight * .54, innerHeight - 240].map(y => clamp({ x, y })));
    return { w, h, clamp, overlap, spaces };
  }, [bounds]);
  const freeze = useCallback(() => {
    const box = button.current?.getBoundingClientRect();
    if (box) moveTo({ x: box.x, y: box.y });
  }, [moveTo]);
  const settle = useCallback(() => {
    if (drag.current || hovered.current || focused.current) return;
    const { w, h, clamp, overlap, spaces } = scene();
    const work = latest.current.activity;
    const target = work.label ? latest.current.obstacles.find(b => b.id === work.targetId) : undefined;
    const home = clamp({ x: 24, y: innerHeight - 240 });
    const preferred = target ? clamp({ x: target.x - w - 24, y: target.y + 24 }) : work.label ? clamp({ x: innerWidth * .55, y: innerHeight * .4 }) : pendingHome.current ? home : clamp(point.current);
    const nearby = target ? [{ x: target.x - w - 24, y: target.y + 24 }, { x: target.x + target.w + 24, y: target.y + 24 }, { x: target.x, y: target.y - h - 24 }, { x: target.x, y: target.y + target.h + 24 }].map(clamp) : [];
    const score = (p: Position) => overlap(p) * 1000 + Math.hypot(p.x - preferred.x, p.y - preferred.y);
    const candidate = [preferred, ...nearby, ...spaces].sort((a, b) => score(a) - score(b))[0];
    pendingHome.current = false;
    moveTo(candidate);
  }, [moveTo, scene]);
  useEffect(() => { const timer = setTimeout(settle, 450); return () => clearTimeout(timer); }, [obstacles, chatOpen, settle]);
  useEffect(() => {
    if (activity.label) nextRoam.current = Date.now() + 8500;
    else if (wasWorking.current) { pendingHome.current = true; nextRoam.current = Date.now() + 8500; }
    wasWorking.current = !!activity.label;
    settle();
  }, [activity.label, activity.targetId, settle]);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => { reduced.current = preference.matches; if (preference.matches) freeze(); };
    motion();
    const down = (event: PointerEvent) => {
      interacting.current = true;
      nextRoam.current = Date.now() + 8000;
      if (!(event.target as Element).closest('.muse-floating')) freeze();
    };
    const up = () => { interacting.current = false; };
    const resize = () => { moveTo(bounds().clamp(point.current)); settle(); };
    const timer = setInterval(() => {
      if (reduced.current || document.hidden || drag.current || hovered.current || focused.current || interacting.current || latest.current.chatOpen || latest.current.activity.label || Date.now() < nextRoam.current || document.querySelector('[role="dialog"]')) return;
      const { clamp, overlap, spaces } = scene();
      const from = point.current;
      const offsets = [{ x: 170, y: -100 }, { x: 180, y: 90 }, { x: -160, y: -110 }, { x: -170, y: 90 }];
      const offset = offsets[step.current++ % offsets.length];
      const preferred = clamp({ x: from.x + offset.x, y: from.y + offset.y });
      const score = (p: Position) => {
        const path = [.25, .5, .75].reduce((sum, t) => sum + overlap({ x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t }), 0);
        return overlap(p) * 1000 + path * 100 + Math.hypot(p.x - preferred.x, p.y - preferred.y);
      };
      const candidates = [preferred, ...spaces].filter(p => Math.hypot(p.x - from.x, p.y - from.y) > 35);
      candidates.sort((a, b) => score(a) - score(b));
      const candidate = candidates[0];
      if (candidate && overlap(candidate) <= overlap(from)) moveTo(candidate, true);
    }, 5500);
    preference.addEventListener('change', motion);
    window.addEventListener('resize', resize);
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', up, { passive: true });
    window.addEventListener('blur', up);
    return () => {
      clearInterval(timer);
      preference.removeEventListener('change', motion);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [bounds, freeze, moveTo, scene, settle]);
  const release = () => { setHeld(hovered.current || focused.current); if (!hovered.current && !focused.current) settle(); };
  function finish(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    moved.current = current.moved || cancelled;
    drag.current = null; interacting.current = false; setDragging(false);
    nextRoam.current = Date.now() + 10000;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    settle();
  }
  return <button ref={button} type="button" className={'muse-floating' + (dragging ? ' dragging' : '') + (held ? ' held' : '') + (roaming ? ' roaming' : '') + (activity.label ? ' working' : '')} style={{ left: position.x, top: position.y }} aria-label="Talk to Muse" title="Muse — drag to move; click to talk"
    onPointerEnter={() => { hovered.current = true; setHeld(true); if (!drag.current) freeze(); }}
    onPointerLeave={() => { hovered.current = false; release(); }}
    onFocus={event => { if (event.currentTarget.matches(':focus-visible')) { focused.current = true; setHeld(true); freeze(); } }}
    onBlur={() => { focused.current = false; release(); }}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.stopPropagation(); freeze();
      event.currentTarget.setPointerCapture(event.pointerId);
      moved.current = false; setDragging(true);
      drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, from: point.current, moved: false };
    }}
    onPointerMove={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      const dx = event.clientX - d.start.x, dy = event.clientY - d.start.y;
      if (Math.hypot(dx, dy) > 5) d.moved = true;
      if (d.moved) moveTo(bounds().clamp({ x: d.from.x + dx, y: d.from.y + dy }));
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={() => { if (drag.current) { moved.current = true; drag.current = null; interacting.current = false; setDragging(false); } }}
    onKeyDown={event => {
      event.stopPropagation();
      const distance = event.shiftKey ? 48 : 16;
      const delta: Record<string, Position> = { ArrowLeft: { x: -distance, y: 0 }, ArrowRight: { x: distance, y: 0 }, ArrowUp: { x: 0, y: -distance }, ArrowDown: { x: 0, y: distance } };
      if (delta[event.key]) { event.preventDefault(); moveTo(bounds().clamp({ x: point.current.x + delta[event.key].x, y: point.current.y + delta[event.key].y })); }
    }}
    onClick={event => { event.stopPropagation(); if (event.detail === 0 || !moved.current) open(); moved.current = false; }}>
    <span className="muse-floating-shadow" aria-hidden="true"/>
    <MuseIcon profile={profile} followCursor/>
    <span className="muse-floating-name">{profile?.muse.name || 'Muse'}<span className="muse-presence"/></span>
    {activity.label && <span className="muse-floating-activity" role="status">{activity.label}</span>}
  </button>;
}
