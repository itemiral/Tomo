'use client';

import { useEffect, useRef, useState } from 'react';
import { MusePortrait } from './portrait';
import { MuseOrb } from './orb';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type MuseProfile = { ownerId: string; ownerName: string; muse: { id: string; name: string; iconVersion: string | null; gazeVersion?: string | null; candidateVersion?: string | null } };
export class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function museRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/muse/' + url, { cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error || 'Could not open your Muse. Try again.', response.status);
  return result as T;
}
export function MuseIcon({ profile, followCursor = false }: { profile?: MuseProfile | null; followCursor?: boolean }) {
  const [failed,setFailed]=useState(false),custom=!!profile?.muse.iconVersion,gaze=profile?.muse.gazeVersion;
  const src=custom?'/api/muse/avatar?'+(gaze?'sheet=true&v='+gaze:'v='+profile?.muse.iconVersion):'/muse/default-gaze.png?v=hybrid-1';
  useEffect(()=>setFailed(false),[src]);
  return <span className={'muse-avatar'+(failed?' muse-avatar-orb':'')} aria-hidden="true">{failed?<MuseOrb followCursor={followCursor}/>:<MusePortrait src={src} sheet={!custom||!!gaze} follow={followCursor} onError={()=>setFailed(true)}/>}</span>;
}
export function MuseMarkdown({ text }: { text: string }) {
  return <div className="muse-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muse-image-label">{alt || 'Image'}</span>, a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span> }}>{text}</Markdown></div>;
}
