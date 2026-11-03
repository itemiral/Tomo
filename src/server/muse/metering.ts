import type { MuseInputMessage } from './vision';

type CounterReason = 'timeout' | 'unavailable' | 'invalid-response';
export type MuseInputMeasurement = { inputTokens: number; source: 'provider' | 'conservative'; imageTokensMeasured: boolean; imageCount: number; textUpperBound: number; latencyMs: number; fallbackReason?: CounterReason };
export type MuseUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; reasoningTokens?: number };
type CountOptions = { model: string; messages: readonly MuseInputMessage[]; responseSchema?: unknown; schemaName?: string; effort?: 'none' | 'low' | 'medium' | 'high' | 'max'; maxOutputTokens?: number; apiKey: string; signal: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
const encoder = new TextEncoder();

export function museTokenCountBody({ model, messages, responseSchema, schemaName = 'MuzePlan', effort, maxOutputTokens }: Omit<CountOptions, 'apiKey' | 'signal'>) {
  if (!model || model.length > 160 || !/^[a-zA-Z0-9_-]{1,64}$/.test(schemaName)) throw new Error('The Muse token counter is not configured correctly.');
  const input = messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (message.role !== 'user') throw new Error('Visual context must belong to a user request.');
    return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
  }) }));
  return { model, input, store: false, ...(effort ? { reasoning: { effort } } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(responseSchema ? { text: { format: { type: 'json_schema', name: schemaName, schema: responseSchema } } } : {}) };
}

function conservativeTextCount(messages: readonly MuseInputMessage[], responseSchema?: unknown) {
  const text = messages.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text') }));
  return encoder.encode(JSON.stringify({ messages: text, response_format: responseSchema })).length + messages.length * 16 + 256;
}

async function readCount(response: Response) {
  if (Number(response.headers.get('content-length')) > 16_384 || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid token count');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 16_384) { await reader.cancel(); throw new Error('Invalid token count'); }
    chunks.push(value);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(value) || !integer(value.input_tokens)) throw new Error('Invalid token count');
  return value.input_tokens;
}

/** Count with the selected model's tokenizer; a fallback never measures image tokens. */
export async function measureMuseInput(options: CountOptions): Promise<MuseInputMeasurement> {
  options.signal.throwIfAborted();
  const body = museTokenCountBody(options), started = performance.now();
  const imageCount = options.messages.reduce((count, message) => count + (typeof message.content === 'string' ? 0 : message.content.filter(part => part.type === 'image_url').length), 0);
  const textUpperBound = conservativeTextCount(options.messages, options.responseSchema);
  const timeout = AbortSignal.timeout(Math.max(50, Math.min(10_000, options.timeoutMs ?? 4000)));
  const signal = AbortSignal.any([options.signal, timeout]);
  let fallbackReason: CounterReason = 'unavailable';
  try {
    const response = await (options.fetcher || fetch)('https://api.meta.ai/v1/responses/input_tokens', {
      method: 'POST', cache: 'no-store', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (response.ok) {
      fallbackReason = 'invalid-response';
      const inputTokens = await readCount(response);
      signal.throwIfAborted();
      return { inputTokens, source: 'provider', imageTokensMeasured: true, imageCount, textUpperBound, latencyMs: Math.round(performance.now() - started) };
    }
    void response.body?.cancel().catch(() => {});
  } catch {
    options.signal.throwIfAborted();
    if (timeout.aborted) fallbackReason = 'timeout';
  }
  // This value covers text only. A caller with images MUST require
  // imageTokensMeasured before using the count to authorize inference.
  return { inputTokens: textUpperBound, source: 'conservative', imageTokensMeasured: imageCount === 0, imageCount, textUpperBound,
    latencyMs: Math.round(performance.now() - started), fallbackReason };
}

/** Response usage is accounting data, distinct from the preflight context count. */
export function readMuseUsage(result: unknown): MuseUsage {
  if (!record(result) || !record(result.usage)) return {};
  const usage = result.usage, output: MuseUsage = {};
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens, outputTokens = usage.completion_tokens ?? usage.output_tokens;
  if (integer(inputTokens)) output.inputTokens = inputTokens;
  if (integer(outputTokens)) output.outputTokens = outputTokens;
  if (integer(usage.total_tokens)) output.totalTokens = usage.total_tokens;
  const inputDetails = usage.prompt_tokens_details ?? usage.input_tokens_details, outputDetails = usage.completion_tokens_details ?? usage.output_tokens_details;
  if (record(inputDetails) && integer(inputDetails.cached_tokens) && (output.inputTokens === undefined || inputDetails.cached_tokens <= output.inputTokens)) output.cachedTokens = inputDetails.cached_tokens;
  if (record(outputDetails) && integer(outputDetails.reasoning_tokens) && (output.outputTokens === undefined || outputDetails.reasoning_tokens <= output.outputTokens)) output.reasoningTokens = outputDetails.reasoning_tokens;
  return output;
}

type MetricInput = { measurement?: MuseInputMeasurement; usage?: MuseUsage; durationMs?: number; inferenceMs?: number; objects?: number; pages?: number; excerpts?: number; images?: number; omittedObjects?: number; omittedHistory?: number; omittedExcerpts?: number; applied?: number; skipped?: number; outcome?: 'complete' | 'cancelled' | 'error' };

/** Only this allowlist reaches operator logs; no owner, prompt, pixels or model text. */
export function recordMuseMetrics(input: MetricInput, sink: (value: string) => void = value => console.info(value)) {
  const event: Record<string, number | string | boolean> = { event: 'muze_context', version: 1 };
  for (const key of ['durationMs', 'inferenceMs', 'objects', 'pages', 'excerpts', 'images', 'omittedObjects', 'omittedHistory', 'omittedExcerpts', 'applied', 'skipped'] as const) {
    const value = input[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) event[key] = Math.min(100_000_000, Math.round(value));
  }
  if (input.measurement) {
    if (integer(input.measurement.inputTokens)) event.countedInputTokens = input.measurement.inputTokens;
    event.providerCount = input.measurement.source === 'provider';
    event.imageTokensMeasured = input.measurement.imageTokensMeasured === true;
    if (integer(input.measurement.latencyMs)) event.countMs = input.measurement.latencyMs;
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'] as const) {
    const value = input.usage?.[key]; if (integer(value)) event[key] = value;
  }
  if (['complete', 'cancelled', 'error'].includes(input.outcome || '')) event.outcome = input.outcome!;
  try { sink(JSON.stringify(event)); } catch { /* Observability must not interrupt a saved turn. */ }
  return event;
}
