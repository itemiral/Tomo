export type ChatActivity = { id: string; kind: 'commentary' | 'tool'; text: string; status: 'running' | 'completed' | 'failed'; detail?: string };
