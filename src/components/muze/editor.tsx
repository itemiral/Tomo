'use client';

import {NameOnCanvas} from '../muse/name-on-canvas';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlignCenter, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowDownToLine, ArrowUpRight, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Hexagon, Heart, Cloud, LockKeyhole, UnlockKeyhole, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, Scissors, Clipboard, Magnet, Bold, Italic, Underline, BringToFront, Check, ChevronDown, ChevronUp, Circle, Copy, Diamond, Eraser, FilePlus2, FolderOpen, Frame, Grid2X2, Group, Hand, Highlighter, ImagePlus, Keyboard, Layers, Maximize, Menu, Minus, MessageCircle, MoreHorizontal, MousePointer2, MoveUpRight, Pencil, Plus, Redo2, SendToBack, Settings2, Share2, Square, SquareDashed, Star, StickyNote, Sun, Moon, Trash2, Triangle, Type, Undo2, Ungroup, X, Zap } from 'lucide-react';
import { WhiteboardEngine, INITIAL_EDITOR, INITIAL_PAINT, type EditorState, type Paint, type Tool } from './engine';
import { download, filename, newBoard, newPage, openStorage, parseBoardFile, readStorage, saveStorage, type Board, type Drawing, type Workspace } from './storage';
import { Point } from 'fabric';
import { COLORS, FONTS, SIZES } from './styles';
import type { Arrowhead } from './objects';
import { gridPattern } from './grid';
import { MIN_ZOOM, MAX_ZOOM } from './zoom';
import { createSaveFeedback } from './save-feedback';
import { CanvasTooltips } from './tooltips';
import { useSharedBoard } from './use-shared-board';
import { SharePanel } from './share-panel';
import { useBoardPresence } from './use-board-presence';
import { useBoardProfiles } from './use-board-profiles';
import { BoardParticipants, BoardPeerCursors, BoardPeerMuses } from './board-presence';
import './whiteboard.css';
import { SignInButton, UserButton, useUser } from '@clerk/nextjs';
import { CanvasComments } from './comments';
import { useMuseCanvas } from '../muse/use-muse-canvas';
import { MuseCompanion } from '../muse/companion';
import { normalizeImageFile } from '../muse/image-upload';
import { SignInToShare } from '../muse/sign-in';
import { boardContext as makeBoardContext } from '@/lib/muse-board';

const TOOLS: Record<Tool, { name: string; icon: typeof MousePointer2; key: string; hint: string }> = {
  comment: { name:'Comment', icon:MessageCircle, key:'C', hint:'Click a spot on the canvas to leave a comment.' },
  select: { name: 'Select', icon: MousePointer2, key: 'V', hint: 'Move, resize, rotate, or select several objects.' },
  hand: { name: 'Hand', icon: Hand, key: 'H', hint: 'Grab the canvas and move around. You can also hold Space.' },
  draw: { name: 'Draw', icon: Pencil, key: 'D', hint: 'Sketch a freehand line with your mouse or pen.' },
  eraser: { name: 'Eraser', icon: Eraser, key: 'E', hint: 'Drag over objects to erase them. Undo brings them back.' },
  arrow: { name: 'Arrow', icon: ArrowUpRight, key: 'A', hint: 'Connect shapes. Attached arrows follow them as they move.' },
  text: { name: 'Text', icon: Type, key: 'T', hint: 'Click to write. Double-click existing text to edit it.' },
  note: { name: 'Note', icon: StickyNote, key: 'N', hint: 'Add a sticky note for a thought or reminder.' },
  rectangle: { name: 'Rectangle', icon: Square, key: 'R', hint: 'Drag to draw a rectangle. Hold Shift for a square.' },
  ellipse: { name: 'Ellipse', icon: Circle, key: 'O', hint: 'Draw an ellipse. Hold Shift for a circle.' },
  triangle: { name: 'Triangle', icon: Triangle, key: '', hint: 'Draw a triangle on the canvas.' },
  diamond: { name: 'Diamond', icon: Diamond, key: '', hint: 'Mark a decision or a step in a diagram.' },
  star: { name: 'Star', icon: Star, key: '', hint: 'Mark a favorite or highlight an idea.' },
  hexagon: { name: 'Hexagon', icon: Hexagon, key: '', hint: 'Draw a hexagon. Double-click to add a label.' },
  oval: { name: 'Oval', icon: Circle, key: '', hint: 'Draw a rounded capsule.' },
  rhombus: { name: 'Rhombus', icon: Diamond, key: '', hint: 'Draw a slanted box.' },
  cloud: { name: 'Cloud', icon: Cloud, key: '', hint: 'Draw a cloud around an idea.' },
  heart: { name: 'Heart', icon: Heart, key: '', hint: 'Draw a heart.' },
  'x-box': { name: 'X box', icon: Square, key: '', hint: 'Draw a box with a cross.' },
  'check-box': { name: 'Check box', icon: Square, key: '', hint: 'Draw a box with a check mark.' },
  'arrow-left': { name: 'Arrow left', icon: ArrowLeft, key: '', hint: 'Draw a block arrow pointing left.' },
  'arrow-right': { name: 'Arrow right', icon: ArrowRight, key: '', hint: 'Draw a block arrow pointing right.' },
  'arrow-up': { name: 'Arrow up', icon: ArrowUp, key: '', hint: 'Draw a block arrow pointing up.' },
  'arrow-down': { name: 'Arrow down', icon: ArrowDown, key: '', hint: 'Draw a block arrow pointing down.' },
  line: { name: 'Line', icon: Minus, key: 'L', hint: 'Draw a straight line between two points.' },
  highlight: { name: 'Highlighter', icon: Highlighter, key: '⇧ D', hint: 'Emphasize an area with a translucent stroke.' },
  frame: { name: 'Frame', icon: Frame, key: 'F', hint: 'Draw a boundary around a part of your board.' },
  laser: { name: 'Laser', icon: Zap, key: 'K', hint: 'Point things out with a temporary light trail.' },
};
const PRIMARY: Tool[] = ['select', 'hand', 'note', 'rectangle', 'arrow', 'text'];
const MORE: Tool[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'oval', 'rhombus', 'star', 'cloud', 'heart', 'x-box', 'check-box', 'arrow-left', 'arrow-up', 'arrow-down', 'arrow-right', 'line', 'highlight', 'laser', 'frame', 'note', 'eraser'];
type Popup = 'menu' | 'pages' | 'export' | 'tools' | 'actions' | 'zoom' | 'shortcuts' | 'context' | null;

