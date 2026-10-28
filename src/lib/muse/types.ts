import type { Edge, Node } from '@xyflow/react';

export const AGENTS = {
  planner: { name: 'Planner', tagline: 'Find the shape of it.', description: 'Turns a big idea into a thoughtful outline, with room to change your mind.', color: '#b8a1ef' },
  explorer: { name: 'Explorer', tagline: 'Follow your curiosity.', description: 'Brings fresh angles, alternatives, and unexpected connections to the board.', color: '#9cc7ad' },
  critic: { name: 'Critic', tagline: 'Find the missing pieces.', description: 'Checks assumptions, constraints, and gaps so the shared plan holds together.', color: '#91b7e4' },
  organizer: { name: 'Organizer', tagline: 'Make it happen.', description: 'Connects the details, spots loose ends, and makes the next steps clear.', color: '#e5b58c' },
} as const;

export type AgentId = keyof typeof AGENTS;
export type MuseMode = AgentId | 'team';
export const COLORS = ['neutral', 'lavender', 'sage', 'peach', 'butter'] as const;
export type CardColor = typeof COLORS[number];
export type CardKind = 'note' | 'text' | 'checklist' | 'photo' | 'heading' | 'agent';
export type CardData = {
  kind: CardKind;
  title: string;
  body: string;
  color: CardColor;
  items: string[];
  checked: string[];
  agent?: AgentId;
  image?: 'kyoto' | 'shrine';
  eyebrow?: string;
};
export type MuseNode = Node<CardData, 'muse'>;
export type MuseEdge = Edge;
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; agent?: AgentId; changes?: number };
export type Board = {
  id: string;
  title: string;
  emoji: string;
  nodes: MuseNode[];
  edges: MuseEdge[];
  messages: ChatMessage[];
  updatedAt: number;
};
export type Preferences = { name: string; interests: string; workingStyle: string; details: string };
export type Workspace = { version: 1; activeId: string; boards: Board[]; preferences: Preferences };
export type PlanCard = { id: string; kind: 'note' | 'text' | 'checklist' | 'heading'; title: string; body: string; color: CardColor; items: string[] };
export type AgentResult = {
  boardTitle?: string;
  reply: string;
  cards: PlanCard[];
  removeCardIds: string[];
  connections: { source: string; target: string; label: string }[];
};
export type AgentTurn = AgentResult & { agent: AgentId };
export type MuseRequest = { board: Board; message: string; mode: MuseMode; preferences: Preferences; selectedIds: string[] };
export type StreamEvent =
  | { type: 'working'; agent: AgentId }
  | { type: 'result'; turn: AgentTurn }
  | { type: 'done' }
  | { type: 'error'; message: string };
