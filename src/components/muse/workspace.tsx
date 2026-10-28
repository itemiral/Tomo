'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { addEdge, applyEdgeChanges, applyNodeChanges, getNodesBounds, ReactFlow, ReactFlowProvider, useReactFlow, ViewportPortal, type Connection } from '@xyflow/react';
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronUp, Download, Hand, LayoutGrid, ListChecks, LoaderCircle, Maximize, MessageCircle, Minus, MousePointer2, Plus, Redo2, Search, Settings2, Sparkles, Square, StickyNote, Type, Undo2, Upload, Users, X } from 'lucide-react';
import { AGENTS, type AgentId, type Board, type CardData, type MuseMode, type MuseNode, type StreamEvent, type Workspace } from '@/lib/muse/types';
import { applyTurn, arrangeBoard, boardMarkdown, card, initialWorkspace, isBoard, makeBoard, parseWorkspace, upgradeWorkspace, STORAGE_KEY, uid } from '@/lib/muse/board';
import { BoardActions, MuseGlyph, museNodeTypes } from './cards';
import { CardEditor, MuseDialog, NewBoardDialog, PreferencesEditor } from './dialogs';
import { AGENT_ACTIVITY, FloatingMuses } from './floating-muses';
import { PlanView } from './plan-view';
import '@xyflow/react/dist/style.css';
import './muse.css';
import './muse-dark.css';

type CanvasSnapshot = Pick<Board, 'nodes' | 'edges'>;
type BoardHistory = { past: CanvasSnapshot[]; future: CanvasSnapshot[] };

function planReadingFrame(width: number, height: number) {
  const compact = width < 700;
  const zoom = width >= 1200 ? 1.1 : 1;
  const x = compact ? 60 : 115, y = compact ? 232 : 220;
  return {
    x, y, zoom,
    width: Math.min(760, (width - x - (compact ? 16 : 115)) / zoom),
    height: Math.max(160, Math.min(535, (height - y - (compact ? 230 : 190)) / zoom - 45)),
  };
}

export function MuseWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [saveStatus, setSaveStatus] = useState('Saved locally');
  const [recovery, setRecovery] = useState('');
  const current = useRef(workspace);
  current.current = workspace;
  useEffect(() => {
    try {
      localStorage.removeItem('muse.workspace.v1');
      const raw = localStorage.getItem(STORAGE_KEY);
      setWorkspace(raw ? upgradeWorkspace(parseWorkspace(raw)) : initialWorkspace());
    } catch {
      // Keep the original bytes available if a previous snapshot is unreadable.
      try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) localStorage.setItem(`${STORAGE_KEY}.recovery-${Date.now()}`, raw); } catch { /* Storage can be unavailable. */ }
      setRecovery('Your previous board could not be opened. A recovery copy was kept when storage was available.');
      setWorkspace(initialWorkspace());
    }
  }, []);
  useEffect(() => {
    if (!workspace) return;
    setSaveStatus('Saving…');
    const save = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current.current)); setSaveStatus('Saved locally'); }
      catch { setSaveStatus('Not saved · export a copy'); }
    };
    const timer = setTimeout(save, 350);
    const hide = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', hide);
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', hide); };
  }, [workspace]);
  if (!workspace) return <main className="muse-loading"><MuseGlyph/><span>Making a little space.</span></main>;
  return <ReactFlowProvider><Workbench workspace={workspace} setWorkspace={setWorkspace} saveStatus={saveStatus} recovery={recovery} dismissRecovery={() => setRecovery('')}/></ReactFlowProvider>;
}

