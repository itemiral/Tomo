import { AGENTS, COLORS, type AgentId, type AgentTurn, type Board, type CardData, type MuseNode, type Preferences, type Workspace } from './types';
import { graphlib, layout } from '@dagrejs/dagre';

export const STORAGE_KEY = 'muse.workspace.v2';
export const DEFAULT_PREFERENCES: Preferences = { name: 'Izat', interests: '', workingStyle: 'A clear outline, then room to explore', details: '' };
export const uid = () => crypto.randomUUID();

export function card(id: string, x: number, y: number, data: Partial<CardData>, width = 300): MuseNode {
  return { id, type: 'muse', position: { x, y }, style: { width }, data: { kind: 'note', title: '', body: '', color: 'neutral', items: [], checked: [], ...data } };
}

export function agentNodes(): MuseNode[] {
  return (Object.keys(AGENTS) as AgentId[]).map((agent, index) => card(`agent-${agent}`, index * 180, 0, { kind: 'agent', title: AGENTS[agent].name, body: AGENTS[agent].tagline, agent }, 110));
}

export function makeBoard(template: 'blank' | 'trip' | 'project' = 'blank', title?: string): Board {
  return { id: uid(), title: title?.trim() || (template === 'trip' ? 'Trip plan' : template === 'project' ? 'Project plan' : 'New board'), emoji: '○', nodes: [], edges: [], messages: [], updatedAt: Date.now() };
}

export function initialWorkspace(): Workspace {
  const first = makeBoard('blank');
  return { version: 1, activeId: first.id, boards: [first], preferences: { ...DEFAULT_PREFERENCES } };
}

export function estimatedHeight(node: MuseNode): number {
  if (node.measured?.height) return node.measured.height;
  if (node.data.kind === 'agent') return 82;
  if (node.data.kind === 'heading') return 110;
  if (node.data.kind === 'photo') return 310;
  return 110 + Math.ceil(node.data.body.length / 36) * 22 + node.data.items.reduce((height, text) => height + Math.max(1, Math.ceil(text.length / 30)) * 24 + 12, 0);
}

// All roles contribute to one connected plan; avatars are a separate visual layer.
// A late reply cannot overwrite a card the user edited after sending the message.
export function applyTurn(board: Board, turn: AgentTurn, expected?: Board): { board: Board; conflicts: number } {
  let conflicts = 0;
  const changedSinceRequest = (id: string) => {
    if (!expected) return false;
    return JSON.stringify(board.nodes.find(node => node.id === id)?.data) !== JSON.stringify(expected.nodes.find(node => node.id === id)?.data);
  };
  const removed = new Set(turn.removeCardIds.filter(id => {
    if (changedSinceRequest(id)) { conflicts++; return false; }
    return !id.startsWith('agent-');
  }));
  let nodes = board.nodes.filter(node => !removed.has(node.id) && node.data.kind !== 'agent');
  let edges = board.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  for (const incoming of turn.cards) {
    if (changedSinceRequest(incoming.id)) { conflicts++; continue; }
    const existing = nodes.find(node => node.id === incoming.id);
    if (existing?.data.kind === 'agent') continue;
    const data: CardData = { ...existing?.data, ...incoming, agent: turn.agent, checked: existing?.data.checked.filter(item => incoming.items.includes(item)) ?? [] };
    if (existing) nodes = nodes.map(node => node.id === incoming.id ? { ...node, data, measured: undefined } : node);
    else {
      nodes.push(card(incoming.id, 0, 0, data, 320));
    }
  }
  const ids = new Set(nodes.map(node => node.id));
  for (const link of turn.connections) {
    if (ids.has(link.source) && ids.has(link.target) && link.source !== link.target && !edges.some(edge => edge.source === link.source && edge.target === link.target)) {
      edges.push({ ...link, id: `link-${link.source}-${link.target}`, type: 'smoothstep' });
    }
  }
  const title = expected && board.title !== expected.title ? board.title : turn.boardTitle?.trim() || board.title;
  return { board: arrangeBoard({ ...board, title, nodes, edges, updatedAt: Date.now() }), conflicts };
}

