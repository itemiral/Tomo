'use client';

import { MuseAvatarImage } from './avatar-image';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type MuseProfile = { ownerId: string; ownerName: string; muse: { id: string; name: string; iconVersion: string | null; gazeVersion?: string | null; candidateVersion?: string | null } };
export class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function museRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/muse/' + url, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => null);
  if (!result) throw new RequestError(response.status === 413 ? 'This file is too large. Use a smaller image or export your draft.' : 'Could not reach Muse. Try again.', response.status);
  if (!response.ok) throw new RequestError(result.error || 'Could not open your Muse. Try again.', response.status);
  return result as T;
}
export function MuseIcon({ profile, followCursor = false, pending = false, loading = false }: { profile?: MuseProfile | null; followCursor?: boolean; pending?: boolean; loading?: boolean }) {
  const custom=!!profile?.muse.iconVersion,gaze=profile?.muse.gazeVersion;
  const src=loading?null:custom?'/api/muse/avatar?'+(gaze?'sheet=true&v='+gaze:'v='+profile?.muse.iconVersion)+'&display=portrait':'/muse/default-gaze-15.png?v=hybrid-15';
  return <MuseAvatarImage src={src} poses={custom?9:15} sheet={!custom||!!gaze} follow={followCursor} pending={pending}/>;
}
export function MuseMarkdown({ text }: { text: string }) {
  return <div className="muse-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muse-image-label">{alt || 'Image'}</span>, a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span> }}>{text}</Markdown></div>;
}