function Workbench({ workspace, setWorkspace, saveStatus, recovery, dismissRecovery }: { workspace: Workspace; setWorkspace: (value: Workspace) => void; saveStatus: string; recovery: string; dismissRecovery: () => void }) {
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const board = workspace.boards.find(item => item.id === workspace.activeId)!;
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [view, setView] = useState<'plan' | 'canvas'>('plan');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [activityOpen, setActivityOpen] = useState(false);
  const [boardMenu, setBoardMenu] = useState(false);
  const [boardSearch, setBoardSearch] = useState('');
  const [teamOpen, setTeamOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [newBoard, setNewBoard] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<MuseMode>('team');
  const [modeOpen, setModeOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [busy, setBusy] = useState<{ boardId: string; agent: AgentId | null } | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [zoom, setZoom] = useState(100);
  const [readingFrame, setReadingFrame] = useState(() => planReadingFrame(1440, 900));
  const [, setHistoryVersion] = useState(0);
  const history = useRef(new Map<string, BoardHistory>());
  const requestRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow<MuseNode>();
  const draft = drafts[board.id] || '';
  const selected = board.nodes.filter(node => node.selected && !['heading', 'agent'].includes(node.data.kind));
  const working = busy?.boardId === board.id ? busy.agent : null;
  const editing = board.nodes.find(node => node.id === editingId);
  const activeHistory = history.current.get(board.id);

  const commit = useCallback((next: Workspace) => { workspaceRef.current = next; setWorkspace(next); }, [setWorkspace]);
  const remember = useCallback((value: Board) => {
    const previous = history.current.get(value.id) || { past: [], future: [] };
    previous.past = [...previous.past.slice(-39), structuredClone({ nodes: value.nodes, edges: value.edges })];
    previous.future = [];
    history.current.set(value.id, previous);
    setHistoryVersion(value => value + 1);
  }, []);
  const updateBoard = useCallback((update: (value: Board) => Board, record = false, id = workspaceRef.current.activeId) => {
    const current = workspaceRef.current;
    const old = current.boards.find(item => item.id === id);
    if (!old) return;
    if (record) remember(old);
    commit({ ...current, boards: current.boards.map(item => item.id === id ? { ...update(item), updatedAt: Date.now() } : item) });
  }, [commit, remember]);
  const undo = useCallback((redo = false) => {
    const current = workspaceRef.current.boards.find(item => item.id === workspaceRef.current.activeId)!;
    const stack = history.current.get(current.id);
    const snapshot = (redo ? stack?.future : stack?.past)?.pop();
    if (!snapshot || !stack) return;
    (redo ? stack.past : stack.future).push(structuredClone({ nodes: current.nodes, edges: current.edges }));
    updateBoard(value => ({ ...value, ...snapshot }));
    setHistoryVersion(value => value + 1);
  }, [updateBoard]);
  const fit = useCallback(() => {
    const current = workspaceRef.current.boards.find(item => item.id === workspaceRef.current.activeId);
    const nodes = current?.nodes.filter(node => !['agent', 'heading'].includes(node.data.kind)) || [];
    if (!nodes.length) { void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 450 }); return; }
    if (viewRef.current === 'plan') {
      const frame = planReadingFrame(window.innerWidth, window.innerHeight);
      setReadingFrame(frame);
      void flow.setViewport({ x: frame.x, y: frame.y, zoom: frame.zoom });
      return;
    }
    const root = nodes.find(node => node.id === 'user-brief') || nodes.find(node => !current?.edges.some(edge => edge.target === node.id)) || nodes[0];
    const neighbor = nodes.find(node => current?.edges.some(edge => edge.source === root.id && edge.target === node.id));
    const compact = window.innerWidth < 700;
    const left = compact ? 60 : 115, right = compact ? 16 : 115;
    const availableWidth = window.innerWidth - left - right;
    const rootWidth = root.measured?.width || Number(root.style?.width) || 320;
    const zoom = Math.min(window.innerWidth >= 1200 ? 1.1 : 1, availableWidth / rootWidth);
    const cluster = getNodesBounds(neighbor ? [root, neighbor] : [root]);
    const x = left + Math.max(0, (availableWidth - cluster.width * zoom) / 2) - (root.position.x + 2200) * zoom;
    const top = compact ? 232 : 245, bottom = window.innerHeight - (compact ? 230 : 190);
    const y = top + Math.max(180, bottom - top) / 2 - (root.position.y + (root.measured?.height || 210) / 2) * zoom;
    void flow.setViewport({ x, y, zoom });
  }, [flow]);
  const fitAll = useCallback(() => {
    if (viewRef.current === 'plan') { fit(); return; }
    const nodes = workspaceRef.current.boards.find(item => item.id === workspaceRef.current.activeId)?.nodes || [];
    if (!nodes.length) { fit(); return; }
    const bounds = getNodesBounds(nodes);
    const availableWidth = Math.max(270, window.innerWidth - (window.innerWidth < 700 ? 100 : 210));
    const availableHeight = Math.max(260, window.innerHeight - 330);
    const zoom = Math.max(.25, Math.min(1, availableWidth / Math.max(320, bounds.width), availableHeight / Math.max(180, bounds.height)));
    void flow.setViewport({ x: (window.innerWidth < 700 ? 70 : 115) - (bounds.x + 2200) * zoom, y: 245 - bounds.y * zoom, zoom });
  }, [flow, fit]);
  const notify = useCallback((message: string) => setToast(message), []);
  const addCard = useCallback((kind: 'note' | 'text' | 'checklist') => {
    const position = flow.screenToFlowPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 80 });
    const node = card(uid(), position.x, position.y, { kind, title: kind === 'checklist' ? 'The next steps' : kind === 'text' ? 'A new outline' : 'A little thought', color: kind === 'note' ? 'butter' : 'neutral' });
    updateBoard(value => ({ ...value, nodes: [...value.nodes.map(node => ({ ...node, selected: false })), { ...node, selected: true }] }), true);
    setEditingId(node.id);
  }, [flow, updateBoard]);

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    const resize = () => {
      setReadingFrame(planReadingFrame(window.innerWidth, window.innerHeight));
      if (viewRef.current === 'plan') fit();
    };
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [fit]);
  useEffect(() => { const timer = setTimeout(fit, 150); return () => clearTimeout(timer); }, [board.id, fit]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight, behavior: 'smooth' }); }, [board.messages, busy, chatOpen]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
      else if (event.key === 'v') setTool('select');
      else if (event.key === 'h') setTool('hand');
      else if (event.key === 'n') addCard('note');
      else if (event.key === '1') fitAll();
      else if (event.key === 'Escape') { setBoardMenu(false); setTeamOpen(false); setModeOpen(false); setExportOpen(false); setChatOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, addCard, fitAll]);

  function switchBoard(id: string) {
    commit({ ...workspaceRef.current, activeId: id });
    setBoardMenu(false); setEditingId(null); setError(''); setChatOpen(false);
  }
  function createBoard(template: 'blank' | 'trip' | 'project', title: string) {
    const next = arrangeBoard(makeBoard(template, title));
    commit({ ...workspaceRef.current, activeId: next.id, boards: [next, ...workspaceRef.current.boards] });
    setNewBoard(false); setBoardMenu(false); setChatOpen(false); setError('');
  }
  function download(format: 'json' | 'md') {
    const current = workspaceRef.current.boards.find(item => item.id === workspaceRef.current.activeId)!;
    const blob = new Blob([format === 'json' ? JSON.stringify({ version: 1, board: current }, null, 2) : boardMarkdown(current)], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${current.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'muse-board'}.${format}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setExportOpen(false);
  }
  async function importBoard(file: File) {
    try {
      if (file.size > 4_000_000) throw new Error('Choose a board file smaller than 4 MB.');
      const value = JSON.parse(await file.text());
      if (value.version !== 1 || !isBoard(value.board)) throw new Error('This file is not a Muse board.');
      const imported: Board = { ...value.board, id: uid(), updatedAt: Date.now() };
      commit({ ...workspaceRef.current, activeId: imported.id, boards: [imported, ...workspaceRef.current.boards] });
      setBoardMenu(false); setChatOpen(false); notify('Your board is here.');
    } catch (error) { notify(error instanceof Error ? error.message : 'This board could not be imported.'); }
  }
  function chooseAgent(agent: MuseMode) { setMode(agent); setModeOpen(false); composerRef.current?.focus(); }
  function connect(connection: Connection) { updateBoard(value => ({ ...value, edges: addEdge({ ...connection, type: 'smoothstep' }, value.edges) }), true); }

  async function send() {
    const text = draft.trim();
    if (!text || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const boardId = board.id;
    const preferences = workspaceRef.current.preferences;
    let expected = workspaceRef.current.boards.find(item => item.id === boardId)!;
    if (!expected.messages.length && expected.nodes.some(node => node.id.startsWith('trip-'))) expected = { ...expected, nodes: [], edges: [] };
    if (!expected.nodes.length) {
      expected = { ...expected, title: text.length > 54 ? `${text.slice(0,51)}…` : text, nodes: [card('user-brief', 0, 0, { kind: 'note', title: 'The goal', body: text, color: 'neutral', eyebrow: 'YOUR BRIEF' }, 300)] };
    }
    expected = arrangeBoard({ ...expected, messages: [...expected.messages, { id: uid(), role: 'user', text }] });
    updateBoard(() => expected, false, boardId);
    setDrafts(value => ({ ...value, [boardId]: '' }));
    setBusy({ boardId, agent: mode === 'team' ? 'planner' : mode }); setChatOpen(false); setError('');
    setTimeout(fit, 120);
    let ended = false;
    try {
      const response = await fetch('/api/muse/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, board: expected, mode, preferences, selectedIds: selected.map(node => node.id) }), signal: controller.signal });
      if (!response.ok) { const value = await response.json(); throw new Error(value.error || 'Muse could not connect. Please try again.'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Muse could not open the conversation.');
      const decoder = new TextDecoder(); let buffer = '';
      const receive = (event: StreamEvent) => {
        if (controller.signal.aborted) return;
        if (event.type === 'working') setBusy({ boardId, agent: event.agent });
        if (event.type === 'result') {
          const baseline = expected;
          updateBoard(value => {
            const result = applyTurn(value, event.turn, baseline);
            if (result.conflicts) notify('Kept your newer edits on the board.');
            return { ...result.board, messages: [...result.board.messages, { id: uid(), role: 'assistant', agent: event.turn.agent, text: event.turn.reply, changes: event.turn.cards.length + event.turn.removeCardIds.length }] };
          }, true, boardId);
          expected = applyTurn(expected, event.turn).board;
          if (workspaceRef.current.activeId === boardId) setTimeout(fit, 100);
        }
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'done') ended = true;
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) receive(JSON.parse(line));
        if (done) { if (buffer.trim()) receive(JSON.parse(buffer)); break; }
      }
      if (!ended) throw new Error('The connection ended before the Muses finished. Completed cards are saved.');
    } catch (error) {
      if (controller.signal.aborted) notify('Stopped. Completed thoughts stay on your board.');
      else { setError(error instanceof Error ? error.message : 'Muse could not connect. Please try again.'); setDrafts(value => ({ ...value, [boardId]: value[boardId] || text })); }
    } finally {
      controller.abort();
      requestRef.current = null; setBusy(null);
    }
  }

  const actions = {
    edit: setEditingId,
    duplicate(id: string) { updateBoard(value => { const source = value.nodes.find(node => node.id === id)!; return { ...value, nodes: [...value.nodes, { ...structuredClone(source), id: uid(), position: { x: source.position.x + 42, y: source.position.y + 42 }, selected: false }] }; }, true); },
    remove(id: string) { updateBoard(value => ({ ...value, nodes: value.nodes.filter(node => node.id !== id), edges: value.edges.filter(edge => edge.source !== id && edge.target !== id) }), true); },
    toggle(id: string, item: string) { updateBoard(value => ({ ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, checked: node.data.checked.includes(item) ? node.data.checked.filter(text => text !== item) : [...node.data.checked, item] } } : node) }), true); },
    ask: chooseAgent, working,
    read(id: string) {
      viewRef.current = 'plan'; setView('plan'); fit();
      setTimeout(() => {
        const section = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-section]')).find(element => element.dataset.planSection === id);
        if (section) section.closest('.muse-document-scroll')?.scrollTo({ top: section.offsetTop - 30, behavior: 'smooth' });
      }, 50);
    },
  };

  return <main className="muse-shell">
    <div className="muse-canvas-stage" aria-label="Muse whiteboard">
      <BoardActions.Provider value={actions}>
        <ReactFlow<MuseNode> key={board.id} nodes={board.nodes.filter(node => !['agent', 'heading'].includes(node.data.kind)).map(node => ({ ...node, position: { x: node.position.x + 2200, y: node.position.y } }))} edges={board.edges} nodeTypes={museNodeTypes} minZoom={.15} maxZoom={2} colorMode="dark" proOptions={{ hideAttribution: true }}
          onNodesChange={changes => updateBoard(value => { const next = { ...value, nodes: applyNodeChanges(changes, value.nodes) }; if (changes.some(change => change.type === 'dimensions')) { setTimeout(fit, 100); return arrangeBoard(next); } return next; })}
          onEdgesChange={changes => updateBoard(value => ({ ...value, edges: applyEdgeChanges(changes, value.edges) }))}
          onNodeDragStart={() => remember(board)} onSelectionDragStart={() => remember(board)} onConnect={connect}
          onBeforeDelete={async ({ nodes, edges }) => { remember(board); return { nodes: nodes.filter(node => node.data.kind !== 'agent'), edges }; }}
          onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} onInit={() => setTimeout(fit, 100)}
          onPaneClick={() => { setBoardMenu(false); setTeamOpen(false); setModeOpen(false); setExportOpen(false); }}
          nodesDraggable={false} panOnDrag selectionOnDrag={false} selectionKeyCode="Shift" panOnScroll zoomOnScroll={false} zoomOnPinch defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#a1a7af', strokeWidth: 1.6 } }} deleteKeyCode={['Backspace', 'Delete']}
        >
          {!!board.nodes.length && <ViewportPortal><div className="muse-document-box nodrag nopan nowheel" style={{ transform: 'translate(0px, 0px)', width: readingFrame.width, '--muse-document-height': `${readingFrame.height}px` } as CSSProperties}><PlanView board={board} edit={setEditingId} toggle={actions.toggle} record={() => remember(workspaceRef.current.boards.find(item => item.id === workspaceRef.current.activeId)!)} update={(id, patch) => updateBoard(value => ({ ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node) }))}/></div></ViewportPortal>}
        </ReactFlow>
      </BoardActions.Provider>
    </div>
    <FloatingMuses key={board.id} board={board} working={working} running={busy?.boardId === board.id} ask={chooseAgent}/>
    {working && <div className="muse-work-status" role="status"><span className="muse-activity-pulse"/><strong>{AGENTS[working].name}</strong><span>{AGENT_ACTIVITY[working]}</span><small>{mode === 'team' ? `${Object.keys(AGENTS).indexOf(working) + 1} / 4` : 'Working'}</small></div>}

    <header className="muse-topbar">
      <div className="muse-project-pill">
        <button className="muse-brand" title="Your boards" aria-label="Your boards" onClick={() => setBoardMenu(!boardMenu)}><MuseGlyph/><span>muse</span></button>
        <span className="muse-divider"/>
        <input className="muse-project-name" aria-label="Board name" maxLength={100} value={board.title} onChange={event => updateBoard(value => ({ ...value, title: event.target.value }))} onBlur={() => { if (!board.title.trim()) updateBoard(value => ({ ...value, title: 'Untitled board' })); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
        <button className="muse-icon-button" aria-label="Switch board" aria-expanded={boardMenu} onClick={() => setBoardMenu(!boardMenu)}><ChevronDown size={14}/></button>
      </div>
      <div className="muse-save-status" role="status">{saveStatus === 'Saved locally' ? <Check size={12}/> : saveStatus === 'Saving…' ? <LoaderCircle size={12}/> : <span>!</span>}{saveStatus}</div>
      <div className="muse-top-actions">
        <button className="muse-view-jump" aria-label="Go to canvas map" title="Canvas: Explore the connected structure of your plan." aria-pressed={view === 'canvas'} onClick={() => { viewRef.current = 'canvas'; setView('canvas'); fit(); }}><LayoutGrid size={14}/>Canvas</button>
        <button className="muse-view-jump" aria-label="Go to plan" title="Plan: Read and edit your plan from the beginning." aria-pressed={view === 'plan'} onClick={() => { viewRef.current = 'plan'; setView('plan'); fit(); const document = window.document.querySelector('.muse-document-scroll'); if (document) document.scrollTop = 0; }}><ListChecks size={14}/>Plan</button>
        <button className={`muse-team-trigger ${teamOpen ? 'active' : ''}`} onClick={() => setTeamOpen(!teamOpen)} aria-expanded={teamOpen}><span className="muse-avatar-stack">{(Object.keys(AGENTS) as AgentId[]).map(agent => <MuseGlyph key={agent} agent={agent}/>)}</span><span>Your Muses</span><ChevronDown size={13}/></button>
        <button className="muse-top-icon" aria-label="Your preferences" title="Your preferences" onClick={() => setPreferencesOpen(true)}><Settings2 size={17}/></button>
        <button className="muse-export-trigger" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}><ArrowDownToLine size={15}/><span>Export</span></button>
      </div>
    </header>

    {boardMenu && <section className="muse-board-menu muse-popover" aria-label="Your boards"><div className="muse-popover-heading"><span>Your space</span><button className="muse-icon-button" aria-label="New board" onClick={() => setNewBoard(true)}><Plus size={17}/></button></div><div className="muse-search"><Search size={14}/><input aria-label="Search boards" placeholder="Find a thought…" value={boardSearch} onChange={event => setBoardSearch(event.target.value)}/></div><div className="muse-board-list">{workspace.boards.filter(item => item.title.toLowerCase().includes(boardSearch.toLowerCase())).map(item => <button key={item.id} className={item.id === board.id ? 'active' : ''} onClick={() => switchBoard(item.id)}><span>{item.emoji}</span><div><strong>{item.title || 'Untitled board'}</strong><small>{item.nodes.filter(node => !['heading', 'agent'].includes(node.data.kind)).length} thoughts</small></div>{item.id === board.id && <Check size={13}/>}</button>)}</div><button className="muse-menu-action" onClick={() => setNewBoard(true)}><Plus size={15}/>New board</button><button className="muse-menu-action" onClick={() => importRef.current?.click()}><Upload size={14}/>Import a board</button></section>}
    <input hidden ref={importRef} type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importBoard(file); event.target.value = ''; }}/>
    {exportOpen && <div className="muse-export-menu muse-popover"><button onClick={() => download('json')}><Download size={15}/><div>Board file<small>Reopen and keep creating</small></div></button><button onClick={() => download('md')}><Type size={15}/><div>Markdown<small>Take the outline with you</small></div></button></div>}
    {teamOpen && <section className="muse-team-panel muse-popover"><div className="muse-popover-heading"><span>Your Muses</span><button className="muse-icon-button" aria-label="Close Muses" onClick={() => setTeamOpen(false)}><X size={15}/></button></div><p>Four perspectives. One shared plan.</p>{(Object.keys(AGENTS) as AgentId[]).map(agent => <button className="muse-team-detail" key={agent} onClick={() => { chooseAgent(agent); setTeamOpen(false); }}><MuseGlyph agent={agent}/><div><strong>{AGENTS[agent].name}</strong><p>{AGENTS[agent].description}</p><span>Think with {AGENTS[agent].name}<ArrowUp size={11}/></span></div></button>)}<button className="muse-menu-action" onClick={() => { chooseAgent('team'); setTeamOpen(false); }}><Users size={15}/>Bring everyone in</button></section>}

    <nav className="muse-tools" aria-label="Whiteboard tools">
      <button aria-label="Select tool" aria-pressed={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={18}/><span className="muse-tool-tip"><strong>Select · V</strong>Click a card to edit, duplicate, or delete it.</span></button>
      <button aria-label="Pan tool" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}><Hand size={17}/><span className="muse-tool-tip"><strong>Move around · H</strong>Drag the background to explore the canvas.</span></button>
      <span/>
      <button className="muse-tool-note" aria-label="Add note" onClick={() => addCard('note')}><StickyNote size={18}/><span className="muse-tool-tip"><strong>Add a note · N</strong>Put your own thought into the shared plan.</span></button>
      <button className="muse-tool-text" aria-label="Add outline" onClick={() => addCard('text')}><Type size={19}/><span className="muse-tool-tip"><strong>Add an outline</strong>Give an idea a title, details, and key points.</span></button>
      <button className="muse-tool-check" aria-label="Add checklist" onClick={() => addCard('checklist')}><ListChecks size={18}/><span className="muse-tool-tip"><strong>Add a checklist</strong>Keep track of the next steps as you finish them.</span></button>
      <span/>
      <button aria-label="Personalize your Muses" onClick={() => setPreferencesOpen(true)}><span className="muse-user-avatar">{workspace.preferences.name.slice(0, 1).toUpperCase() || 'Y'}</span><span className="muse-tool-tip"><strong>Your preferences</strong>Tell your Muses what matters to you.</span></button>
    </nav>

    <div className="muse-bottom-controls"><button title="Undo · ⌘Z" aria-label="Undo" disabled={!activeHistory?.past.length} onClick={() => undo()}><Undo2 size={15}/></button><button title="Redo · ⇧⌘Z" aria-label="Redo" disabled={!activeHistory?.future.length} onClick={() => undo(true)}><Redo2 size={15}/></button><span/><button title="Zoom out" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 200 })}><Minus size={14}/></button><button className="muse-zoom" title="Fit board · 1" aria-label="Fit board" onClick={fitAll}>{zoom}%</button><button title="Zoom in" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 200 })}><Plus size={14}/></button><button title="Fit board · 1" aria-label="Fit all cards" onClick={fitAll}><Maximize size={14}/></button></div>
    <button className="muse-canvas-help" onClick={() => setShortcutsOpen(true)} aria-label="Canvas shortcuts">?</button>

    <section className="muse-chat-dock" aria-label="Chat with your Muses">
      <div className="muse-chat-title"><span><MessageCircle size={12}/>{board.messages.length ? 'Team chat' : 'What would you like to plan?'}</span><button aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}><ListChecks size={12}/>Activity</button></div>
      {activityOpen && <div className="muse-activity-panel"><strong>Team activity</strong>{(Object.keys(AGENTS) as AgentId[]).map(agent => { const message = board.messages.filter(message => message.agent === agent).at(-1); return <div key={agent}><MuseGlyph agent={agent}/><div><span>{AGENTS[agent].name}<small>{working === agent ? 'Working' : message ? 'Done' : 'Ready'}</small></span><p>{working === agent ? AGENT_ACTIVITY[agent] : message?.text || AGENTS[agent].description}</p></div></div>; })}</div>}
      {!!board.messages.length && <div className="muse-chat-handle"><button onClick={() => setChatOpen(!chatOpen)} aria-expanded={chatOpen}><MessageCircle size={12}/>{working ? `${AGENTS[working].name} is thinking` : 'The conversation'}{chatOpen ? <ChevronDown size={13}/> : <ChevronUp size={13}/>}</button></div>}
      {chatOpen && !!board.messages.length && <div className="muse-conversation" ref={conversationRef} aria-live="polite" aria-relevant="additions"><div className="muse-conversation-heading"><span>THINKING TOGETHER</span><button aria-label="Minimize conversation" onClick={() => setChatOpen(false)}><Minus size={16}/></button></div>{board.messages.map(message => <div key={message.id} className={`muse-message ${message.role}`}>
        {message.role === 'assistant' ? <MuseGlyph agent={message.agent}/> : <span className="muse-message-avatar">{workspace.preferences.name.slice(0, 1) || 'Y'}</span>}
        <div><strong>{message.role === 'user' ? 'You' : message.agent ? AGENTS[message.agent].name : 'Muse'}</strong><p>{message.text}</p>{!!message.changes && <button className="muse-change-link" onClick={() => { setChatOpen(false); fit(); }}><Check size={11}/>{message.changes} board {message.changes === 1 ? 'change' : 'changes'}<ArrowUp size={11}/></button>}</div>
      </div>)}{busy?.boardId === board.id && <div className="muse-thinking"><MuseGlyph agent={working || undefined}/><span>{working ? `${AGENTS[working].name} is finding the next thread` : 'Gathering your Muses'}<i/><i/><i/></span></div>}</div>}
      {error && <div className="muse-chat-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13}/></button></div>}
      {!board.messages.length && <div className="muse-suggestions">{['Plan a trip', 'Build something', 'Learn a skill', 'Organize an event'].map((text, index) => <button key={text} onClick={() => { setDrafts(value => ({ ...value, [board.id]: ['Help me plan a trip to ', 'I want to build ', 'Help me make a learning plan for ', 'Help me organize '][index] })); composerRef.current?.focus(); }}><Sparkles size={11}/>{text}</button>)}</div>}
      <form className="muse-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <div className="muse-mode-wrap"><button type="button" className="muse-mode-button" aria-expanded={modeOpen} onClick={() => setModeOpen(!modeOpen)}>{mode === 'team' ? <MuseGlyph/> : <MuseGlyph agent={mode}/>}<span>{mode === 'team' ? 'All Muses' : AGENTS[mode].name}</span><ChevronDown size={11}/></button>
          {modeOpen && <div className="muse-mode-menu muse-popover">{(['team', 'planner', 'explorer', 'critic', 'organizer'] as MuseMode[]).map(item => <button type="button" key={item} onClick={() => chooseAgent(item)}>{item === 'team' ? <MuseGlyph/> : <MuseGlyph agent={item}/>}<div><strong>{item === 'team' ? 'All Muses' : AGENTS[item].name}</strong><small>{item === 'team' ? 'One shared plan, four perspectives' : AGENTS[item].tagline}</small></div>{mode === item && <Check size={13}/>}</button>)}</div>}
        </div>
        <span className="muse-divider"/>
        <textarea ref={composerRef} rows={1} aria-label="Message your Muses" placeholder={mode === 'team' ? 'Describe what you want to plan…' : `Talk to ${AGENTS[mode].name}…`} value={draft} maxLength={6000} onChange={event => setDrafts(value => ({ ...value, [board.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
        {!!selected.length && <span className="muse-context-count" title={`${selected.length} selected cards in context`}>{selected.length}<StickyNote size={11}/></span>}
        {busy ? <button type="button" className="muse-send is-stop" aria-label="Stop Muses" title="Stop" onClick={() => requestRef.current?.abort()}><Square size={13} fill="currentColor"/></button> : <button type="submit" className="muse-send" aria-label="Send message" disabled={!draft.trim()}><ArrowUp size={18}/></button>}
      </form>
      <div className="muse-composer-caption"><span className="muse-live-dot"/>{mode === 'team' ? 'Your Muses work on one plan, together.' : `${AGENTS[mode].name} · ${AGENTS[mode].tagline}`}<span className="muse-enter-hint">↵ to send</span></div>
    </section>

    {toast && <div className="muse-toast" role="status"><Check size={14}/>{toast}</div>}
    {recovery && <div className="muse-recovery" role="alert">{recovery}<button aria-label="Dismiss recovery message" onClick={dismissRecovery}><X size={14}/></button></div>}
    {editing && <CardEditor key={editing.id} data={editing.data} close={() => setEditingId(null)} save={data => { updateBoard(value => ({ ...value, nodes: value.nodes.map(node => node.id === editing.id ? { ...node, data } : node) }), true); setEditingId(null); }}/ >}
    {preferencesOpen && <PreferencesEditor preferences={workspace.preferences} close={() => setPreferencesOpen(false)} save={preferences => { commit({ ...workspaceRef.current, preferences }); setPreferencesOpen(false); notify('Your Muses will keep that in mind.'); }}/ >}
    {newBoard && <NewBoardDialog close={() => setNewBoard(false)} create={createBoard}/ >}
    {shortcutsOpen && <MuseDialog title="A little room to move." close={() => setShortcutsOpen(false)}><div className="muse-shortcuts">{[['V', 'Select & move cards'], ['H', 'Pan around the canvas'], ['N', 'Add a thought'], ['1', 'Fit everything into view'], ['⌘ / Ctrl Z', 'Undo a board change'], ['Shift + ⌘ / Ctrl Z', 'Redo'], ['Double-click', 'Edit a card'], ['Drag between dots', 'Connect two thoughts'], ['Shift + Enter', 'A new line in chat']].map(([key, label]) => <div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div></MuseDialog>}
  </main>;
}