function Button({ label, hint, shortcut, active, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; hint?: string; shortcut?: string; active?: boolean }) {
  return <button {...props} type="button" aria-label={label} aria-pressed={active} data-tooltip={label + (shortcut ? '  ·  ' + shortcut : '') + (hint ? '\n' + hint : '')} className={'muze-button ' + (active ? 'active ' : '') + className}>{children}</button>;
}
function ToolButton({ tool, current, choose, compact }: { tool: Tool; current: Tool; choose: (tool: Tool) => void; compact?: boolean }) {
  const value = TOOLS[tool], Icon = value.icon;
  return <Button label={value.name} hint={value.hint} shortcut={value.key} active={current === tool} onClick={() => choose(tool)} className={compact ? 'tool-compact' : ''} data-testid={'tool-' + tool}><Icon size={20} strokeWidth={1.65}/></Button>;
}

function DrawingSurface({ drawing, pageId, changed, update, ready, report }: { drawing: Drawing; pageId: string; changed: (drawing: Drawing) => void; update: (state: EditorState) => void; ready: (engine: WhiteboardEngine | null) => void; report: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ changed, update, ready, report }); callbacks.current = { changed, update, ready, report };
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const holder = document.createElement('div'), canvas = document.createElement('canvas'), vector = document.createElement('div');
    vector.className = 'muze-vector-surface'; host.current!.append(vector);
    canvas.setAttribute('aria-label', 'Whiteboard drawing canvas'); canvas.setAttribute('role', 'img');
    holder.append(canvas); host.current!.append(holder);
    const engine = new WhiteboardEngine(canvas, value => callbacks.current.changed(value), value => callbacks.current.update(value), value => callbacks.current.report(value));
    let previous = '';
    engine.onRender = svg => { if (svg !== previous) { vector.innerHTML = svg; previous = svg; } };
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    engine.onLaser = point => { setLaser(point); clearTimeout(timer); timer = setTimeout(() => setLaser(null), 700); };
    callbacks.current.ready(engine);
    void engine.load(drawing).catch(() => { if (mounted) callbacks.current.report('This page could not be opened. Your saved copy is still on this device.'); });
    return () => { mounted = false; clearTimeout(timer); callbacks.current.ready(null); engine.dispose(); holder.remove(); vector.remove(); };
    // Each page owns a canvas instance; edits flow out without reloading it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  return <div ref={host} className="muze-drawing-surface">{laser && <span className="muze-laser" style={{ left: laser.x, top: laser.y }}/>}</div>;
}

