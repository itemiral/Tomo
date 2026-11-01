'use client';

import { useEffect, useRef } from 'react';

export function MuseOrb({ followCursor = false }: { followCursor?: boolean }) {
  const avatar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = avatar.current!;
    const paint=()=>{element.style.setProperty('--muse-gaze-x',x.toFixed(2)+'px');element.style.setProperty('--muse-gaze-y',y.toFixed(2)+'px');element.style.setProperty('--muse-turn',(x*.6).toFixed(2)+'deg');};
    let frame=0,started=0,x=0,y=0,fromX=0,fromY=0,tx=0,ty=0;
    paint();if (!followCursor) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let pointer: { x: number; y: number } | null = null;
    const draw = (now:number) => {
      frame = 0;
      if (document.hidden) return;
      const progress=Math.min(1,Math.max(0,(now-started)/90)),ease=1-Math.pow(1-progress,3);
      x=fromX+(tx-fromX)*ease;y=fromY+(ty-fromY)*ease;paint();
      if(progress<1)frame=requestAnimationFrame(draw);
    };
    const start = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(draw); };
    const target=()=>{if(!pointer||reduced.matches||document.hidden)return;const box=element.getBoundingClientRect(),dx=pointer.x-box.x-box.width/2,dy=pointer.y-box.y-box.height/2,distance=Math.max(160,Math.hypot(dx,dy));const nextX=dx/distance*8,nextY=dy/distance*6;if(tx===nextX&&ty===nextY)return;fromX=x;fromY=y;tx=nextX;ty=nextY;started=performance.now();start();};
    const center=()=>{cancelAnimationFrame(frame);frame=0;tx=ty=x=y=0;paint();};
    const move = (event: PointerEvent) => { if (event.pointerType !== 'touch') { pointer = { x: event.clientX, y: event.clientY }; target(); } };
    const blur = () => { pointer = null; center(); };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) blur(); };
    const preference=()=>{if(reduced.matches)center();else target();};
    const reposition=(event:TransitionEvent)=>{if(event.target instanceof Element&&event.target.contains(element))target();};
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('blur', blur);
    window.addEventListener('resize',target);
    window.addEventListener('transitionrun',reposition);window.addEventListener('transitionend',reposition);window.addEventListener('transitioncancel',reposition);
    document.addEventListener('visibilitychange',blur);
    reduced.addEventListener('change',preference);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', leave);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize',target);
      window.removeEventListener('transitionrun',reposition);window.removeEventListener('transitionend',reposition);window.removeEventListener('transitioncancel',reposition);
      document.removeEventListener('visibilitychange',blur);
      reduced.removeEventListener('change',preference);
    };
  }, [followCursor]);
  return <span ref={avatar} className="muse-orb" aria-hidden="true"><span className="muse-orb-face"><span className="muse-orb-eyes"><i/><i/></span></span></span>;
}
