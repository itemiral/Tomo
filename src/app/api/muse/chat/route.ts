import { type NextRequest } from 'next/server';
import { checkOrigin, jsonBody, withOwner, privateFailure, privateJson } from '@/server/muse/private';
import { askMuse } from '@/server/muse/model';
import { readMuseChat, validThread } from '../../../../../scripts/muse-store.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    return await withOwner(request, async profile => {
      const thread = validThread(request.nextUrl.searchParams.get('thread'));
      return privateJson({ messages: await readMuseChat(profile.ownerId, thread) });
    });
  } catch (error) { return privateFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request, true);
    return await withOwner(request, async profile => {
      const body = await jsonBody(request, 2_000_000);
      if (!request.headers.get('accept')?.includes('application/x-ndjson')) return privateJson(await askMuse(profile.ownerId, body, request.signal));
      const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => { if (!closed && !signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
          try {
            const result = await askMuse(profile.ownerId, body, signal, 'low', phase => send({type: 'progress', phase}));
            send({type: 'result', result});
          } catch (error) {
            const failure = privateFailure(error);
            const value = await failure.json();
            send({type: 'error', status: failure.status, error: value.error});
          } finally { if (!closed) { closed = true; controller.close(); } }
        },
        cancel() { closed = true; abort.abort(); },
      });
      const headers = new Headers(privateJson(null).headers);
      headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      return new Response(stream, {headers});
    });
  } catch (error) { return privateFailure(error); }
}