function Minimap({ editor, navigate }: { editor: EditorState; navigate: (point: Point) => void }) {
  const drag = useRef<{ left: number; top: number; scale: number } | null>(null);
  const items = editor.items, left = Math.min(0, ...items.map(b => b.x)), top = Math.min(0, ...items.map(b => b.y));
  const right = Math.max(window.innerWidth, ...items.map(b => b.x + b.w)), bottom = Math.max(window.innerHeight, ...items.map(b => b.y + b.h));
  const scale = Math.min(190 / (right - left), 110 / (bottom - top));
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(), transform = drag.current || { left, top, scale };
    navigate(new Point(transform.left + ((event.clientX - bounds.left) / bounds.width * 210 - 10) / transform.scale, transform.top + ((event.clientY - bounds.top) / bounds.height * 130 - 10) / transform.scale));
  };
  return <div className="muze-minimap" aria-label="Minimap"><svg viewBox="0 0 210 130" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { left, top, scale }; move(event); }} onPointerMove={event => { if (drag.current) move(event); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><rect width="210" height="130" fill="var(--canvas)"/><g transform={`translate(10 10) scale(${scale}) translate(${-left} ${-top})`}>{items.map((b, i) => <rect key={i} x={b.x} y={b.y} width={Math.max(3, b.w)} height={Math.max(3, b.h)} fill="#a7b6cd" rx={3 / scale}/>)}<rect x={-editor.viewport[4] / editor.zoom} y={-editor.viewport[5] / editor.zoom} width={window.innerWidth / editor.zoom} height={window.innerHeight / editor.zoom} fill="#3278ef12" stroke="#3278ef" strokeWidth={1 / scale}/></g></svg></div>;
}

export default function MuzeEditor() {
  const { isSignedIn, user } = useUser();
  const currentOwner=useRef(user?.id);currentOwner.current=user?.id;
  const museCanvas = useMuseCanvas(isSignedIn ? user?.id : undefined);
  const privateBoardRef = useRef<Board | null>(null); privateBoardRef.current = museCanvas.board;
  const [museOpen, setMuseOpen] = useState(false);
  const [appearanceRequest,setAppearanceRequest]=useState(0);
  const [chatRequest, setChatRequest] = useState(0);
  const [museWorking,setMuseWorking] = useState(false);
  const museActive = useRef(false); museActive.current = museOpen;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const current = useRef<Workspace | null>(null), db = useRef<IDBDatabase | null>(null), engine = useRef<WhiteboardEngine | null>(null);
  const shared = useSharedBoard(isSignedIn ? user?.id : undefined, () => !engine.current || engine.current.canReceiveSharedChanges());
  const sharedRef=useRef(shared);sharedRef.current=shared;
  const [editor, setEditor] = useState(INITIAL_EDITOR), [paint, setPaint] = useState(INITIAL_PAINT);
  const updateEditor = useCallback((value: EditorState) => { setEditor(value); setPaint(value.paint); }, []);
  const [dockHeight,setDockHeight]=useState(58);
  const [popup, setPopup] = useState<Popup>(null), [grid, setGrid] = useState(false), [dark, setDark] = useState(false), [minimap, setMinimap] = useState(false), [stylesOpen, setStylesOpen] = useState(false);
  const [toast, setToast] = useState(''), [contextPoint, setContextPoint] = useState({ x: 0, y: 0 });
  const [commentPlacement,setCommentPlacement]=useState<{x:number;y:number;nonce:number}|null>(null);
  const [renameDocument,setRenameDocument]=useState<{id:string;title:string}|null>(null);
  const [name, setName] = useState('Untitled board');
  const boardInput = useRef<HTMLInputElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const saveFeedback = useRef<ReturnType<typeof createSaveFeedback> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const feedback = createSaveFeedback(() => {}, () => setToast('Could not save locally. Export a board file to keep your work.'));
    saveFeedback.current = feedback;
    void openStorage().then(async database => {
      if (cancelled) { database.close(); return; }
      db.current = database;
      const saved = await readStorage(database);
      // Persist the initial IDs before chat/tasks can attach history to this board.
      await saveStorage(database,saved);
      if (cancelled) return;
      current.current = saved; setWorkspace(saved);
      setDark(localStorage.getItem('muze.theme') === 'dark');
      setGrid(localStorage.getItem('muze.grid') === 'true');
    }).catch(() => { if (!cancelled) setToast('Local storage is unavailable. Enable browser storage and reload.'); });
    return () => { cancelled = true; feedback.dispose(); saveFeedback.current = null; db.current?.close(); db.current = null; };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  const commit = useCallback((next: Workspace) => {
    current.current = next; setWorkspace(next);
    const database = db.current;
    void saveFeedback.current?.track(() => database ? saveStorage(database, next) : Promise.reject(new Error('Local storage is unavailable.')), next.activeBoard);
  }, []);
  const ordinary = workspace?.boards.find(board => board.id === workspace.activeBoard);
  const active = museOpen ? museCanvas.board : shared.boardId ? shared.board : ordinary;
  const page = active?.pages.find(item => item.id === active.activePage);
  const presence = useBoardPresence({boardId:shared.board?.id,userId:isSignedIn?user?.id:undefined,name:user?.firstName||user?.username||'Guest',pageId:page?.id,viewport:editor.viewport,enabled:!!shared.board&&!museOpen&&!!isSignedIn,museWorking});
  const participantProfiles=useBoardProfiles({boardId:shared.board?.id,userId:isSignedIn?user?.id:undefined,enabled:!!shared.board&&!museOpen&&!!isSignedIn,connected:presence.connected,peerIds:presence.peers.map(person=>person.userId),profileVersion:JSON.stringify([user?.firstName,user?.username,user?.imageUrl])});
  useEffect(() => { if (active) setName(active.name); }, [active?.id, active?.name]);
  const updateBoard = useCallback((update: (board: Board) => Board) => {
    if (museActive.current) { museCanvas.update(update); return; }
    if(sharedRef.current.boardId){sharedRef.current.update(update);return;}
    const value = current.current; if (!value) return;
    commit({ ...value, boards: value.boards.map(board => board.id === value.activeBoard ? update(board) : board) });
  }, [commit, museCanvas.update]);
  const changeDrawing = useCallback((drawing: Drawing) => updateBoard(board => ({ ...board, pages: board.pages.map(p => p.id === board.activePage ? { ...p, ...drawing } : p) })), [updateBoard]);
  const mount = useCallback((value: WhiteboardEngine | null) => { engine.current = value; if (value) { value.onComment=point=>setCommentPlacement({...point,nonce:Date.now()}); value.setEnabled(true); value.paint = { ...INITIAL_PAINT }; value.setDark(dark); value.grid = grid; setPaint(INITIAL_PAINT); } }, [dark, grid]);
  useEffect(() => { setPopup(null); setStylesOpen(false); }, [museOpen]);
  useEffect(() => { setMuseOpen(false); }, [user?.id]);
  useEffect(() => { engine.current?.setDark(dark); }, [dark]);
  useEffect(() => { if (engine.current) engine.current.grid = grid; }, [grid]);
  useEffect(()=>{if(museOpen&&editor.ready&&appearanceRequest){if(engine.current?.focusAppearance())setAppearanceRequest(0);}},[museOpen,editor.ready,appearanceRequest]);
  useEffect(()=>{
    if(popup!=='tools')return;
    const trigger=document.querySelector<HTMLButtonElement>('[data-more-trigger]'),panel=document.querySelector<HTMLElement>('.muze-more-tools');
    const outside=(event:PointerEvent)=>{if(!(event.target as Element).closest('.muze-toolbar-dock')&&!panel?.contains(event.target as Node)&&!trigger?.contains(event.target as Node))setPopup(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setPopup(null);trigger?.focus();}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);panel?.querySelector<HTMLButtonElement>('button')?.focus();
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
  },[popup]);
  useEffect(()=>{const dock=document.querySelector('.muze-toolbar-dock');if(!dock)return;const observer=new ResizeObserver(()=>setDockHeight(dock.getBoundingClientRect().height));observer.observe(dock);return()=>observer.disconnect();},[editor.ready,active?.id,page?.id]);
  const chooseTool = (tool: Tool) => { engine.current?.setTool(tool); setPopup(null); setChatRequest(value=>value-1); };
  const applyPaint = (patch: Partial<Paint>) => { setPaint(value => ({ ...value, ...patch })); engine.current?.applyPaint(patch); };
  const togglePopup = (value: Popup) => setPopup(p => p === value ? null : value);
  function createBoard() { void shared.open(null).then(()=>{setMuseOpen(false); const board = newBoard(); const value = current.current!; commit({ ...value, activeBoard: board.id, boards: [board, ...value.boards] }); setPopup(null);}).catch(e=>setToast(e.message)); }
  function createPage(copy = false) { updateBoard(board => { const source = board.pages.find(p => p.id === board.activePage)!; const next = copy ? { ...structuredClone(source), id: crypto.randomUUID(), name: source.name + ' copy' } : newPage('Page ' + (board.pages.length + 1)); return { ...board, activePage: next.id, pages: [...board.pages, museActive.current && copy ? {...next,objects:next.objects.map(object=>({...object,...(String(object.id).startsWith('muse-file-')?{id:crypto.randomUUID()}: {})}))} : next] }; }); setPopup(null); }
  function saveFile() { const board = museActive.current ? privateBoardRef.current : sharedRef.current.board || current.current?.boards.find(b => b.id === current.current?.activeBoard); if (!board) return; download(new Blob([JSON.stringify({ format: 'muze', version: 1, board })], { type: 'application/json' }), filename(board.name) + '.muze'); setPopup(null); }
  async function openFile(file: File) {
    try {
      if (file.size > 50_000_000) throw new Error('Choose a board file smaller than 50 MB.');
      const board = parseBoardFile(await file.text());
      if (museActive.current) {
        const pageIds=new Map(board.pages.map(page=>[page.id,crypto.randomUUID()]));
        updateBoard(value => ({...value,pages:[...value.pages,...board.pages.map(page=>({...page,id:pageIds.get(page.id)!}))],comments:[...(value.comments||[]),...(board.comments||[]).map(comment=>({...comment,id:crypto.randomUUID(),pageId:pageIds.get(comment.pageId||board.pages[0].id)}))]}));setPopup(null);return;
      }
      await shared.open(null);const value = current.current!;
      commit({ ...value, activeBoard: board.id, boards: [board, ...value.boards] }); setPopup(null);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not open that board.'); }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setRenameDocument(null); setPopup(null); setStylesOpen(false); }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
      if (event.key.toLowerCase() === 'u') { event.preventDefault(); imageInput.current?.click(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); boardInput.current?.click(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);

  async function attachImage(file: File, signal: AbortSignal) {
    const target = engine.current, owner = currentOwner.current, privateNotebook = museActive.current;
    const currentBoard = () => museActive.current ? privateBoardRef.current : sharedRef.current.board || current.current?.boards.find(board => board.id === current.current?.activeBoard);
    const board = currentBoard(), boardId = board?.id, pageId = board?.activePage;
    const isCurrent = () => !signal.aborted && engine.current === target && currentOwner.current === owner && museActive.current === privateNotebook && currentBoard()?.id === boardId && currentBoard()?.activePage === pageId;
    if (!target || !board || !owner) throw new Error('Open your board before attaching an image.');
    const remaining = () => privateNotebook || sharedRef.current.boardId ? 2_900_000 - new TextEncoder().encode(JSON.stringify(currentBoard())).byteLength : Infinity;
    const maxSourceLength = Math.min(1_500_000, remaining());
    if (maxSourceLength < 30_000) throw new Error('This board is full. Remove an image before attaching another.');
    const source = await normalizeImageFile(file, { maxSourceLength, maxDimension: 1024 }, signal);
    if (!isCurrent()) return;
    const blob = await (await fetch(source)).blob();
    if (!isCurrent()) return;
    if (source.length > remaining()) throw new Error('This board is full. Remove an image before attaching another.');
    await target.addImage(new File([blob], 'board-image.png', { type: 'image/png' }), isCurrent);
  }
  async function acceptFile(file: File) {
    if (['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'].includes(file.type)) { const added=await engine.current?.addImage(file); if(added && museActive.current)setToast('Picture added to your notebook.'); }
    else if (/\.(md|txt)$/i.test(file.name)) { if(file.size>24000){setToast('Choose a text file under 24 KB.');return;}const text=await file.text();if(text.includes('\0')){setToast('That file is not readable text.');return;}engine.current?.addDocument(text,file.name); }
    else if (/\.(muze|json)$/i.test(file.name)) await openFile(file);
    else setToast('This file type is not supported. Add a picture, Markdown, text, or Muze file. Audio, video and PDFs need a written description.');
  }
  useEffect(()=>{if(!museOpen&&shared.board&&page)void engine.current?.applySharedDrawing(page).catch(()=>setToast('Could not display the latest board changes. Reload this board.'));},[shared.board,page,museOpen]);
  const leaveMuse = () => { void museCanvas.flush().then(()=>setMuseOpen(false)).catch(()=>{}); };
  if (museOpen && (!active || !page)) return <main className="muze-loading"><span>{museCanvas.error || 'Opening your Muse’s notebook…'}</span><button onClick={()=>setMuseOpen(false)}>Back to whiteboard</button></main>;
  if(!museOpen&&shared.boardId&&!shared.board)return <main className="muze-loading"><span>{!isSignedIn?'Join this board':shared.error||'Opening shared board…'}</span>{!isSignedIn?<SignInButton mode="modal" forceRedirectUrl={typeof window === 'undefined' ? undefined : window.location.href} signUpForceRedirectUrl={typeof window === 'undefined' ? undefined : window.location.href}><button>Sign in to join</button></SignInButton>:shared.error&&<button onClick={shared.reload}>Retry opening board</button>}<button onClick={()=>void shared.open(null).catch(e=>setToast(e.message))}>Back to my boards</button></main>;
  if (!workspace || !active || !page) return <main className="muze-loading"><span>Muze</span><i/>{toast && <p role="alert">{toast}</p>}</main>;
  const gridDots = gridPattern(editor.zoom, editor.viewport[4], editor.viewport[5]);
  const selected = editor.selected > 0;
  const boardContext = makeBoardContext(active.name, page.name, page.objects);
  const textStyles = ['text', 'note', 'shape', 'arrow'].includes(editor.selectionKind) || ['text', 'note'].includes(editor.tool);
  const lineStyles = !['text', 'note', 'image'].includes(editor.selectionKind) && !['text', 'note'].includes(editor.tool);
  const arrowStyles = editor.selectionKind === 'arrow' || editor.tool === 'arrow';
  const run = (action: () => void) => { action(); setPopup(null); };
  const menuItem = (label: string, icon: ReactNode, action: () => void, shortcut?: string, disabled = false) => <button role="menuitem" className="muze-menu-item" onClick={() => run(action)} disabled={disabled}>{icon}<span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>;
  const selectedDocument=engine.current?.selectedDocument();
  const actions = <>
    {selectedDocument && !selectedDocument.canonical && menuItem('Rename document',<Pencil/>,()=>setRenameDocument(selectedDocument))}
    {menuItem('Cut', <Scissors/>, () => { void engine.current?.copy(true, true); }, '⌘ X', !selected)}
    {menuItem('Copy', <Copy/>, () => { void engine.current?.copy(false, true); }, '⌘ C', !selected)}
    {menuItem('Paste', <Clipboard/>, () => { void engine.current?.paste(); }, '⌘ V')}
    <div className="muze-menu-rule"/>
    {menuItem('Duplicate', <Copy/>, () => { void engine.current?.duplicate(); }, '⌘ D', !selected)}
    {menuItem('Group', <Group/>, () => engine.current?.group(), '⌘ G', editor.selected < 2)}
    {menuItem('Ungroup', <Ungroup/>, () => engine.current?.group(true), '⌘ ⇧ G', !selected)}
    <div className="muze-menu-rule"/>
    {menuItem('Bring to front', <BringToFront/>, () => engine.current?.layer(true), undefined, !selected)}
    {menuItem('Send to back', <SendToBack/>, () => engine.current?.layer(false), undefined, !selected)}
    <div className="muze-align-grid">{([['left', AlignHorizontalJustifyStart], ['center', AlignHorizontalJustifyCenter], ['right', AlignHorizontalJustifyEnd], ['top', AlignVerticalJustifyStart], ['middle', AlignVerticalJustifyCenter], ['bottom', AlignVerticalJustifyEnd]] as const).map(([direction, Icon]) => <Button key={direction} label={'Align ' + direction} disabled={editor.selected < 2} onClick={() => engine.current?.align(direction)}><Icon size={17}/></Button>)}</div>
    {menuItem('Distribute horizontally', <AlignHorizontalDistributeCenter/>, () => engine.current?.distribute(), undefined, editor.selected < 3)}
    {menuItem('Distribute vertically', <AlignVerticalDistributeCenter/>, () => engine.current?.distribute(false), undefined, editor.selected < 3)}
    {menuItem('Flip horizontally', <FlipHorizontal2/>, () => engine.current?.flip(), undefined, !selected)}
    {menuItem('Flip vertically', <FlipVertical2/>, () => engine.current?.flip(false), undefined, !selected)}
    {menuItem('Lock / unlock', <LockKeyhole/>, () => engine.current?.lockSelection(), '⌘ ⇧ L', !selected)}
    <div className="muze-menu-rule"/>{menuItem('Delete', <Trash2/>, () => engine.current?.remove(), '⌫', !selected)}
  </>;
  return <main className={'muze-app' + (dark ? ' muze-dark' : '') + (museOpen ? ' muse-journal' : '')} style={{'--toolbar-height':dockHeight+'px'} as React.CSSProperties} aria-label="Muze" data-muse-board={museOpen} data-ready={editor.ready} aria-busy={!editor.ready}
    onPointerDown={event => { if (!(event.target as HTMLElement).closest('button,input,select,.muze-popover,.muze-style-panel')) setPopup(null); }}
    onContextMenuCapture={event => { if ((event.target as HTMLElement).closest('[data-muse-ui]')) return; event.preventDefault(); const target = engine.current?.canvas.findTarget(event.nativeEvent).target; if (target) engine.current?.canvas.setActiveObject(target); setContextPoint({ x: Math.min(event.clientX, window.innerWidth - 242), y: Math.min(event.clientY, window.innerHeight - 310) }); setPopup('context'); }}
    onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); const files=Array.from(event.dataTransfer.files); if(files.length) {void (async()=>{for(const file of files)await acceptFile(file);})();} else {const text=event.dataTransfer.getData('text/plain');if(text)engine.current?.addMuseText(text);else setToast('This drop could not be read. Add an image or a written description.');} }}>
    <CanvasTooltips/>
    <div className="muze-board-layer">
    {grid && <svg className="muze-grid" aria-hidden="true"><defs><pattern id="muze-grid-dots" patternUnits="userSpaceOnUse" x={gridDots.x} y={gridDots.y} width={gridDots.spacing} height={gridDots.spacing}><circle cx={gridDots.spacing / 2} cy={gridDots.spacing / 2} r="1" fill="var(--grid-dot)"/></pattern></defs><rect width="100%" height="100%" fill="url(#muze-grid-dots)"/></svg>}
    <DrawingSurface key={active.id + page.id} pageId={active.id + page.id} drawing={page} changed={changeDrawing} update={updateEditor} ready={mount} report={setToast}/>
    {editor.guides.length > 0 && <svg className="muze-snap-guides" aria-hidden="true"><g transform={`translate(${editor.viewport[4]} ${editor.viewport[5]}) scale(${editor.zoom})`}>{editor.guides.map((line, index) => <line key={index} {...line} stroke="#e44b7a" strokeWidth={1 / editor.zoom} strokeDasharray={`${4 / editor.zoom} ${4 / editor.zoom}`}/>)}</g></svg>}
    <header className="muze-header">
      {!museOpen&&shared.board&&<BoardParticipants profiles={participantProfiles} peers={presence.peers} userId={user?.id} connected={presence.connected}/>}
      <div className="muze-project">
        <span className="muze-brand"><span>Muze</span></span>
        {museOpen && <Button label="Back to whiteboard" onClick={leaveMuse}><ArrowLeft size={17}/></Button>}<Button label="Main menu" onClick={() => togglePopup('menu')} active={popup === 'menu'}><Menu size={17}/></Button>
        <span className="muze-divider"/>
        <input aria-label="Board name" value={name} maxLength={160} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} onBlur={() => updateBoard(board => ({ ...board, name: name.trim() || 'Untitled board' }))} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); }}/>
        <button className="muze-page-trigger" aria-label="Pages" onClick={() => togglePopup('pages')}><span>{page.name}</span><ChevronDown size={14}/></button>
      </div>
      <div className="muze-header-right">
        <Button label="Share" hint="Invite people to this board or export a copy." active={popup === 'export'} className="muze-share" onClick={() => togglePopup('export')}><Share2 size={18} strokeWidth={1.7}/></Button>
        <Button label="Styles" className="muze-open-styles" onClick={() => setStylesOpen(!stylesOpen)}><Settings2 size={19}/></Button>
        <SignInToShare/>{isSignedIn && <UserButton/>}
      </div>
    </header>

    <aside className="muze-always-styles" aria-label="Color and font" data-muse-ui="true">
      <div className="muze-colors">{COLORS.map(([label, color]) => <Button key={color} label={label} active={paint.color === color} onClick={() => applyPaint({ color })} data-testid={'color-' + label.toLowerCase()}><span style={{ background: color }}/></Button>)}</div>
        <div className="muze-style-row muze-fonts">{FONTS.map(font => <Button key={font.family} label={font.name + ' font'} active={paint.font === font.family} onClick={() => applyPaint({ font: font.family })}><span style={{ fontFamily: font.family }}>Aa</span></Button>)}</div>
    </aside>
    <aside className={'muze-style-panel' + (stylesOpen ? ' show' : '')} aria-label="Drawing styles">
      <input className="muze-opacity" type="range" aria-label="Opacity" min=".1" max="1" step=".1" value={paint.opacity} onChange={event => applyPaint({ opacity: Number(event.target.value) })}/>
      <div className="muze-style-rule"/>
      {lineStyles && <>
        <div className="muze-style-row">{(['none', 'soft', 'solid', 'pattern'] as const).map(value => <Button key={value} label={value === 'none' ? 'No fill' : value === 'soft' ? 'Soft fill' : value === 'solid' ? 'Solid fill' : 'Pattern fill'} active={paint.fill === value} onClick={() => applyPaint({ fill: value })} data-testid={'fill-' + value}>{value === 'pattern' ? <Grid2X2 size={18}/> : <Square size={18} fill={value === 'none' ? 'none' : 'currentColor'} fillOpacity={value === 'soft' ? .18 : 1}/>}</Button>)}</div>
        <div className="muze-style-row">{(['draw', 'dashed', 'dotted', 'solid'] as const).map(value => <Button key={value} label={value === 'draw' ? 'Draw stroke' : value + ' stroke'} hint={value === 'draw' ? 'A natural, hand-drawn outline.' : undefined} active={paint.dash === value} onClick={() => applyPaint({ dash: value })}><svg width="20" height="20">{value === 'draw' ? <path d="M3 12 Q6 5 11 7 Q17 6 17 12 Q14 17 8 16 Q2 16 3 10" fill="none" stroke="currentColor" strokeWidth="2"/> : <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray={value === 'dashed' ? '4 3' : value === 'dotted' ? '.1 3' : undefined} strokeLinecap="round"/>}</svg></Button>)}</div>
      </>}
      <div className="muze-style-row muze-sizes">{SIZES.map(size => <Button key={size.name} label={size.name + ' stroke size'} hint={'Set the size of shapes, strokes, and text.'} active={paint.size === size.stroke} onClick={() => applyPaint({ size: size.stroke })}>{size.name}</Button>)}</div>
      {textStyles && <>
        <div className="muze-style-row">{([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([align, Icon]) => <Button key={align} label={'Text align ' + align} active={paint.align === align} onClick={() => applyPaint({ align })}><Icon size={17}/></Button>)}{editor.selectionKind !== 'text' && <Button label={'Vertical align ' + paint.verticalAlign} hint="Switch between top, middle, and bottom alignment." onClick={() => applyPaint({ verticalAlign: paint.verticalAlign === 'middle' ? 'top' : paint.verticalAlign === 'top' ? 'bottom' : 'middle' })}><AlignVerticalJustifyCenter size={17}/></Button>}</div>
        {editor.selectionKind === 'text' && <div className="muze-text-settings"><select aria-label="Text size" value={paint.fontSize} onChange={event => applyPaint({ fontSize: Number(event.target.value) })}>{[...new Set([16, 18, 22, 24, 26, 32, 36, 44, 48, 64, paint.fontSize])].sort((a,b) => a-b).map(size => <option key={size} value={size}>{size}</option>)}</select>{([['bold', Bold], ['italic', Italic], ['underline', Underline]] as const).map(([style, Icon]) => <Button key={style} label={style[0].toUpperCase() + style.slice(1)} onPointerDown={event => event.preventDefault()} onClick={() => engine.current?.formatText(style)}><Icon size={15}/></Button>)}</div>}
      </>}
      {arrowStyles && <div className="muze-arrow-settings">{(['arrowStart', 'arrowEnd'] as const).map((key, index) => <label key={key}><span>{index ? 'End' : 'Start'}</span><select aria-label={index ? 'Arrow end' : 'Arrow start'} value={paint[key]} onChange={event => applyPaint({ [key]: event.target.value as Arrowhead })}>{(['none', 'arrow', 'triangle', 'dot', 'bar'] as const).map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>)}</div>}
    </aside>

    <div className="muze-toolbar-dock">
    {popup === 'tools' && <div className="muze-popover muze-more-tools" data-muse-ui="true" onKeyDown={event=>{event.stopPropagation();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const delta:Record<string,number>={ArrowRight:2,ArrowLeft:-2,ArrowDown:1,ArrowUp:-1};if(delta[event.key]){event.preventDefault();buttons[(index+delta[event.key]+buttons.length)%buttons.length]?.focus();}}} role="toolbar" aria-label="More drawing tools">{MORE.map(tool => <div key={tool}><ToolButton tool={tool} current={editor.tool} choose={chooseTool}/><span>{TOOLS[tool].name}</span></div>)}<div><Button label="Add image" onClick={() => { imageInput.current?.click(); setPopup(null); }}><ImagePlus size={20}/></Button><span>Image</span></div><div><Button label="Add document" onClick={()=>{engine.current?.addDocument();setPopup(null);}}><FilePlus2 size={20}/></Button><span>Document</span></div><div><Button label="Import document" hint="Import a Markdown or text file under 24 KB." onClick={()=>{boardInput.current?.click();setPopup(null);}}><FolderOpen size={20}/></Button><span>Import</span></div>{!selected && !editor.canUndo && !editor.canRedo && <div><Button label="Lock current tool" onClick={()=>{engine.current?.toggleToolLock();setPopup(null);}}>{editor.locked?<LockKeyhole size={18}/>:<UnlockKeyhole size={18}/>}</Button><span>Tool lock</span></div>}</div>}
      <div className="muze-tools" role="toolbar" aria-label="Whiteboard tools"><ToolButton tool="select" current={editor.tool} choose={chooseTool}/><div className="muze-tools-scroll">{PRIMARY.filter(tool => tool !== 'select').map(tool => <ToolButton key={tool} tool={tool} current={editor.tool} choose={chooseTool}/>)}<ToolButton tool="draw" current={editor.tool} choose={chooseTool}/><ToolButton tool="comment" current={editor.tool} choose={chooseTool}/></div><Button data-more-trigger="true" aria-haspopup="true" aria-expanded={popup==='tools'} label="More tools" active={popup === 'tools'} onClick={() => togglePopup('tools')}><ChevronUp size={17}/></Button></div>
    </div>
    <div className="muze-navigation"><button className="muze-zoom-label" aria-label="Zoom" onClick={() => togglePopup('zoom')}>{Math.round(editor.zoom * 100)}%</button><Button label="Zoom out" disabled={editor.zoom <= MIN_ZOOM} onClick={() => engine.current?.zoom(editor.zoom / 1.2)}><Minus size={14}/></Button><Button label="Zoom in" disabled={editor.zoom >= MAX_ZOOM} onClick={() => engine.current?.zoom(editor.zoom * 1.2)}><Plus size={14}/></Button><Button label="Fit to content" shortcut="⇧ 1" onClick={() => engine.current?.fit()}><Maximize size={15}/></Button><Button label="Toggle minimap" active={minimap} onClick={() => setMinimap(!minimap)}><Layers size={15}/></Button></div>
    <div className="muze-bottom-right"><Button label="Toggle grid" active={grid} onClick={() => { setGrid(!grid); localStorage.setItem('muze.grid', String(!grid)); }}><Grid2X2 size={16}/></Button><Button label="Keyboard shortcuts" onClick={() => togglePopup('shortcuts')}><Keyboard size={17}/></Button></div>
    {minimap && <Minimap editor={editor} navigate={point => engine.current?.panTo(point)}/>}


    {popup === 'menu' && <div className="muze-popover muze-main-menu" role="menu" aria-label="Main menu">
      {menuItem('New board', <FilePlus2/>, createBoard)}{menuItem('Open board file…', <FolderOpen/>, () => boardInput.current?.click(), '⌘ O')}{menuItem('Save a copy…', <ArrowDownToLine/>, saveFile, '⌘ S')}
      <div className="muze-menu-rule"/><p className="muze-menu-heading">Your boards</p><div className="muze-board-list">{workspace.boards.map(board => <button key={board.id} role="menuitem" className="muze-menu-item" onClick={() => { void shared.open(null).then(()=>{setMuseOpen(false); commit({ ...current.current!, activeBoard: board.id }); setPopup(null);}).catch(e=>setToast(e.message)); }}><Square size={15}/><span>{board.name}</span>{board.id === active.id && <Check size={14}/>}</button>)}</div>
      {shared.boards.length>0&&<><div className="muze-menu-rule"/><p className="muze-menu-heading">Shared boards</p>{shared.boards.map(board=><button key={board.id} role="menuitem" className="muze-menu-item" onClick={()=>{void shared.open(board.id).then(()=>{setMuseOpen(false);setPopup(null);}).catch(e=>setToast(e.message));}}><Cloud size={15}/><span>{board.name}</span>{board.id===active.id&&<Check size={14}/>}</button>)}</>}
      <div className="muze-menu-rule"/>{menuItem(dark ? 'Light canvas' : 'Dark canvas', dark ? <Sun/> : <Moon/>, () => { setDark(!dark); localStorage.setItem('muze.theme', dark ? 'light' : 'dark'); })}{menuItem(editor.snap ? 'Turn off snapping' : 'Snap to shapes', <Magnet/>, () => engine.current?.toggleSnap())}{menuItem('Keyboard shortcuts', <Keyboard/>, () => setTimeout(() => setPopup('shortcuts'), 0))}
    </div>}
    {popup === 'pages' && <div className="muze-popover muze-pages" role="menu" aria-label="Pages"><p className="muze-menu-heading">Pages</p>{active.pages.map(p => <div key={p.id} className={'muze-page-row' + (p.id === page.id ? ' current' : '')}><button aria-label={'Open ' + p.name} onClick={() => { updateBoard(board => ({ ...board, activePage: p.id })); setPopup(null); }}><Square size={15}/></button><input aria-label={'Rename ' + p.name} value={p.name} maxLength={80} onChange={event => updateBoard(board => ({ ...board, pages: board.pages.map(item => item.id === p.id ? { ...item, name: event.target.value } : item) }))} onKeyDown={event => { if (event.key === 'Enter') { updateBoard(board => ({ ...board, activePage: p.id })); setPopup(null); } }}/>{p.id === page.id && <Check size={14}/>}</div>)}<div className="muze-menu-rule"/>{menuItem('New page', <Plus/>, () => createPage())}{menuItem('Duplicate page', <Copy/>, () => createPage(true))}</div>}
    {popup === 'export' && <SharePanel board={active} signedIn={!!isSignedIn} privateNotebook={museOpen} role={museOpen?undefined:shared.role} flush={shared.flush} close={()=>setPopup(null)} publish={async()=>{const result=await shared.publish(active);const value=current.current!;const remaining=value.boards.filter(board=>board.id!==active.id);if(!remaining.length)remaining.push(newBoard());commit({...value,activeBoard:remaining[0].id,boards:remaining});return result;}}>{menuItem('Muze file', <FolderOpen/>, saveFile)}{menuItem('Export as PNG', <ImagePlus/>, () => engine.current?.export('png', active.name))}{menuItem('Export as SVG', <MoveUpRight/>, () => engine.current?.export('svg', active.name))}</SharePanel>}
    {popup === 'actions' && <div className="muze-popover muze-actions-menu" role="menu" aria-label="Selection actions">{actions}</div>}
    {popup === 'context' && <div className="muze-popover muze-context-menu" role="menu" style={{ left: contextPoint.x, top: contextPoint.y }}>{actions}</div>}
    {popup === 'zoom' && <div className="muze-popover muze-zoom-menu" role="menu">{menuItem('Zoom in', <Plus/>, () => engine.current?.zoom(editor.zoom * 1.2), '+', editor.zoom >= MAX_ZOOM)}{menuItem('Zoom out', <Minus/>, () => engine.current?.zoom(editor.zoom / 1.2), '−', editor.zoom <= MIN_ZOOM)}{menuItem('Zoom to 100%', <Circle/>, () => engine.current?.zoom(1), '0')}{menuItem('Fit to content', <Maximize/>, () => engine.current?.fit(), '⇧ 1')}{menuItem('Zoom to selection', <MousePointer2/>, () => engine.current?.fit(true), '⇧ 2', !selected)}</div>}
    {renameDocument && <div className="muze-dialog-backdrop" onClick={()=>setRenameDocument(null)}><form role="dialog" aria-modal="true" aria-label="Rename document" className="muze-document-name" data-muse-ui="true" onClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setRenameDocument(null);}} onSubmit={event=>{event.preventDefault();engine.current?.renameDocument(renameDocument.id,renameDocument.title);setRenameDocument(null);}}><label>Document name<input autoFocus aria-label="Document name" maxLength={160} value={renameDocument.title} onFocus={event=>event.target.select()} onChange={event=>setRenameDocument({...renameDocument,title:event.target.value})}/></label><footer><button type="button" onClick={()=>setRenameDocument(null)}>Cancel</button><button disabled={!renameDocument.title.trim()}>Save name</button></footer></form></div>}
    {popup === 'shortcuts' && <div className="muze-dialog-backdrop" onClick={() => setPopup(null)}><section className="muze-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={event => event.stopPropagation()}><header><h2>Keyboard shortcuts</h2><Button label="Close shortcuts" onClick={() => setPopup(null)}><X size={18}/></Button></header>{[['Pan around', 'Hold Space / H'], ['Draw / Eraser', 'D / E'], ['Select', 'V'], ['Text / Note', 'T / N'], ['Rectangle / Ellipse', 'R / O'], ['Arrow / Line', 'A / L'], ['Undo / Redo', '⌘ Z / ⌘ ⇧ Z'], ['Copy / Paste', '⌘ C / ⌘ V'], ['Duplicate / Group', '⌘ D / ⌘ G'], ['Fit / Zoom to selection', '⇧ 1 / ⇧ 2'], ['Lock current tool', 'Q'], ['Edit a shape label', 'Enter / Double-click'], ['Snap while moving', 'Hold Ctrl / ⌘'], ['Highlight', '⇧ D'], ['Save board / Open', '⌘ S / ⌘ O'], ['Precise shapes', 'Hold Shift'], ['Zoom at the cursor', 'Ctrl + scroll / pinch']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</section></div>}
    {toast && <div className="muze-toast" role="alert">{toast}<Button label="Dismiss message" onClick={() => setToast('')}><X size={14}/></Button></div>}
    <input ref={boardInput} aria-label="Open a board file" type="file" accept=".muze,.json,.md,.txt" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void acceptFile(file); }}/>
    <input ref={imageInput} aria-label="Choose an image" type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void acceptFile(file); }}/>
    </div>
    {editor.items.map(item=>{const object=page.objects.find(o=>o.id===item.id);const url=typeof object?.sourceUrl==='string'&&/^https:\/\//.test(object.sourceUrl)?object.sourceUrl:null;return url?<a key={'source-'+item.id} className="muse-image-source" data-muse-ui="true" href={url} target="_blank" rel="noopener noreferrer" style={{left:item.x*editor.zoom+editor.viewport[4],top:(item.y+item.h)*editor.zoom+editor.viewport[5]+5}}>Source: {String(object?.sourceTitle||'image')}{object?.attribution?' · '+String(object.attribution):''}</a>:null;})}
    {museOpen&&engine.current?.museNameSelected()&&editor.items.filter(item=>item.id==='muse-name').map(item=><NameOnCanvas key={item.id} name={String((museCanvas.board as Board & {museName?:string})?.museName||'Muse')} left={item.x*editor.zoom+editor.viewport[4]} top={item.y*editor.zoom+editor.viewport[5]} zoom={editor.zoom} save={name=>{engine.current?.renameMuse(name);}} cancel={()=>engine.current?.clearSelection()}/>)}
    {museOpen&&editor.items.filter(item=>item.id==='muse-appearance').map(item=><div key={item.id} className="muse-appearance-label" aria-label="Muse’s avatar. Select the image to replace it." style={{left:(item.x+item.w/2)*editor.zoom+editor.viewport[4],top:(item.y+item.h)*editor.zoom+editor.viewport[5]+8,width:Math.max(120,item.w*editor.zoom),transform:'translateX(-50%)'}}><span>{String((museCanvas.board as Board & {museName?:string})?.museName||'Muse')}’s avatar</span></div>)}
    {!museOpen&&shared.board&&<><BoardPeerCursors profiles={participantProfiles} cursors={presence.cursors} pageId={page.id} viewport={editor.viewport}/><BoardPeerMuses profiles={participantProfiles} peers={presence.peers} userId={user?.id} pageId={page.id}/></>}
    <CanvasComments key={active.id+page.id} comments={active.comments||[]} pageId={page.id} firstPageId={active.pages[0].id} viewport={editor.viewport} placement={commentPlacement} save={comments=>updateBoard(board=>({...board,comments}))}/>
    {!museOpen&&shared.board&&shared.error&&<div className="muse-save-error" role="alert">{shared.error}{shared.conflict?<><button onClick={saveFile}>Save a copy</button><button onClick={shared.reload}>Reload shared version</button></>:<button onClick={()=>void shared.flush().catch(()=>{})}>Retry save</button>}</div>}
    {museOpen && <><div className="muse-save-status" role="status">{museCanvas.status}</div>{museCanvas.error && <div className="muse-save-error" role="alert">{museCanvas.error}<button onClick={()=>void museCanvas.flush().catch(()=>{})}>Retry save</button></div>}</>}
    <MuseCompanion attachImage={attachImage} onActivity={setMuseWorking} historyControls={(editor.canUndo||editor.canRedo||selected||editor.locked)?<div className="muse-history-controls"><Button label="Undo" shortcut="⌘ Z" disabled={!editor.canUndo} onClick={() => { void engine.current?.undo(); }}><Undo2 size={16}/></Button><Button label="Redo" shortcut="⌘ ⇧ Z" disabled={!editor.canRedo} onClick={() => { void engine.current?.undo(true); }}><Redo2 size={16}/></Button>{(selected || editor.locked) && <><Button label="Lock current tool" shortcut="Q" hint="Keep using the same tool after creating a shape." active={editor.locked} onClick={() => engine.current?.toggleToolLock()}>{editor.locked ? <LockKeyhole size={15}/> : <UnlockKeyhole size={15}/>}</Button>{selected && <><Button label="Delete selected" disabled={!selected} onClick={() => engine.current?.remove()}><Trash2 size={16}/></Button><Button label="Duplicate selected" disabled={!selected} onClick={() => { void engine.current?.duplicate(); }}><Copy size={16}/></Button><span className="muze-divider"/><Button label="Selection actions" active={popup === 'actions'} onClick={() => togglePopup('actions')}><MoreHorizontal size={17}/></Button></>}</>}</div>:null} appearanceSelected={museOpen&&engine.current?.appearanceSelected()} appearanceAnchor={(()=>{const box=editor.items.find(item=>item.id==='muse-appearance');return box?{x:(box.x+box.w)*editor.zoom+editor.viewport[4]+12,y:box.y*editor.zoom+editor.viewport[5]}:undefined;})()} openAppearance={()=>{setMuseOpen(true);setAppearanceRequest(v=>v+1);}} appearanceChanged={async()=>{const response=await fetch('/api/muse/avatar',{cache:'no-store'});if(!response.ok)throw new Error('The avatar saved, but its board preview could not load. Reopen the notebook.');const blob=await response.blob();const source=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);});if(currentOwner.current!==user?.id)return;if(museActive.current)await engine.current?.updateAppearance(source);else museCanvas.update(board=>{const replace=(objects:Record<string,unknown>[]):Record<string,unknown>[]=>objects.map(o=>o.id==='muse-appearance'?{...o,src:source}:Array.isArray(o.objects)?{...o,objects:replace(o.objects)}:o);return {...board,pages:board.pages.map(p=>({...p,objects:replace(p.objects)}))};});}} beforeSend={async()=>{await museCanvas.flush();await shared.flush();}} chatRequest={chatRequest} thread={active.id + ':' + page.id} boardContext={boardContext} applyActions={actions => {
      const now = current.current, board = museActive.current ? privateBoardRef.current : sharedRef.current.board || now?.boards.find(board => board.id === now.activeBoard);
      if (!board || board.id !== active.id || board.activePage !== page.id) return { ids: [], skipped: actions.cards.length + actions.updates.length };
      return engine.current?.applyMuseActions(actions) || { ids: [], skipped: actions.cards.length + actions.updates.length };
    }} open={museOpen} onOpenChange={setMuseOpen} obstacles={editor.items.map(box => ({ id: box.id, x: box.x * editor.zoom + editor.viewport[4], y: box.y * editor.zoom + editor.viewport[5], w: box.w * editor.zoom, h: box.h * editor.zoom }))}/>
  </main>;
}
