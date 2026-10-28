import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBoard, DEFAULT_PREFERENCES } from '../../lib/muse/board';
import { allowLocalRequest, parseAgentResult, parseMuseRequest } from './contract';
import type { MuseRequest } from '../../lib/muse/types';

const input = (): MuseRequest => ({ message: 'Outline the trip', mode: 'team', board: makeBoard('trip'), preferences: DEFAULT_PREFERENCES, selectedIds: [] });
const result = () => ({ reply: 'A starting point.', cards: [{ id: 'planner-new-card', kind: 'note', title: 'Start here', body: 'A thought', color: 'sage', items: [] }], removeCardIds: [], connections: [] });

test('the local gate accepts Next-normalized loopback requests, and rejects foreign origins and production', () => {
  const request = new Request('http://localhost:3200/api/muse/chat', { method: 'POST', headers: { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200', 'sec-fetch-site': 'same-origin' } });
  assert.equal(allowLocalRequest(request, { NODE_ENV: 'development' }), true);
  assert.equal(allowLocalRequest(request, { NODE_ENV: 'production' }), false);
  assert.equal(allowLocalRequest(request, { NODE_ENV: 'development', VERCEL: '1' }), false);
  for (const headers of [{ origin: 'https://example.com' }, { origin: 'null' }, { host: 'example.com', origin: 'https://example.com' }, { origin: 'http://127.0.0.1:3200', 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal(allowLocalRequest(new Request(request.url, { method: 'POST', headers: { host: '127.0.0.1:3200', ...headers } }), { NODE_ENV: 'development' }), false);
  }
});

test('empty, oversized, malformed, and unknown-role requests fail validation', () => {
  assert.equal(parseMuseRequest(input()).mode, 'team');
  for (const value of [{ ...input(), message: '' }, { ...input(), message: 'x'.repeat(6001) }, { ...input(), board: {} }, { ...input(), mode: 'admin' }, { ...input(), preferences: { name: 4 } }]) assert.throws(() => parseMuseRequest(value));
});

test('model output cannot replace an agent, duplicate IDs, or reference missing cards', () => {
  assert.equal(parseAgentResult(result(), input()).cards.length, 1);
  assert.throws(() => parseAgentResult({ ...result(), cards: [{ ...result().cards[0], id: 'agent-planner' }] }, input()));
  assert.throws(() => parseAgentResult({ ...result(), cards: [result().cards[0], result().cards[0]] }, input()));
  assert.throws(() => parseAgentResult({ ...result(), connections: [{ source: 'missing', target: 'planner-new-card', label: '' }] }, input()));
  assert.throws(() => parseAgentResult({ ...result(), removeCardIds: ['agent-organizer'] }, input()));
  assert.throws(() => parseAgentResult({ ...result(), cards: [{ ...result().cards[0], body: 'x'.repeat(4001) }] }, input()));
});

test('model output can update an existing heading without turning it into a card', () => {
  const heading = { ...result(), cards: [{ ...result().cards[0], id: 'board-heading', kind: 'heading', body: 'Three days, at our pace.' }] };
  assert.equal(parseAgentResult(heading, input()).cards[0].kind, 'heading');
  assert.throws(() => parseAgentResult({ ...heading, cards: [{ ...heading.cards[0], kind: 'note' }] }, input()));
});
