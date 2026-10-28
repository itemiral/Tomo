import { applyTurn } from '@/lib/muse/board';
import { AGENTS, type AgentId, type MuseRequest, type StreamEvent } from '@/lib/muse/types';
import { allowLocalRequest, parseMuseRequest } from '@/server/muse/contract';
import { runAgent } from '@/server/muse/model';

export const runtime = 'nodejs';
export const maxDuration = 300;
let activeRuns = 0;

export async function GET(request: Request) {
  if (!allowLocalRequest(request)) return Response.json({ error: 'This preview is available locally.' }, { status: 403 });
  return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!allowLocalRequest(request)) return Response.json({ error: 'This preview is available locally.' }, { status: 403 });
  if (activeRuns >= 2) return Response.json({ error: 'Your Muses are busy. Let the current thought finish.' }, { status: 429 });
  let input: MuseRequest;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing request');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 500_000) { await reader.cancel(); return Response.json({ error: 'This board is too large to send. Try a smaller board.' }, { status: 413 }); }
      chunks.push(value);
    }
    input = parseMuseRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return Response.json({ error: 'Send a message and a valid board.' }, { status: 400 });
  }
  if (activeRuns >= 2) return Response.json({ error: 'Your Muses are busy. Let the current thought finish.' }, { status: 429 });
  activeRuns++;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(240_000)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(output) {
      const emit = (event: StreamEvent) => { if (!signal.aborted) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
      try {
        const agents: AgentId[] = input.mode === 'team' ? ['planner', 'explorer', 'critic', 'organizer'] : [input.mode];
        for (const agent of agents) {
          signal.throwIfAborted();
          emit({ type: 'working', agent });
          const turn = { ...await runAgent(agent, input, signal), agent };
          input = { ...input, board: applyTurn(input.board, turn).board };
          input.board.messages = [...input.board.messages, { id: crypto.randomUUID(), role: 'assistant', text: turn.reply, agent }];
          emit({ type: 'result', turn });
        }
        emit({ type: 'done' });
      } catch (error) {
        if (!request.signal.aborted && !controller.signal.aborted) {
          const message = signal.aborted ? 'That thought took too long. Try a more focused request.' : error instanceof Error ? error.message : `${AGENTS.planner.name} could not connect. Please try again.`;
          output.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message })}\n`));
        }
      } finally {
        activeRuns--;
        try { output.close(); } catch { /* The browser may have canceled. */ }
      }
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } });
}
