import { test } from 'node:test';
import assert from 'node:assert/strict';
import { museTokenCountBody, measureMuseInput, readMuseUsage, recordMuseMetrics } from '../src/server/muse/metering.ts';

const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
const messages = [{ role: 'developer', content: 'Use current owner preferences.' }, { role: 'assistant', content: 'Earlier reply.' }, { role: 'user', content: 'Please explain this.' }];
const options = extras => ({ model: 'muse-spark-1.3', messages, responseSchema: schema, effort: 'low', maxOutputTokens: 6144, apiKey: 'fixture-key', signal: new AbortController().signal, ...extras });
const visualMessages = () => [...messages.slice(0, -1), { role: 'user', content: [{ type: 'text', text: 'Inspect this diagram.' }, { type: 'image_url', image_url: { url: 'data:image/webp;base64,fixture', detail: 'auto' } }] }];

test('preflight converts the complete chat input and output schema into the documented count shape', () => {
  const body = museTokenCountBody(options({ messages: visualMessages() }));
  assert.equal(body.model, 'muse-spark-1.3'); assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.max_output_tokens, 6144);
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'MuzePlan', schema });
  assert.deepEqual(body.input.slice(0, 2), messages.slice(0, 2));
  assert.deepEqual(body.input[2], { role: 'user', content: [{ type: 'input_text', text: 'Inspect this diagram.' }, { type: 'input_image', image_url: 'data:image/webp;base64,fixture', detail: 'auto' }] });
  assert.equal(body.messages, undefined); assert.equal(body.response_format, undefined); assert.equal(body.apiKey, undefined);
  assert.throws(() => museTokenCountBody(options({ messages: [{ ...visualMessages().at(-1), role: 'developer' }] })), /user request/);
});

test('successful counting reports actual provider tokens and includes images in the measurement', async () => {
  let calls = 0;
  const result = await measureMuseInput(options({ messages: visualMessages(), fetcher: async (url, init) => {
    calls++; assert.equal(url, 'https://api.meta.ai/v1/responses/input_tokens');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    assert.equal(JSON.parse(init.body).input[2].content[1].type, 'input_image');
    return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 7012 }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  assert.equal(calls, 1); assert.equal(result.inputTokens, 7012); assert.equal(result.source, 'provider');
  assert.equal(result.imageCount, 1); assert.equal(result.imageTokensMeasured, true); assert.ok(result.latencyMs >= 0);
});

test('text fallback is explicit, includes schema and UTF-8, and never pretends to measure pixels', async () => {
  const unavailable = async () => new Response('Unavailable', { status: 503 });
  const text = await measureMuseInput(options({ messages: [{ role: 'user', content: '你好 👋'.repeat(20) }], fetcher: unavailable }));
  assert.equal(text.source, 'conservative'); assert.equal(text.imageTokensMeasured, true); assert.equal(text.imageCount, 0);
  assert.ok(text.inputTokens >= Buffer.byteLength(JSON.stringify(schema)) + Buffer.byteLength('你好 👋'.repeat(20)));
  const image = await measureMuseInput(options({ messages: visualMessages(), fetcher: unavailable }));
  assert.equal(image.source, 'conservative'); assert.equal(image.imageTokensMeasured, false); assert.equal(image.imageCount, 1);
  assert.equal(image.inputTokens, image.textUpperBound);
});

test('malformed or oversized provider responses fall back without leaking response contents', async () => {
  for (const response of [new Response('{"input_tokens":-1}'), new Response('{"input_tokens":"123"}'), new Response('not-json'), new Response('x'.repeat(20_000))]) {
    const count = await measureMuseInput(options({ fetcher: async () => response }));
    assert.equal(count.source, 'conservative'); assert.equal(count.fallbackReason, 'invalid-response'); assert.ok(count.inputTokens > 0);
  }
});

test('counter timeout falls back, while an owner cancellation always propagates', async () => {
  const blocked = async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  // AbortSignal.timeout is intentionally unref'ed; keep this isolated test alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const timed = await measureMuseInput(options({ timeoutMs: 50, fetcher: blocked }));
    assert.equal(timed.source, 'conservative'); assert.equal(timed.fallbackReason, 'timeout'); assert.ok(timed.latencyMs < 2000);
    const abort = new AbortController(), reason = new Error('Owner changed');
    const request = measureMuseInput(options({ signal: abort.signal, fetcher: blocked }));
    abort.abort(reason); await assert.rejects(request, error => error === reason);
    let calls = 0;
    await assert.rejects(measureMuseInput(options({ signal: abort.signal, fetcher: async () => { calls++; } })), error => error === reason);
    assert.equal(calls, 0);
  } finally { clearInterval(keepAlive); }
});

test('usage parsing reads only valid accounting fields from either supported response shape', () => {
  assert.deepEqual(readMuseUsage({ usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 }, prompt: 'Private text' } }), { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedTokens: 20, reasoningTokens: 5 });
  assert.deepEqual(readMuseUsage({ usage: { input_tokens: 70, output_tokens: 10, total_tokens: 80, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } }), { inputTokens: 70, outputTokens: 10, totalTokens: 80, cachedTokens: 4, reasoningTokens: 3 });
  assert.deepEqual(readMuseUsage({ usage: { prompt_tokens: -1, completion_tokens: 'secret', total_tokens: Infinity } }), {});
  assert.deepEqual(readMuseUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 99 }, completion_tokens_details: { reasoning_tokens: 99 } } }), { inputTokens: 1, outputTokens: 2 });
});

test('metrics cannot serialize owner IDs, messages, keys, URLs or arbitrary usage fields', () => {
  const lines = [];
  const event = recordMuseMetrics({ durationMs: 250.8, images: 2, objects: 90, omittedHistory: 8, outcome: 'complete',
    ownerId: 'owner-private', message: 'never log my message', apiKey: 'do-not-log', model: 'private config',
    measurement: { inputTokens: 1200, source: 'provider', imageTokensMeasured: true, latencyMs: 25, dataUrl: 'data:image/png;base64,private' },
    usage: { inputTokens: 1000, outputTokens: 90, text: 'private output' } }, value => lines.push(value));
  assert.equal(lines.length, 1); assert.equal(event.durationMs, 251); assert.equal(event.providerCount, true); assert.equal(event.inputTokens, 1000);
  assert.doesNotMatch(lines[0], /owner-private|never log|do-not-log|private|data:image|apiKey|message|model/);
  assert.doesNotThrow(() => recordMuseMetrics({ outcome: 'error' }, () => { throw new Error('log sink unavailable'); }));
});
