'use client';

import { useEffect, useRef } from 'react';

export function useAgentGaze(enabled: boolean) {
  const avatar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = avatar.current;
    if (!element || !enabled) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let point = { x: 0, y: 0 };
    const reset = () => {
      cancelAnimationFrame(frame); frame = 0;
      element.style.setProperty('--agent-gaze-x', '0px');
      element.style.setProperty('--agent-gaze-y', '0px');
      element.style.setProperty('--agent-turn', '0deg');
    };
    const update = () => {
      frame = 0;
      if (!fine.matches || reduced.matches || document.hidden) return;
      const rect = element.getBoundingClientRect();
      const dx = point.x - rect.left - rect.width / 2;
      const dy = point.y - rect.top - rect.height / 2;
      const distance = Math.hypot(dx, dy);
      const reach = Math.min(1, distance / 180);
      // Use the face's native coordinates so the miniature follows correctly
      // when its parent is scaled, without React renders on pointer movement.
      const x = distance ? dx / distance * reach * 8 : 0;
      const y = distance ? dy / distance * reach * 6 : 0;
      element.style.setProperty('--agent-gaze-x', `${x.toFixed(2)}px`);
      element.style.setProperty('--agent-gaze-y', `${y.toFixed(2)}px`);
      element.style.setProperty('--agent-turn', `${(x * .6).toFixed(2)}deg`);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !fine.matches || reduced.matches || document.hidden) return;
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener('pointermove', move, { passive: true, capture: true });
    window.addEventListener('blur', reset);
    document.documentElement.addEventListener('pointerleave', reset);
    document.addEventListener('visibilitychange', reset);
    fine.addEventListener('change', reset);
    reduced.addEventListener('change', reset);
    return () => {
      reset();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('blur', reset);
      document.documentElement.removeEventListener('pointerleave', reset);
      document.removeEventListener('visibilitychange', reset);
      fine.removeEventListener('change', reset);
      reduced.removeEventListener('change', reset);
    };
  }, [enabled]);

  return avatar;
}
