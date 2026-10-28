import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTurn, arrangeBoard, boardMarkdown, card, initialWorkspace, makeBoard, parseWorkspace } from './board';
import type { AgentTurn } from './types';

const turn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({ agent: 'planner', boardTitle: 'Our shared plan', reply: 'Here is the outline.', cards: [{ id: 'shared-outline', kind: 'checklist', title: 'Start here', body: 'Keep it simple.', color: 'neutral', items: ['Choose a date', 'Invite a friend'] }], removeCardIds: [], connections: [], ...overrides });
const planBoard = () => ({ ...makeBoard(), nodes: [card('user-brief', 0, 0, { title: 'The goal', body: 'A creative weekend.' })] });

test('a new workspace has no prefilled topic or example boards', () => {
  const workspace = initialWorkspace();
  assert.equal(workspace.boards.length, 1);
  assert.equal(workspace.boards[0].title, 'New board');
  assert.deepEqual(workspace.boards[0].nodes, []);
});

test('roles improve the same outline and every new card joins the shared graph', () => {
  let board = applyTurn(planBoard(), turn()).board;
  board = applyTurn(board, turn({ agent: 'explorer', cards: [{ ...turn().cards[0], body: 'The outline, with useful options.' }] })).board;
  assert.equal(board.nodes.length, 2);
  assert.equal(board.title, 'Our shared plan');
  assert.equal(board.nodes.find(node => node.id === 'shared-outline')?.data.body, 'The outline, with useful options.');
  assert.ok(board.edges.some(edge => edge.source === 'user-brief' && edge.target === 'shared-outline'));
  assert.ok(!board.nodes.some(node => node.data.kind === 'agent'));
});

test('updating a shared card keeps completed tasks and stable identity', () => {
  const board = applyTurn(planBoard(), turn()).board;
  board.nodes.find(node => node.id === 'shared-outline')!.data.checked = ['Choose a date'];
  const next = applyTurn(board, turn({ cards: [{ ...turn().cards[0], title: 'A refined plan' }] })).board;
  assert.equal(next.nodes.length, board.nodes.length);
  assert.deepEqual(next.nodes.find(node => node.id === 'shared-outline')!.data.checked, ['Choose a date']);
});

test('late replies preserve edits and deletions made while waiting', () => {
  const baseline = applyTurn(planBoard(), turn()).board;
  const edited = structuredClone(baseline);
  edited.nodes.find(node => node.id === 'shared-outline')!.data.title = 'My better title';
  const result = applyTurn(edited, turn(), baseline);
  assert.equal(result.conflicts, 1);
  assert.equal(result.board.nodes.find(node => node.id === 'shared-outline')!.data.title, 'My better title');
  const removed = { ...baseline, nodes: baseline.nodes.filter(node => node.id !== 'shared-outline'), edges: [] };
  assert.equal(applyTurn(removed, turn(), baseline).board.nodes.length, 1);
  const attemptedDelete = applyTurn(edited, turn({ cards: [], removeCardIds: ['shared-outline'] }), baseline);
  assert.equal(attemptedDelete.board.nodes.length, edited.nodes.length);
});

test('removing a card removes its connections', () => {
  const board = applyTurn(planBoard(), turn()).board;
  const next = applyTurn(board, turn({ cards: [], removeCardIds: ['shared-outline'] })).board;
  assert.equal(next.nodes.length, 1);
  assert.equal(next.edges.length, 0);
});

test('automatic layout clears measured cards and connects disconnected components', () => {
  const board = planBoard();
  board.nodes.push(card('a', 0, 0, { title: 'One' }), card('b', 0, 0, { title: 'Two' }), card('c', 0, 0, { title: 'Three' }));
  for (const node of board.nodes) node.measured = { width: 300, height: 330 };
  const arranged = arrangeBoard(board);
  for (let i = 0; i < arranged.nodes.length; i++) for (let j = i + 1; j < arranged.nodes.length; j++) {
    const a = arranged.nodes[i], b = arranged.nodes[j];
    assert.ok(a.position.x + 300 <= b.position.x || b.position.x + 300 <= a.position.x || a.position.y + 330 <= b.position.y || b.position.y + 330 <= a.position.y, 'cards must not overlap');
  }
  assert.equal(arranged.edges.length, 3);
});

test('saved boards round-trip and corrupted snapshots are rejected', () => {
  const workspace = initialWorkspace();
  assert.deepEqual(parseWorkspace(JSON.stringify(workspace)), workspace);
  assert.throws(() => parseWorkspace('{broken'));
  assert.throws(() => parseWorkspace(JSON.stringify({ ...workspace, activeId: 'missing' })));
  workspace.boards[0].nodes = [card('bad', 0, 0, {})];
  workspace.boards[0].nodes[0].data.items = [4] as unknown as string[];
  assert.throws(() => parseWorkspace(JSON.stringify(workspace)));
});

test('export includes completed and open tasks', () => {
  const board = makeBoard('blank', 'Weekend');
  board.nodes.push(card('packing', 0, 200, { kind: 'checklist', title: 'Pack', items: ['Notebook', 'Camera'], checked: ['Notebook'] }));
  const markdown = boardMarkdown(board);
  assert.match(markdown, /# Weekend/);
  assert.match(markdown, /- \[x\] Notebook/);
  assert.match(markdown, /- \[ \] Camera/);
});
