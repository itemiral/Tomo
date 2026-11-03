import { RequestError } from './shared';
import { museProgressLabel, type MuseProgress } from '../../lib/muse-request';

/** Progress events contain fixed statuses only; results remain atomic. */
export async function sendMuseChat<T>(body: Record<string, unknown>, signal: AbortSignal, progress: (phase: MuseProgress) => void): Promise<T> {
  const response = await fetch('/api/muse/chat', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal });
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json();
    if (!response.ok) throw new RequestError(result.error || 'Muse could not respond. Try again.', response.status);
    return result as T;
  }
  if (!response.ok || !response.body) throw new RequestError('Muse could not respond. Try again.', response.status);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0, result: T | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new RequestError('Muse returned an unreadable response. Try again.', 502); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new RequestError('Muse returned an unreadable response. Try again.', 502);
    if (event.type === 'progress' && Object.hasOwn(museProgressLabel, event.phase)) progress(event.phase);
    if (event.type === 'error') throw new RequestError(typeof event.error === 'string' ? event.error : 'Muse could not respond. Try again.', Number.isInteger(event.status) ? event.status : 502);
    if (event.type === 'result') result = event.result as T;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_000_000) throw new RequestError('Muse returned too much data. Try a smaller request.', 502);
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    buffer += decoder.decode(); consume(buffer);
    if (result === undefined) throw new RequestError('Muse’s response was interrupted. Try again.', 502);
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
