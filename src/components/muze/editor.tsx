'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlignCenter, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowDownToLine, ArrowUpRight, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Hexagon, Heart, Cloud, LockKeyhole, UnlockKeyhole, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, Scissors, Clipboard, Magnet, Bold, Italic, Underline, BringToFront, Check, ChevronDown, ChevronUp, Circle, Copy, Diamond, Download, Eraser, FilePlus2, FolderOpen, Frame, Grid2X2, Group, Hand, Highlighter, ImagePlus, Keyboard, Layers, Maximize, Menu, Minus, MoreHorizontal, MousePointer2, MoveUpRight, Pencil, Plus, Redo2, SendToBack, Settings2, Square, SquareDashed, Star, StickyNote, Sun, Moon, Trash2, Triangle, Type, Undo2, Ungroup, X, Zap } from 'lucide-react';
import { WhiteboardEngine, INITIAL_EDITOR, INITIAL_PAINT, type EditorState, type Paint, type Tool } from './engine';
import { download, filename, newBoard, newPage, openStorage, parseBoardFile, readStorage, saveStorage, type Board, type Drawing, type Workspace } from './storage';
import { Point } from 'fabric';
import { COLORS, FONTS, SIZES } from './styles';
import type { Arrowhead } from './objects';
import './whiteboard.css';

