'use client';

import { Cloud } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type MuseProfile = { ownerId: string; ownerName: string; muse: { id: string; name: string; iconVersion: string | null } };
export class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function museRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/muse/' + url, { cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error || 'Could not open your Muse. Try again.', response.status);
  return result as T;
}
export function MuseIcon({ profile }: { profile: MuseProfile }) {
  return <span className="muse-avatar" aria-hidden="true">{profile.muse.iconVersion ? <img key={profile.muse.iconVersion} src={'/api/muse/avatar?v=' + profile.muse.iconVersion} alt="" draggable={false}/> : <Cloud size={32} strokeWidth={1.3}/>}</span>;
}
export function MuseMarkdown({ text }: { text: string }) {
  return <div className="muse-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muse-image-label">{alt || 'Image'}</span>, a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span> }}>{text}</Markdown></div>;
}