export function arrangeBoard(board: Board): Board {
  const content = board.nodes.filter(node => !['agent', 'heading'].includes(node.data.kind));
  if (!content.length) return { ...board, nodes: [], edges: [] };
  const ids = new Set(content.map(node => node.id));
  const root = content.find(node => node.id === 'user-brief') || content[0];
  const edges = board.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);
  // Attach orphaned content to the same plan, never to a role-specific branch.
  const reachable = new Set([root.id]);
  const visit = () => { let changed = true; while (changed) { changed = false; for (const edge of edges) if (reachable.has(edge.source) && !reachable.has(edge.target)) { reachable.add(edge.target); changed = true; } } };
  visit();
  for (const node of content) if (!reachable.has(node.id)) {
    edges.push({ id: `plan-${root.id}-${node.id}`, source: root.id, target: node.id, type: 'smoothstep' });
    reachable.add(node.id); visit();
  }
  const graph = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 55, marginx: 0, marginy: 0 });
  for (const node of content) graph.setNode(node.id, { width: Number(node.style?.width) || 320, height: estimatedHeight(node) });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  layout(graph);
  const nodes = content.map(node => { const point = graph.node(node.id); return { ...node, position: { x: point.x - point.width / 2, y: point.y - point.height / 2 } }; });
  return { ...board, nodes, edges: edges.map(edge => ({ ...edge, style: { stroke: '#a7adb5', strokeWidth: 1.6 }, type: 'smoothstep' })), updatedAt: Date.now() };
}

export function upgradeWorkspace(workspace: Workspace): Workspace {
  return { ...workspace, boards: workspace.boards.map(board => {
    // Remove the untouched starter, but retain anything the person has worked on.
    if (board.title === 'Kyoto, slowly' && !board.messages.length && board.nodes.every(node => node.id.startsWith('trip-') || node.id.startsWith('agent-') || node.id === 'board-heading')) return { ...board, title: 'New board', nodes: [], edges: [] };
    return arrangeBoard(board);
  }) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isBoard(value: unknown): value is Board {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.emoji !== 'string' || !Array.isArray(value.nodes) || value.nodes.length > 250 || !Array.isArray(value.edges) || value.edges.length > 600 || !Array.isArray(value.messages)) return false;
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || ids.has(node.id) || node.type !== 'muse' || !isRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !isRecord(node.data)) return false;
    const data = node.data;
    if (!['note', 'text', 'checklist', 'photo', 'heading', 'agent'].includes(String(data.kind)) || typeof data.title !== 'string' || typeof data.body !== 'string' || !COLORS.includes(data.color as typeof COLORS[number]) || !Array.isArray(data.items) || !data.items.every(item => typeof item === 'string') || !Array.isArray(data.checked) || !data.checked.every(item => typeof item === 'string') || (data.agent !== undefined && !Object.hasOwn(AGENTS, String(data.agent))) || (data.image !== undefined && !['kyoto', 'shrine'].includes(String(data.image)))) return false;
    ids.add(node.id);
  }
  return value.edges.every(edge => isRecord(edge) && typeof edge.id === 'string' && ids.has(String(edge.source)) && ids.has(String(edge.target))) && value.messages.every(message => isRecord(message) && typeof message.id === 'string' && ['user', 'assistant'].includes(String(message.role)) && typeof message.text === 'string' && (message.agent === undefined || Object.hasOwn(AGENTS, String(message.agent))));
}

export function isPreferences(value: unknown): value is Preferences {
  return isRecord(value) && ['name', 'interests', 'workingStyle', 'details'].every(key => typeof value[key] === 'string' && (value[key] as string).length <= 2000);
}

export function parseWorkspace(raw: string): Workspace {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.boards) || !value.boards.length || !value.boards.every(isBoard) || !isPreferences(value.preferences) || typeof value.activeId !== 'string' || !value.boards.some(board => board.id === value.activeId)) throw new Error('This board file could not be opened.');
  return value as Workspace;
}

export function boardMarkdown(board: Board): string {
  return `# ${board.title}\n\n` + board.nodes.filter(node => !['heading', 'agent'].includes(node.data.kind)).map(({ data }) => `## ${data.title}\n${data.agent ? `*${AGENTS[data.agent].name}*\n\n` : '\n'}${data.body}\n\n${data.items.map(item => data.kind === 'checklist' ? `- [${data.checked.includes(item) ? 'x' : ' '}] ${item}` : `- ${item}`).join('\n')}`).join('\n\n');
}