const TOOLS: Record<Tool, { name: string; icon: typeof MousePointer2; key: string; hint: string }> = {
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
const PRIMARY: Tool[] = ['select', 'hand', 'draw', 'eraser', 'arrow', 'text', 'note', 'rectangle'];
const MORE: Tool[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'oval', 'rhombus', 'star', 'cloud', 'heart', 'x-box', 'check-box', 'arrow-left', 'arrow-up', 'arrow-down', 'arrow-right', 'line', 'highlight', 'laser', 'frame', 'note'];
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
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const current = useRef<Workspace | null>(null), db = useRef<IDBDatabase | null>(null), engine = useRef<WhiteboardEngine | null>(null);
  const [status, setStatus] = useState('Opening…');
  const [editor, setEditor] = useState(INITIAL_EDITOR), [paint, setPaint] = useState(INITIAL_PAINT);
  const updateEditor = useCallback((value: EditorState) => { setEditor(value); setPaint(value.paint); }, []);
  const [popup, setPopup] = useState<Popup>(null), [grid, setGrid] = useState(false), [dark, setDark] = useState(false), [minimap, setMinimap] = useState(false), [stylesOpen, setStylesOpen] = useState(false);
  const [toast, setToast] = useState(''), [contextPoint, setContextPoint] = useState({ x: 0, y: 0 });
  const [name, setName] = useState('Untitled board');
  const boardInput = useRef<HTMLInputElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const writeVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void openStorage().then(async database => {
      if (cancelled) { database.close(); return; }
      db.current = database;
      const saved = await readStorage(database);
      if (cancelled) return;
      current.current = saved; setWorkspace(saved); setStatus('Saved on this device');
      setDark(localStorage.getItem('muze.theme') === 'dark');
      setGrid(localStorage.getItem('muze.grid') === 'true');
    }).catch(() => setToast('Local storage is unavailable. Enable browser storage and reload.'));
    return () => { cancelled = true; db.current?.close(); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  const commit = useCallback((next: Workspace) => {
    current.current = next; setWorkspace(next); setStatus('Saving…'); const version = ++writeVersion.current;
    if (db.current) void saveStorage(db.current, next).then(() => { if (version === writeVersion.current) setStatus('Saved on this device'); }).catch(() => { setStatus('Not saved'); setToast('Could not save locally. Export a board file to keep your work.'); });
  }, []);
  const active = workspace?.boards.find(board => board.id === workspace.activeBoard);
  const page = active?.pages.find(item => item.id === active.activePage);
  useEffect(() => { if (active) setName(active.name); }, [active?.id, active?.name]);
  const updateBoard = useCallback((update: (board: Board) => Board) => {
    const value = current.current; if (!value) return;
    commit({ ...value, boards: value.boards.map(board => board.id === value.activeBoard ? update(board) : board) });
  }, [commit]);
  const changeDrawing = useCallback((drawing: Drawing) => updateBoard(board => ({ ...board, pages: board.pages.map(p => p.id === board.activePage ? { ...p, ...drawing } : p) })), [updateBoard]);
  const mount = useCallback((value: WhiteboardEngine | null) => { engine.current = value; if (value) { value.paint = { ...INITIAL_PAINT }; value.setDark(dark); value.grid = grid; setPaint(INITIAL_PAINT); } }, [dark, grid]);
  useEffect(() => { engine.current?.setDark(dark); }, [dark]);
  useEffect(() => { if (engine.current) engine.current.grid = grid; }, [grid]);
  const chooseTool = (tool: Tool) => { engine.current?.setTool(tool); setPopup(null); };
  const applyPaint = (patch: Partial<Paint>) => { setPaint(value => ({ ...value, ...patch })); engine.current?.applyPaint(patch); };
  const togglePopup = (value: Popup) => setPopup(p => p === value ? null : value);
  function createBoard() { const board = newBoard(); const value = current.current!; commit({ ...value, activeBoard: board.id, boards: [board, ...value.boards] }); setPopup(null); }
  function createPage(copy = false) { updateBoard(board => { const source = board.pages.find(p => p.id === board.activePage)!; const next = copy ? { ...structuredClone(source), id: crypto.randomUUID(), name: source.name + ' copy' } : newPage('Page ' + (board.pages.length + 1)); return { ...board, activePage: next.id, pages: [...board.pages, next] }; }); setPopup(null); }
  function saveFile() { const board = current.current?.boards.find(b => b.id === current.current?.activeBoard); if (!board) return; download(new Blob([JSON.stringify({ format: 'muze', version: 1, board })], { type: 'application/json' }), filename(board.name) + '.muze'); setPopup(null); }
  async function openFile(file: File) {
    try {
      if (file.size > 50_000_000) throw new Error('Choose a board file smaller than 50 MB.');
      const board = parseBoardFile(await file.text()); const value = current.current!;
      commit({ ...value, activeBoard: board.id, boards: [board, ...value.boards] }); setPopup(null);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not open that board.'); }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPopup(null); setStylesOpen(false); }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
      if (event.key.toLowerCase() === 'u') { event.preventDefault(); imageInput.current?.click(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); boardInput.current?.click(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);

  if (!workspace || !active || !page) return <main className="muze-loading"><span>Muze</span><i/>{toast && <p role="alert">{toast}</p>}</main>;
  const selected = editor.selected > 0;
  const textStyles = ['text', 'note', 'shape', 'arrow'].includes(editor.selectionKind) || ['text', 'note'].includes(editor.tool);
  const lineStyles = !['text', 'note', 'image'].includes(editor.selectionKind) && !['text', 'note'].includes(editor.tool);
  const arrowStyles = editor.selectionKind === 'arrow' || editor.tool === 'arrow';
  const run = (action: () => void) => { action(); setPopup(null); };
  const menuItem = (label: string, icon: ReactNode, action: () => void, shortcut?: string, disabled = false) => <button role="menuitem" className="muze-menu-item" onClick={() => run(action)} disabled={disabled}>{icon}<span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>;
  const actions = <>
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
  return <main className={'muze-app' + (dark ? ' muze-dark' : '')} aria-label="Muze whiteboard" data-ready={editor.ready} aria-busy={!editor.ready}
    onPointerDown={event => { if (!(event.target as HTMLElement).closest('button,input,select,.muze-popover,.muze-style-panel')) setPopup(null); }}
    onContextMenuCapture={event => { event.preventDefault(); const target = engine.current?.canvas.findTarget(event.nativeEvent).target; if (target) engine.current?.canvas.setActiveObject(target); setContextPoint({ x: Math.min(event.clientX, window.innerWidth - 242), y: Math.min(event.clientY, window.innerHeight - 310) }); setPopup('context'); }}
    onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file?.type.startsWith('image/')) void engine.current?.addImage(file); else if (file) void openFile(file); }}>
    {grid && <div className="muze-grid" style={{ backgroundSize: (24 * editor.zoom) + 'px ' + (24 * editor.zoom) + 'px', backgroundPosition: editor.viewport[4] + 'px ' + editor.viewport[5] + 'px' }}/ >}
    <DrawingSurface key={active.id + page.id} pageId={active.id + page.id} drawing={page} changed={changeDrawing} update={updateEditor} ready={mount} report={setToast}/>
    {editor.guides.length > 0 && <svg className="muze-snap-guides" aria-hidden="true"><g transform={`translate(${editor.viewport[4]} ${editor.viewport[5]}) scale(${editor.zoom})`}>{editor.guides.map((line, index) => <line key={index} {...line} stroke="#e44b7a" strokeWidth={1 / editor.zoom} strokeDasharray={`${4 / editor.zoom} ${4 / editor.zoom}`}/>)}</g></svg>}
    <header className="muze-header">
      <div className="muze-project">
        <span className="muze-brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V6l8 8 8-8v12"/></svg>Muze</span>
        <Button label="Main menu" onClick={() => togglePopup('menu')} active={popup === 'menu'}><Menu size={17}/></Button>
        <span className="muze-divider"/>
        <input aria-label="Board name" value={name} maxLength={160} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} onBlur={() => updateBoard(board => ({ ...board, name: name.trim() || 'Untitled board' }))} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); }}/>
        <button className="muze-page-trigger" aria-label="Pages" onClick={() => togglePopup('pages')}><span>{page.name}</span><ChevronDown size={14}/></button>
      </div>
      <div className="muze-header-right"><span className="muze-save" role="status"><Check size={13}/><span>{status}</span></span><button className="muze-export" aria-label="Export" onClick={() => togglePopup('export')}><Download size={15}/><span>Export</span><ChevronDown size={12}/></button><Button label="Styles" className="muze-mobile-styles" onClick={() => setStylesOpen(!stylesOpen)}><Settings2 size={19}/></Button></div>
    </header>

    <aside className={'muze-style-panel' + (stylesOpen ? ' show' : '')} aria-label="Drawing styles">
      <div className="muze-colors">{COLORS.map(([label, color]) => <Button key={color} label={label} active={paint.color === color} onClick={() => applyPaint({ color })} data-testid={'color-' + label.toLowerCase()}><span style={{ background: color }}/></Button>)}</div>
      <input className="muze-opacity" type="range" aria-label="Opacity" min=".1" max="1" step=".1" value={paint.opacity} onChange={event => applyPaint({ opacity: Number(event.target.value) })}/>
      <div className="muze-style-rule"/>
      {lineStyles && <>
        <div className="muze-style-row">{(['none', 'soft', 'solid', 'pattern'] as const).map(value => <Button key={value} label={value === 'none' ? 'No fill' : value === 'soft' ? 'Soft fill' : value === 'solid' ? 'Solid fill' : 'Pattern fill'} active={paint.fill === value} onClick={() => applyPaint({ fill: value })} data-testid={'fill-' + value}>{value === 'pattern' ? <Grid2X2 size={18}/> : <Square size={18} fill={value === 'none' ? 'none' : 'currentColor'} fillOpacity={value === 'soft' ? .18 : 1}/>}</Button>)}</div>
        <div className="muze-style-row">{(['draw', 'dashed', 'dotted', 'solid'] as const).map(value => <Button key={value} label={value === 'draw' ? 'Draw stroke' : value + ' stroke'} hint={value === 'draw' ? 'A natural, hand-drawn outline.' : undefined} active={paint.dash === value} onClick={() => applyPaint({ dash: value })}><svg width="20" height="20">{value === 'draw' ? <path d="M3 12 Q6 5 11 7 Q17 6 17 12 Q14 17 8 16 Q2 16 3 10" fill="none" stroke="currentColor" strokeWidth="2"/> : <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray={value === 'dashed' ? '4 3' : value === 'dotted' ? '.1 3' : undefined} strokeLinecap="round"/>}</svg></Button>)}</div>
      </>}
      <div className="muze-style-row muze-sizes">{SIZES.map(size => <Button key={size.name} label={size.name + ' stroke size'} hint={'Set the size of shapes, strokes, and text.'} active={paint.size === size.stroke} onClick={() => applyPaint({ size: size.stroke })}>{size.name}</Button>)}</div>
      {textStyles && <>
        <div className="muze-style-row muze-fonts">{FONTS.map(font => <Button key={font.family} label={font.name + ' font'} active={paint.font === font.family} onClick={() => applyPaint({ font: font.family })}><span style={{ fontFamily: font.family }}>Aa</span></Button>)}</div>
        <div className="muze-style-row">{([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([align, Icon]) => <Button key={align} label={'Text align ' + align} active={paint.align === align} onClick={() => applyPaint({ align })}><Icon size={17}/></Button>)}{editor.selectionKind !== 'text' && <Button label={'Vertical align ' + paint.verticalAlign} hint="Switch between top, middle, and bottom alignment." onClick={() => applyPaint({ verticalAlign: paint.verticalAlign === 'middle' ? 'top' : paint.verticalAlign === 'top' ? 'bottom' : 'middle' })}><AlignVerticalJustifyCenter size={17}/></Button>}</div>
        {editor.selectionKind === 'text' && <div className="muze-text-settings"><select aria-label="Text size" value={paint.fontSize} onChange={event => applyPaint({ fontSize: Number(event.target.value) })}>{[...new Set([16, 18, 22, 24, 26, 32, 36, 44, 48, 64, paint.fontSize])].sort((a,b) => a-b).map(size => <option key={size} value={size}>{size}</option>)}</select>{([['bold', Bold], ['italic', Italic], ['underline', Underline]] as const).map(([style, Icon]) => <Button key={style} label={style[0].toUpperCase() + style.slice(1)} onPointerDown={event => event.preventDefault()} onClick={() => engine.current?.formatText(style)}><Icon size={15}/></Button>)}</div>}
      </>}
      {arrowStyles && <div className="muze-arrow-settings">{(['arrowStart', 'arrowEnd'] as const).map((key, index) => <label key={key}><span>{index ? 'End' : 'Start'}</span><select aria-label={index ? 'Arrow end' : 'Arrow start'} value={paint[key]} onChange={event => applyPaint({ [key]: event.target.value as Arrowhead })}>{(['none', 'arrow', 'triangle', 'dot', 'bar'] as const).map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>)}</div>}
    </aside>

    <div className="muze-toolbar-dock">
      <div className="muze-quick-actions"><Button label="Lock current tool" shortcut="Q" hint="Keep using the same tool after creating a shape." active={editor.locked} onClick={() => engine.current?.toggleToolLock()}>{editor.locked ? <LockKeyhole size={15}/> : <UnlockKeyhole size={15}/>}</Button><Button label="Undo" shortcut="⌘ Z" disabled={!editor.canUndo} onClick={() => { void engine.current?.undo(); }}><Undo2 size={16}/></Button><Button label="Redo" shortcut="⌘ ⇧ Z" disabled={!editor.canRedo} onClick={() => { void engine.current?.undo(true); }}><Redo2 size={16}/></Button><Button label="Delete selected" disabled={!selected} onClick={() => engine.current?.remove()}><Trash2 size={16}/></Button><Button label="Duplicate selected" disabled={!selected} onClick={() => { void engine.current?.duplicate(); }}><Copy size={16}/></Button><span className="muze-divider"/><Button label="Selection actions" active={popup === 'actions'} onClick={() => togglePopup('actions')}><MoreHorizontal size={17}/></Button></div>
      <div className="muze-tools" role="toolbar" aria-label="Whiteboard tools">{PRIMARY.map(tool => <ToolButton key={tool} tool={tool} current={editor.tool} choose={chooseTool} compact={['note', 'rectangle'].includes(tool)}/>)}<Button label="Add image" hint="Choose an image or drag one onto the canvas." className="tool-compact" onClick={() => imageInput.current?.click()}><ImagePlus size={20} strokeWidth={1.65}/></Button><Button label="More tools" active={popup === 'tools'} onClick={() => togglePopup('tools')}><ChevronUp size={17}/></Button></div>
    </div>
    <div className="muze-navigation"><button className="muze-zoom-label" aria-label="Zoom" onClick={() => togglePopup('zoom')}>{Math.round(editor.zoom * 100)}%</button><Button label="Zoom out" onClick={() => engine.current?.zoom(editor.zoom / 1.2)}><Minus size={14}/></Button><Button label="Zoom in" onClick={() => engine.current?.zoom(editor.zoom * 1.2)}><Plus size={14}/></Button><Button label="Fit to content" shortcut="⇧ 1" onClick={() => engine.current?.fit()}><Maximize size={15}/></Button><Button label="Toggle minimap" active={minimap} onClick={() => setMinimap(!minimap)}><Layers size={15}/></Button></div>
    <div className="muze-bottom-right"><Button label="Toggle grid" active={grid} onClick={() => { setGrid(!grid); localStorage.setItem('muze.grid', String(!grid)); }}><Grid2X2 size={16}/></Button><Button label="Keyboard shortcuts" onClick={() => togglePopup('shortcuts')}><Keyboard size={17}/></Button></div>
    {minimap && <Minimap editor={editor} navigate={point => engine.current?.panTo(point)}/>}


    {popup === 'menu' && <div className="muze-popover muze-main-menu" role="menu" aria-label="Main menu">
      {menuItem('New board', <FilePlus2/>, createBoard)}{menuItem('Open board file…', <FolderOpen/>, () => boardInput.current?.click(), '⌘ O')}{menuItem('Save a copy…', <ArrowDownToLine/>, saveFile, '⌘ S')}
      <div className="muze-menu-rule"/><p className="muze-menu-heading">Your boards</p><div className="muze-board-list">{workspace.boards.map(board => <button key={board.id} role="menuitem" className="muze-menu-item" onClick={() => { commit({ ...current.current!, activeBoard: board.id }); setPopup(null); }}><Square size={15}/><span>{board.name}</span>{board.id === active.id && <Check size={14}/>}</button>)}</div>
      <div className="muze-menu-rule"/>{menuItem(dark ? 'Light canvas' : 'Dark canvas', dark ? <Sun/> : <Moon/>, () => { setDark(!dark); localStorage.setItem('muze.theme', dark ? 'light' : 'dark'); })}{menuItem(editor.snap ? 'Turn off snapping' : 'Snap to shapes', <Magnet/>, () => engine.current?.toggleSnap())}{menuItem('Keyboard shortcuts', <Keyboard/>, () => setTimeout(() => setPopup('shortcuts'), 0))}
    </div>}
    {popup === 'pages' && <div className="muze-popover muze-pages" role="menu" aria-label="Pages"><p className="muze-menu-heading">Pages</p>{active.pages.map(p => <div key={p.id} className={'muze-page-row' + (p.id === page.id ? ' current' : '')}><button aria-label={'Open ' + p.name} onClick={() => { updateBoard(board => ({ ...board, activePage: p.id })); setPopup(null); }}><Square size={15}/></button><input aria-label={'Rename ' + p.name} value={p.name} maxLength={80} onChange={event => updateBoard(board => ({ ...board, pages: board.pages.map(item => item.id === p.id ? { ...item, name: event.target.value } : item) }))} onKeyDown={event => { if (event.key === 'Enter') { updateBoard(board => ({ ...board, activePage: p.id })); setPopup(null); } }}/>{p.id === page.id && <Check size={14}/>}</div>)}<div className="muze-menu-rule"/>{menuItem('New page', <Plus/>, () => createPage())}{menuItem('Duplicate page', <Copy/>, () => createPage(true))}</div>}
    {popup === 'export' && <div className="muze-popover muze-export-menu" role="menu" aria-label="Export board">{menuItem('Muze board file', <FolderOpen/>, saveFile)}{menuItem('Export as PNG', <ImagePlus/>, () => engine.current?.export('png', active.name))}{menuItem('Export as SVG', <MoveUpRight/>, () => engine.current?.export('svg', active.name))}</div>}
    {popup === 'tools' && <div className="muze-popover muze-more-tools" role="toolbar" aria-label="More drawing tools">{MORE.map(tool => <div key={tool}><ToolButton tool={tool} current={editor.tool} choose={chooseTool}/><span>{TOOLS[tool].name}</span></div>)}<div><Button label="Add image" onClick={() => { imageInput.current?.click(); setPopup(null); }}><ImagePlus size={20}/></Button><span>Image</span></div></div>}
    {popup === 'actions' && <div className="muze-popover muze-actions-menu" role="menu" aria-label="Selection actions">{actions}</div>}
    {popup === 'context' && <div className="muze-popover muze-context-menu" role="menu" style={{ left: contextPoint.x, top: contextPoint.y }}>{actions}</div>}
    {popup === 'zoom' && <div className="muze-popover muze-zoom-menu" role="menu">{menuItem('Zoom in', <Plus/>, () => engine.current?.zoom(editor.zoom * 1.2), '+')}{menuItem('Zoom out', <Minus/>, () => engine.current?.zoom(editor.zoom / 1.2), '−')}{menuItem('Zoom to 100%', <Circle/>, () => engine.current?.zoom(1), '0')}{menuItem('Fit to content', <Maximize/>, () => engine.current?.fit(), '⇧ 1')}{menuItem('Zoom to selection', <MousePointer2/>, () => engine.current?.fit(true), '⇧ 2', !selected)}</div>}
    {popup === 'shortcuts' && <div className="muze-dialog-backdrop" onClick={() => setPopup(null)}><section className="muze-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={event => event.stopPropagation()}><header><h2>Keyboard shortcuts</h2><Button label="Close shortcuts" onClick={() => setPopup(null)}><X size={18}/></Button></header>{[['Pan around', 'Hold Space / H'], ['Draw', 'D'], ['Select', 'V'], ['Text / Note', 'T / N'], ['Rectangle / Ellipse', 'R / O'], ['Arrow / Line', 'A / L'], ['Undo / Redo', '⌘ Z / ⌘ ⇧ Z'], ['Copy / Paste', '⌘ C / ⌘ V'], ['Duplicate / Group', '⌘ D / ⌘ G'], ['Fit / Zoom to selection', '⇧ 1 / ⇧ 2'], ['Lock current tool', 'Q'], ['Edit a shape label', 'Enter / Double-click'], ['Snap while moving', 'Hold Ctrl / ⌘'], ['Highlight', '⇧ D'], ['Save board / Open', '⌘ S / ⌘ O'], ['Precise shapes', 'Hold Shift'], ['Zoom at the cursor', 'Ctrl + scroll / pinch']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</section></div>}
    {toast && <div className="muze-toast" role="alert">{toast}<Button label="Dismiss message" onClick={() => setToast('')}><X size={14}/></Button></div>}
    <input ref={boardInput} aria-label="Open a board file" type="file" accept=".muze,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void openFile(file); }}/>
    <input ref={imageInput} aria-label="Choose an image" type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void engine.current?.addImage(file); }}/>
  </main>;
}
