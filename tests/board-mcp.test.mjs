import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serveBoardTool, BoardToolAccessError} from '../src/server/boards/mcp.ts';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const id = '659aff2a-2f70-462a-ae93-303be0600bb5', token = 'muze_' + 'x'.repeat(43), url = `http://127.0.0.1:3201/api/mcp/boards/${id}`;
const board = {id, name: 'Shared board', activePage: 'page', pages: [{id: 'page', name: 'Page 1', objects: [{id: 'note', type: 'MuzeNote', text: 'A shared note'}, {id: 'group', type: 'Group', objects: [{id: 'nested', type: 'Textbox', text: 'Nested text'}]}, {id: 'image', type: 'Image', src: 'data:image/png;base64,fixture'}], viewport: [1,0,0,1,0,0]}], comments: [{id: 'comment', text: 'A shared comment', author: 'A person', pageId: 'page'}]};
const snapshot = {board, revision: 'revision-1', updatedAt: '2026-11-04T00:00:00Z'};
const reader = async (key, secret) => {assert.equal(key, id); if (secret !== token) throw new BoardToolAccessError(401, 'Access revoked.'); return snapshot;};
function request(message, options = {}) {return new Request(options.url || url, {method: options.method || 'POST', headers: {authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', ...options.headers}, ...(options.method && options.method !== 'POST' ? {} : {body: typeof message === 'string' ? message : JSON.stringify(message)})});}
const rpc = (method, params = {}) => ({jsonrpc: '2.0', id: 1, method, params});
async function payload(response) {const text = await response.text(); if (response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)); return text ? JSON.parse(text) : null;}
async function call(method, params = {}, options = {}) {const response = await serveBoardTool(request(rpc(method, params), options), id, reader); return {response, body: await payload(response)};}

test('legacy initialization, tool discovery, ping and repeated requests work without a session', async () => {
  const initialized = await call('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test-client', version: '1'}});
  assert.equal(initialized.response.status, 200); assert.equal(initialized.body.result.serverInfo.name, 'muze-board');
  assert.equal(initialized.response.headers.has('mcp-session-id'), false);
  const notification = await serveBoardTool(request({jsonrpc: '2.0', method: 'notifications/initialized'}), id, reader);
  assert.equal(notification.status, 202);
  for (let index = 0; index < 3; index++) {
    const listed = await call('tools/list'); assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['read_board', 'get_notes']);
    assert.ok(listed.body.result.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    assert.deepEqual((await call('ping')).body.result, {});
  }
});

test('tool text is scoped, nested notes and comments paginate, and export preserves the exact scene', async () => {
  const overview = (await call('tools/call', {name: 'read_board', arguments: {}})).body.result.structuredContent;
  assert.equal(overview.id, id); assert.equal(overview.pages.length, 1); assert.equal(overview.commentCount, 1);
  const first = (await call('tools/call', {name: 'get_notes', arguments: {limit: 1}})).body.result.structuredContent;
  assert.equal(first.notes[0].text, 'A shared note'); assert.equal(first.nextOffset, 1);
  const second = (await call('tools/call', {name: 'get_notes', arguments: {offset: first.nextOffset}})).body.result.structuredContent;
  assert.deepEqual(second.notes.map(note => note.text), ['Nested text', 'A shared comment']); assert.equal(second.nextOffset, null);
  const resources = (await call('resources/list')).body.result.resources; assert.equal(resources.length, 1);
  const exported = (await call('resources/read', {uri: resources[0].uri})).body.result.contents[0];
  assert.deepEqual(JSON.parse(exported.text), {format: 'muze', version: 1, board});
  assert.ok((await call('resources/read', {uri: 'muze://private/memory'})).body.error);
  assert.ok((await call('tools/call', {name: 'edit_board', arguments: {}})).body.error);
});

test('authentication is rechecked on every request, secrets never enter response metadata', async () => {
  let enabled = true, reads = 0;
  const authorize = async () => {reads++; if (!enabled) throw new BoardToolAccessError(401, 'Access revoked.'); return snapshot;};
  const first = await serveBoardTool(request(rpc('tools/list')), id, authorize); await payload(first);
  enabled = false;
  const second = await serveBoardTool(request(rpc('tools/list')), id, authorize);
  assert.equal(reads, 2); assert.equal(second.status, 401); assert.equal(second.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.ok(!JSON.stringify([...second.headers]).includes(token)); assert.ok(!(await second.text()).includes(token));
});

test('query credentials, foreign origins, missing tokens, oversized bodies and invalid arguments fail', async () => {
  for (const [options, expected] of [[{headers: {authorization: ''}}, 401], [{headers: {origin: 'https://evil.example'}}, 403], [{url: url + '?token=' + token}, 400], [{headers: {'content-type': 'text/plain'}}, 415]]) assert.equal((await call('tools/list', {}, options)).response.status, expected);
  assert.equal((await serveBoardTool(request('x'.repeat(17000)), id, reader)).status, 413);
  assert.equal((await serveBoardTool(request('{'), id, reader)).status, 400);
  assert.ok((await call('tools/call', {name: 'get_notes', arguments: {limit: 101}})).body.error || (await call('tools/call', {name: 'get_notes', arguments: {limit: 101}})).body.result.isError);
  assert.equal((await call('tools/call', {name: 'get_notes', arguments: {pageId: 'private'}})).body.result.isError, true);
  for (const method of ['GET', 'DELETE', 'OPTIONS']) assert.equal((await serveBoardTool(request(null, {method}), id, reader)).status, 405);
});

test('cancellation notifications are acknowledged and unsupported protocol versions fail', async () => {
  const cancelled = await serveBoardTool(request({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 99, reason: 'Stopped'}}), id, reader);
  assert.equal(cancelled.status, 202); assert.equal(await cancelled.text(), '');
  assert.equal((await call('tools/list', {}, {headers: {'mcp-protocol-version': '1999-01-01'}})).response.status, 400);
});

test('official SDK clients connect, list, call and export using both protocol generations', async () => {
  for (const mode of ['legacy', 'auto']) {
    const client = new Client({name: 'muze-test', version: '1.0.0'}, {versionNegotiation: {mode}});
    const transport = new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {Authorization: `Bearer ${token}`}}, fetch: async (input, init) => serveBoardTool(new Request(input, init), id, reader)});
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      assert.equal((await client.listTools()).tools.length, 2);
      const result = await client.callTool({name: 'get_notes', arguments: {limit: 1}});
      assert.equal(result.structuredContent.notes[0].text, 'A shared note');
      const resources = await client.listResources();
      const exported = await client.readResource({uri: resources.resources[0].uri});
      assert.deepEqual(JSON.parse(exported.contents[0].text).board, board);
    } finally {await client.close();}
  }
});

test('subscription requests finish immediately and malformed hosts fail before authorization', async () => {
  const subscribed = await call('subscriptions/listen', {subscriptions: []});
  assert.equal(subscribed.response.status, 400); assert.equal(subscribed.body.error.code, -32601);
  const neverRead = async () => {throw new Error('Authorization must not run.');};
  for (const host of ['evil.example', '[invalid', '127.0.0.1@evil.example', '127.0.0.1#evil']) {
    assert.equal((await serveBoardTool(request(rpc('tools/list'), {headers: {host, origin: 'http://' + host}}), id, neverRead)).status, 403);
  }
});
