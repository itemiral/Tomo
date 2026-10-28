import assert from 'node:assert/strict';
import test from 'node:test';
import { createMuseAdapter, museConfiguration, parseMuseResponse } from './transport';

const env = { MODEL_API_KEY: 'test-key' };
const completed = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('roles use standard Muse models and independently supplied credentials', () => {
  assert.equal(museConfiguration('planner', env).model, 'muse-wonder-1.0');
  assert.equal(museConfiguration('critic', env).model, 'muse-wonder-1.0');
  assert.equal(museConfiguration('explorer', env).model, 'muse-spark-1.3');
  assert.equal(museConfiguration('organizer', env).model, 'muse-spark-1.3');
  assert.equal(museConfiguration('planner', { MODEL_API_KEY: 'another-local-key' }).apiKey, 'another-local-key');
  assert.equal(museConfiguration('planner', { ...env, MODEL_PLANNER: 'muse-spark-1.3' }).model, 'muse-spark-1.3');
  assert.throws(() => museConfiguration('planner', {}), /MODEL_API_KEY/);
  assert.throws(() => museConfiguration('planner', { ...env, MODEL_NAME: 'muse-spark-1.3-contributor' }), /standard Muse/);
  assert.throws(() => museConfiguration('planner', { ...env, MODEL_BASE_URL: 'http://example.com' }), /HTTPS/);
});

test('requests use the Muse endpoint, a strict board schema, and no stored response', async () => {
  const signal = new AbortController().signal;
  const adapter = createMuseAdapter(museConfiguration('planner', env), async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-key');
    assert.equal(options?.signal, signal);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, 'muse-wonder-1.0');
    assert.equal(request.store, false);
    assert.equal(request.instructions, 'Shape the shared plan.');
    assert.equal(request.input, 'A community workshop.');
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.equal(request.max_output_tokens, 6144);
    assert.equal(JSON.stringify(request).includes('test-key'), false);
    assert.equal(request.previous_response_id, undefined);
    return Response.json(completed({ reply: 'Ready.' }));
  });
  assert.deepEqual(await adapter.generate('Shape the shared plan.', 'A community workshop.', signal), { reply: 'Ready.' });
});

test('only completed structured content reaches the shared board', () => {
  const response = completed({ reply: 'A useful outline.' });
  response.output.unshift({ type: 'reasoning', content: [{ type: 'output_text', text: 'private intermediate work' }] });
  assert.deepEqual(parseMuseResponse(response), { reply: 'A useful outline.' });
  assert.throws(() => parseMuseResponse({ status: 'incomplete', output: [] }), /response space/);
  assert.throws(() => parseMuseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Not available' }] }] }), /rephrasing/);
  assert.throws(() => parseMuseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] }), /unreadable board/);
});

test('service errors cannot expose raw credentials or upstream error details', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    let calls = 0;
    const adapter = createMuseAdapter(museConfiguration('planner', env), async () => {
      calls++;
      return Response.json({ error: { message: 'test-key: upstream details' } }, { status });
    });
    await assert.rejects(adapter.generate('Plan.', 'A workshop.', new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('test-key'), false);
      assert.equal(error.message.includes('upstream details'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('cancellation prevents a model request from starting', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const adapter = createMuseAdapter(museConfiguration('planner', env), async () => { calls++; return Response.json(completed({})); });
  await assert.rejects(adapter.generate('Plan.', 'A workshop.', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});
