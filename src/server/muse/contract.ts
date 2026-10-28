import { isBoard, isPreferences } from '../../lib/muse/board';
import { AGENTS, COLORS, type AgentResult, type MuseRequest } from '../../lib/muse/types';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is string => text(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value);

export function parseMuseRequest(value: unknown): MuseRequest {
  if (!object(value) || !text(value.message, 6000) || !value.message.trim() || !['team', ...Object.keys(AGENTS)].includes(String(value.mode)) || !isBoard(value.board) || !isPreferences(value.preferences) || !Array.isArray(value.selectedIds) || value.selectedIds.length > 250 || !value.selectedIds.every(id)) throw new Error('Send a message and a valid board.');
  return value as MuseRequest;
}

export const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    boardTitle: { type: 'string' },
    reply: { type: 'string' },
    cards: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['note', 'text', 'checklist', 'heading'] }, title: { type: 'string' }, body: { type: 'string' }, color: { type: 'string', enum: [...COLORS] }, items: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'kind', 'title', 'body', 'color', 'items'],
    } },
    removeCardIds: { type: 'array', items: { type: 'string' } },
    connections: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { source: { type: 'string' }, target: { type: 'string' }, label: { type: 'string' } }, required: ['source', 'target', 'label'] } },
  }, required: ['boardTitle', 'reply', 'cards', 'removeCardIds', 'connections'],
};

export function parseAgentResult(value: unknown, request: MuseRequest): AgentResult {
  if (object(value) && value.boardTitle !== undefined && !text(value.boardTitle, 100)) throw new Error('Muse returned an invalid board title. Please try again.');
  if (!object(value) || !text(value.reply, 6000) || !value.reply.trim() || !Array.isArray(value.cards) || value.cards.length > 8 || !Array.isArray(value.removeCardIds) || value.removeCardIds.length > 40 || !Array.isArray(value.connections) || value.connections.length > 30) throw new Error('Muse returned an incomplete response. Try a smaller request.');
  const ids = new Set(request.board.nodes.map(node => node.id));
  const incoming = new Set<string>();
  for (const item of value.cards) {
    if (!object(item) || !id(item.id) || incoming.has(item.id) || item.id.startsWith('agent-') || !['note', 'text', 'checklist', 'heading'].includes(String(item.kind)) || item.id === 'board-heading' && item.kind !== 'heading' || !text(item.title, 160) || !text(item.body, 4000) || !COLORS.includes(item.color as typeof COLORS[number]) || !Array.isArray(item.items) || item.items.length > 20 || !item.items.every(line => text(line, 500))) throw new Error('Muse returned an invalid card. Please try again.');
    incoming.add(item.id); ids.add(item.id);
  }
  for (const remove of value.removeCardIds) {
    if (!id(remove) || !ids.has(remove) || remove.startsWith('agent-') || remove === 'board-heading' || incoming.has(remove)) throw new Error('Muse returned an invalid board change. Please try again.');
    ids.delete(remove);
  }
  if (ids.size > 250 || !value.connections.every(link => object(link) && id(link.source) && id(link.target) && ids.has(link.source) && ids.has(link.target) && link.source !== link.target && text(link.label, 100))) throw new Error('Muse returned an invalid connection. Please try again.');
  return value as AgentResult;
}

export function allowLocalRequest(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  try {
    const url = new URL(request.url);
    // Next's local proxy normalizes request.url to localhost. Validate the real
    // Host too, and compare the browser Origin against that exact loopback host.
    const host = new URL(`${url.protocol}//${request.headers.get('host') || url.host}`);
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'];
    return env.NODE_ENV !== 'production' && !env.VERCEL && loopback.includes(url.hostname) && loopback.includes(host.hostname) && site !== 'cross-site' && (origin === host.origin || !origin && (request.method === 'GET' || site === 'same-origin'));
  } catch { return false; }
}
