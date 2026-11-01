'use client';

import { useEffect, useRef } from 'react';

export function MuseOrb({ followCursor = false }: { followCursor?: boolean }) {
  const avatar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!followCursor) return;
    const element = avatar.current!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let pointer: { x: number; y: number } | null = null;
    let frame = 0, x = 0, y = 0;
    const draw = () => {
      frame = 0;
      if (document.hidden) return;
      const box = element.getBoundingClientRect();
      const dx = pointer ? pointer.x - box.x - box.width / 2 : 0;
      const dy = pointer ? pointer.y - box.y - box.height / 2 : 0;
      const distance = Math.max(160, Math.hypot(dx, dy));
      const ease = reduced.matches ? 1 : .18;
      x += (dx / distance * 8 - x) * ease;
      y += (dy / distance * 6 - y) * ease;
      element.style.setProperty('--muse-gaze-x', x.toFixed(2) + 'px');
      element.style.setProperty('--muse-gaze-y', y.toFixed(2) + 'px');
      element.style.setProperty('--muse-turn', (x * .6).toFixed(2) + 'deg');
      if (pointer || Math.abs(x) + Math.abs(y) > .02) frame = requestAnimationFrame(draw);
    };
    const start = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(draw); };
    const move = (event: PointerEvent) => { if (event.pointerType !== 'touch') { pointer = { x: event.clientX, y: event.clientY }; start(); } };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) { pointer = null; start(); } };
    const blur = () => { pointer = null; start(); };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', start);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', leave);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', start);
    };
  }, [followCursor]);
  return <span ref={avatar} className="muse-orb" aria-hidden="true"><span className="muse-orb-face"><span className="muse-orb-eyes"><i/><i/></span></span></span>;
}
