'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

type Tip = { anchor: HTMLButtonElement; label: string; hint: string; shortcut?: string };

export function CanvasTooltips() {
  const id = useId();
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.querySelector('.muze-app');
    if (!root) return;
    let anchor: HTMLButtonElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); anchor = null; setTip(null); };
    const buttonFor = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLButtonElement>('button[data-tooltip]') : null;
    const show = (button: HTMLButtonElement | null, delay: number) => {
      if (!button || button.disabled || button.closest('.muze-more-tools')) return;
      if (button === anchor) return;
      hide(); anchor = button;
      timer = setTimeout(() => {
        if (!button.isConnected) return;
        const [heading, ...lines] = (button.dataset.tooltip || '').split('\n');
        const [label, shortcut] = heading.split('  ·  ');
        setTip({ anchor: button, label, shortcut, hint: lines.join('\n') });
      }, delay);
    };
    const over = (event: Event) => {
      if ((event as PointerEvent).pointerType === 'touch') return;
      show(buttonFor(event.target), 450);
    };
    const out = (event: Event) => {
      const next = (event as PointerEvent).relatedTarget;
      if (anchor && !(next instanceof Node && anchor.contains(next))) hide();
    };
    const focus = (event: Event) => {
      const button = buttonFor(event.target);
      if (button?.matches(':focus-visible')) show(button, 0);
    };
    const key = (event: Event) => { if ((event as KeyboardEvent).key === 'Escape') hide(); };
    root.addEventListener('pointerover', over);
    root.addEventListener('pointerout', out);
    root.addEventListener('pointerdown', hide, true);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', hide);
    root.addEventListener('keydown', key);
    window.addEventListener('blur', hide);
    root.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(timer);
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('pointerdown', hide, true);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', hide);
      root.removeEventListener('keydown', key);
      window.removeEventListener('blur', hide);
      root.removeEventListener('scroll', hide, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !element.current) return;
    const tooltip = element.current;
    const place = () => {
      const anchor = tip.anchor.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      const gap = 10, edge = 12;
      let left = anchor.left + (anchor.width - box.width) / 2;
      let top = anchor.top - gap - box.height;
      if (tip.anchor.closest('.muze-header')) top = anchor.bottom + gap;
      else if (tip.anchor.closest('.muze-style-panel')) {
        left = anchor.left - gap - box.width;
        top = anchor.top + (anchor.height - box.height) / 2;
      } else if (tip.anchor.closest('.muze-toolbar-dock')) {
        const chat = document.querySelector('.muse-chat-stack')?.getBoundingClientRect();
        if (chat && left < chat.right && left + box.width > chat.left && top + box.height > chat.top) {
          top = chat.top - gap - box.height;
          if (top < edge) { left = chat.left - gap - box.width; top = anchor.top - gap - box.height; }
        }
      }
      left = Math.max(edge, Math.min(innerWidth - box.width - edge, left));
      top = Math.max(edge, Math.min(innerHeight - box.height - edge, top));
      setPosition(current => current.left === left && current.top === top ? current : { left, top });
    };
    const describedBy = tip.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) || [];
    tip.anchor.setAttribute('aria-describedby', [...describedBy, id].join(' '));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(tooltip);
    const chat = document.querySelector('.muse-chat-stack');
    if (chat) observer.observe(chat);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place);
      const remaining = (tip.anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id);
      if (remaining.length) tip.anchor.setAttribute('aria-describedby', remaining.join(' '));
      else tip.anchor.removeAttribute('aria-describedby');
    };
  }, [tip, id]);

  return tip ? <div ref={element} id={id} role="tooltip" className="muze-tooltip" style={position}>
    <div><strong>{tip.label}</strong>{tip.shortcut && <kbd>{tip.shortcut}</kbd>}</div>
    {tip.hint && <p>{tip.hint}</p>}
  </div> : null;
}
