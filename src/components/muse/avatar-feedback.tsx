'use client';
import { Pencil, RotateCcw } from 'lucide-react';
import type { Obstacle } from './floating';
export type AvatarState = 'idle' | 'pending' | 'error';
export function AvatarProgress() {
  return <span className="muse-avatar-progress" role="progressbar" aria-label="Updating Muse avatar"><i/></span>;
}
export function AvatarFeedback({ box, state, selected, canRetry, choose, retry }: { box: Obstacle; state: AvatarState; selected?: boolean; canRetry?: boolean; choose: () => void; retry: () => void }) {
  if (!selected && state === 'idle') return null;
  return <div data-muse-ui="true" className={'muse-avatar-feedback ' + state} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
    {state === 'pending' && <><span className="muse-avatar-blur"/><AvatarProgress/></>}
    {state !== 'pending' && <button className="muse-avatar-action" type="button" aria-label={state === 'error' ? 'Retry avatar update' : 'Change Muse icon'} aria-describedby="avatar-replace-disclosure" onClick={state === 'error' ? retry : choose}>{state === 'error' ? <RotateCcw size={16}/> : <Pencil size={16}/>}</button>}
    {state === 'error' && selected && canRetry && <button className="muse-avatar-action muse-avatar-replace" type="button" aria-label="Change Muse icon" aria-describedby="avatar-replace-disclosure" onClick={choose}><Pencil size={16}/></button>}
  </div>;
}
