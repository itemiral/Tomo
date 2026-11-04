import { RequestError } from './shared';
import { museProgressLabel, type MuseProgress } from '../../lib/muse-request';

export class MuseStopError extends RequestError {
  constructor(message = 'Could not stop the previous response yet. Try again.') { super(message, 503); }
}
type Cancellation = { ready: Promise<boolean>; attempt?: Promise<void>; stopped: () => void };
const cancellations = new Map<string, Cancellation>();

function beforeDeadline<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new MuseStopError()), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function finishCancellation(requestId: string, entry: Cancellation): Promise<void> {
  if (entry.attempt) return entry.attempt;
  entry.attempt = (async () => {
    // First progress is emitted only after the server owns its private chat lease.
    // Keeping that reader alive closes the Stop-before-acquire race across workers.
    if (await beforeDeadline(entry.ready)) {
      const response = await fetch('/api/muse/chat', {
        method: 'DELETE', cache: 'no-store', credentials: 'same-origin', keepalive: true,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId}),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new MuseStopError(response.status === 401 ? 'Sign in again to stop the previous response.' : undefined);
    }
    cancellations.delete(requestId);
    entry.stopped();
  })().catch(error => { throw error instanceof MuseStopError ? error : new MuseStopError(); })
    .finally(() => { entry.attempt = undefined; });
  return entry.attempt;
}

/** Progress events contain fixed statuses only; results remain atomic. */
export async function sendMuseChat<T>(body: Record<string, unknown>, signal: AbortSignal, progress: (phase: MuseProgress) => void): Promise<T> {
  for (const [id, entry] of cancellations) { await finishCancellation(id, entry); signal.throwIfAborted(); }
  signal.throwIfAborted();
  if (typeof body.requestId !== 'string') return readMuseChat<T>(body, signal, progress, () => {});
  const transport = new AbortController();
  let accepted!: (active: boolean) => void, rejectStopped!: (error: unknown) => void;
  const ready = new Promise<boolean>(resolve => { accepted = resolve; });
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const requestId = body.requestId;
  const entry: Cancellation = {ready, stopped: () => transport.abort(signal.reason)};
  const stop = () => {
    cancellations.set(requestId, entry);
    void finishCancellation(requestId, entry).then(() => rejectStopped(signal.reason), rejectStopped);
  };
  signal.addEventListener('abort', stop, {once: true});
  // If an acknowledgment arrives after a bounded cancellation timeout, finish
  // stopping in the background. A new send also retries that exact cancellation.
  void ready.then(() => { if (signal.aborted && cancellations.get(requestId) === entry) void finishCancellation(requestId, entry).catch(() => {}); });
  const response = readMuseChat<T>(body, AbortSignal.any([transport.signal, AbortSignal.timeout(305_000)]), phase => {
    accepted(true);
    if (!signal.aborted) progress(phase);
  }, () => accepted(false)).then(result => { signal.throwIfAborted(); return result; });
  try { return await Promise.race([response, stopped]); }
  finally { signal.removeEventListener('abort', stop); }
}

async function readMuseChat<T>(body: Record<string, unknown>, signal: AbortSignal, progress: (phase: MuseProgress) => void, finished: () => void): Promise<T> {
 try {
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
 } finally { finished(); }
}
