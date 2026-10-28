'use client';

import type { ReactNode } from 'react';
import { useAgentGaze } from './use-agent-gaze';
import './agent-avatar.css';

/** Shared face for the canvas agent and its miniature workspace mark. */
export function AgentAvatar({ celebrate = false, followPointer = false, face, children }: { celebrate?: boolean; followPointer?: boolean; face?: ReactNode; children?: ReactNode }) {
  const avatar = useAgentGaze(followPointer);

  return <span ref={avatar} className="canvas-agent-avatar" data-pointer-aware={followPointer || undefined} aria-hidden="true">
    <span className="muse-agent-gaze">{face ?? <span className="canvas-agent-face">{[0, 1].map(eye => <i key={eye}>{celebrate && <><span className="canvas-agent-eye-open"/><span className="canvas-agent-eye-smile"/></>}</i>)}</span>}</span>
    {children}
  </span>;
}
