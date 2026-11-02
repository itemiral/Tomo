import {museNameStyles,nameFromText,renameMuseInSoul} from '@/lib/muse-name';
import { ActiveSelection, Canvas, Ellipse, FabricImage, FabricObject, Group, IText, Line, PencilBrush, Point, Polygon, Rect, Textbox, Triangle, util, type TPointerEvent, type TMat2D } from 'fabric';
import { MuzeArrow, MuzeDocument, MuzeNote, MuzeText, MuzeLabel, type Arrowhead } from './objects';
import { MuzeShape, type Geo } from './shapes';
import { GRID_STEP } from './grid';
import { clampZoom, clampViewport, MAX_ZOOM } from './zoom';
import { FONTS, SIZES, loadFonts, pale, svgFonts } from './styles';
import { download, filename, parseObjects, type Drawing } from './storage';
import { equalBoardValues } from './shared-merge';
import { frameCanvasBoxes, usableCanvasArea } from './canvas-framing';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';

type EditableText = IText | Textbox | MuzeText | MuzeLabel | MuzeNote;

export type Tool = 'comment' | 'select' | 'hand' | 'draw' | 'eraser' | 'arrow' | 'text' | 'note' | 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'star' | 'line' | 'highlight' | 'frame' | 'laser' | Geo;
export type Paint = { color: string; fill: 'none' | 'soft' | 'solid' | 'pattern'; size: number; dash: 'draw' | 'solid' | 'dashed' | 'dotted'; opacity: number; font: string; fontSize: number; align: 'left' | 'center' | 'right'; verticalAlign: 'top' | 'middle' | 'bottom'; arrowStart: Arrowhead; arrowEnd: Arrowhead };
export type EditorState = { ready: boolean; tool: Tool; zoom: number; selected: number; canUndo: boolean; canRedo: boolean; count: number; locked: boolean; snap: boolean; paint: Paint; selectionKind: string; guides: { x1: number; y1: number; x2: number; y2: number }[]; viewport: number[]; items: { id?: string; x: number; y: number; w: number; h: number }[] };
export const INITIAL_PAINT: Paint = { color: '#1d1d1d', fill: 'none', size: 3.5, dash: 'draw', opacity: 1, font: FONTS[0].family, fontSize: 24, align: 'left', verticalAlign: 'middle', arrowStart: 'none', arrowEnd: 'arrow' };
export const INITIAL_EDITOR: EditorState = { ready: false, tool: 'select', zoom: 1, selected: 0, canUndo: false, canRedo: false, count: 0, locked: false, snap: false, paint: INITIAL_PAINT, selectionKind: 'none', guides: [], viewport: [1, 0, 0, 1, 0, 0], items: [] };

let sharedClipboard: FabricObject | null = null;

export class WhiteboardEngine {
  private enabled = true;
  readonly canvas: Canvas;
  tool: Tool = 'select';
  paint = { ...INITIAL_PAINT };
  private history: string[] = [];
  private future: string[] = [];
  private loading = true;
  private loadVersion = 0;
  private start: Point | null = null;
  private drawing: FabricObject | null = null;
  private pan: { x: number; y: number } | null = null;
  private erased = false;
  private pointerBusy = false;
  private space = false;
  private clipboard: FabricObject | null = null;
  private closed = false;
  private dark = false;
  private exporting = false;
  onRender?: (svg: string) => void;
  locked = false;
  snap = false;
  grid = false;
  private guides: EditorState['guides'] = [];
  private framePositions = new Map<string, Point>();
  private editingLabel: MuzeLabel | null = null;
  private touchPoints = new Map<number, Point>();
  private pinch: { distance: number; zoom: number; world: Point } | null = null;
  private resize: ResizeObserver;
  private mobile = window.innerWidth <= 700;
  private opened = false;
  private frameRequest: number | null = null;
  private disposers: (() => void)[] = [];
  onComment?: (point: {x:number;y:number}) => void;
  onLaser?: (point: { x: number; y: number } | null) => void;

  constructor(element: HTMLCanvasElement, private changed: (drawing: Drawing) => void, private state: (state: EditorState) => void, private report: (message: string) => void) {
    this.canvas = new Canvas(element, { width: window.innerWidth, height: window.innerHeight, preserveObjectStacking: true, selection: true, selectionColor: '#3278ef14', selectionBorderColor: '#3278ef', selectionLineWidth: 1, enablePointerEvents: true, fireMiddleClick: true, stopContextMenu: true, uniformScaling: false, selectionKey: 'shiftKey', altActionKey: 'ctrlKey' });
    const c = this.canvas;
    const renderObjects = c._renderObjects.bind(c);
    c._renderObjects = (context, objects) => { if (this.exporting) renderObjects(context, objects); };
    const restoredColors: { object: FabricObject; key: 'fill' | 'stroke'; value: string }[] = [];
    const visit = (objects: FabricObject[]): FabricObject[] => objects.flatMap(object => object instanceof Group ? [object, ...visit(object.getObjects())] : [object]);
    c.on('before:render', () => {
      if (!this.dark) return;
      for (const object of visit(c.getObjects())) {
        if (object instanceof MuzeNote || object instanceof FabricImage) continue;
        for (const key of ['fill', 'stroke'] as const) {
          const value = object[key];
          if (typeof value === 'string' && ['#1d1d1d', '#202124', '#000', '#000000', 'black', 'rgb(0,0,0)'].includes(value.replaceAll(' ', ''))) {
            restoredColors.push({ object, key, value }); object.set(key, '#e9ebf0');
          }
        }
      }
    });
    c.on('after:render', () => {
      if (!this.exporting && !this.loading && !this.closed) this.onRender?.(c.toSVG({ suppressPreamble: true, width: String(c.width), height: String(c.height) }));
      for (const { object, key, value } of restoredColors.splice(0)) object.set(key, value);
    });
    this.resize = new ResizeObserver(() => {
      if (this.closed) return;
      const mobile = window.innerWidth <= 700, enteringMobile = mobile && !this.mobile;
      this.mobile = mobile;
      c.setDimensions({ width: window.innerWidth, height: window.innerHeight }); c.calcOffset(); this.emit();
      if (enteringMobile && !this.loading) this.scheduleFrame(c.getObjects(), true);
    });
    this.resize.observe(element.parentElement!.parentElement!);
    c.on('mouse:down', event => {this.pointerBusy=true;this.down(event.e);});
    c.on('mouse:move', event => this.move(event.e));
    c.on('mouse:up', ({ e }) => {this.pointerBusy=false;this.up(e);});
    const endPointer = () => {this.pointerBusy=false;};
    window.addEventListener('pointercancel',endPointer);
    this.disposers.push(()=>window.removeEventListener('pointercancel',endPointer));
    c.on('mouse:wheel', ({ e }) => {
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) this.zoom(c.getZoom() * Math.pow(.995, e.deltaY), new Point(e.offsetX, e.offsetY));
      else { const v = [...c.viewportTransform] as TMat2D; v[4] -= e.shiftKey ? e.deltaY : e.deltaX; v[5] -= e.shiftKey ? 0 : e.deltaY; c.setViewportTransform(v); this.publish(); }
    });
    c.on('object:modified', ({ target, transform }) => {
      if (target instanceof MuzeArrow) {
        const { a, b } = target.worldPoints();
        if (target.lastControl === 'start') target.startBinding = this.target(a)?.id;
        else if (target.lastControl === 'end') target.endBinding = this.target(b)?.id;
        else if (!target.lastControl) { delete target.startBinding; delete target.endBinding; }
        target.lastControl = undefined;
      }
      if (target instanceof MuzeText && transform && /scale|resiz/i.test(transform.action || '')) { target.autoWidth = false; }
      if (target instanceof MuzeShape) this.normalizeShape(target);
      this.assignFrames(); this.syncLabels(); this.connectors(); this.guides = []; this.checkpoint();
    });
    c.on('object:moving', ({ target, e }) => { this.snapObject(target, e as PointerEvent); this.moveFrame(target); this.syncLabels(); this.connectors(); this.emit(); });
    for (const event of ['object:scaling', 'object:rotating'] as const) c.on(event, () => { this.syncLabels(); this.connectors(); this.emit(); });
    c.on('path:created', ({ path }) => { path.id = crypto.randomUUID(); path.muzeKind = this.tool; path.muzeDash = this.paint.dash; path.muzeFill = this.paint.fill; path.opacity = this.tool === 'highlight' ? this.paint.opacity * .4 : this.paint.opacity; this.assignFrames(); this.checkpoint(); });
    c.on('text:editing:exited', ({ target }) => this.finishText(target));
    c.on('text:changed', ({ target }) => { if(target instanceof MuzeDocument) target.markdown = target.text; this.growText(target); this.publish(); });
    c.on('mouse:dblclick', ({ e }) => {
      if (this.tool !== 'select') return;
      const target = c.findTarget(e).target;
      if (target && !target.isLocked) this.editLabel(target);
      else if (!target) this.addText('', c.getScenePoint(e));
    });
    c.on('selection:created', () => this.emit()); c.on('selection:updated', () => this.emit()); c.on('selection:cleared', () => this.emit());
    const keydown = (event: KeyboardEvent) => this.key(event);
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space' && this.space) { this.space = false; this.setTool(this.tool); } };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup);
    this.disposers.push(() => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); });
    const copy = (event: ClipboardEvent) => {
      if (!this.enabled || this.editing() || !c.getActiveObjects().length) return;
      event.preventDefault(); event.clipboardData?.setData('text/plain', this.clipboardPayload());
      void this.copy(event.type === 'cut');
    };
    window.addEventListener('copy', copy); window.addEventListener('cut', copy);
    this.disposers.push(() => { window.removeEventListener('copy', copy); window.removeEventListener('cut', copy); });
    const paste = (event: ClipboardEvent) => {
      if (!this.enabled || this.editing()) return;
      const image = Array.from(event.clipboardData?.files || []).find(file => file.type.startsWith('image/'));
      const text = event.clipboardData?.getData('text/plain');
      if (image) { event.preventDefault(); void this.addImage(image); }
      else if (text) { event.preventDefault(); void this.pasteText(text); }
      else if (event.clipboardData?.files.length) { event.preventDefault();this.report('This attachment is not supported. Paste an image or text, or add a written description.'); }
      else if (this.clipboard || sharedClipboard) { event.preventDefault(); void this.paste(); }
    };
    this.installTouch();
    window.addEventListener('paste', paste); this.disposers.push(() => window.removeEventListener('paste', paste));
  }
  async load(drawing: Drawing) {
    this.loadVersion++;
    this.loading = true;
    await loadFonts();
    if (this.closed) return;
    const migrate = (object: Record<string, unknown>): Record<string, unknown> => {
      const fonts: Record<string, string> = { 'sans-serif': FONTS[1].family, Georgia: FONTS[2].family, monospace: FONTS[3].family, cursive: FONTS[0].family };
      return { ...object, ...(typeof object.fontFamily === 'string' && fonts[object.fontFamily] ? { fontFamily: fonts[object.fontFamily] } : {}), ...(object.type === 'Textbox' && object.muzeKind === 'text' ? { type: 'MuzeText', autoWidth: false } : {}), ...(object.fill === '#202124' ? { fill: '#1d1d1d' } : {}), ...(object.stroke === '#202124' ? { stroke: '#1d1d1d' } : {}), ...(Array.isArray(object.objects) ? { objects: object.objects.map(migrate) } : {}) };
    };
    await this.canvas.loadFromJSON({ objects: drawing.objects.map(migrate) });
    if (this.closed) return;
    const viewport = clampViewport(drawing.viewport, this.canvas.width, this.canvas.height);
    this.canvas.setViewportTransform(viewport);
    this.canvas.getObjects().forEach(object => { object.id ||= crypto.randomUUID(); this.configure(object); });
    this.syncLabels(); this.rememberFrames();
    this.history = [this.snapshot()]; this.future = []; this.loading = false; this.setTool('select'); this.canvas.requestRenderAll(); this.emit();
    if (viewport[0] !== drawing.viewport[0]) this.changed({ objects: drawing.objects, viewport });
    if (!this.opened && this.mobile) this.scheduleFrame(this.canvas.getObjects(), true);
    this.opened = true;
  }
  private snapshot() { return JSON.stringify(this.canvas.toObject()); }
  canReceiveSharedChanges() { return !this.loading && !this.start && !this.pan && !this.pinch && !this.canvas._currentTransform && !this.pointerBusy && !this.editing(); }
  async applySharedDrawing(drawing: Drawing) {
    if (!this.canReceiveSharedChanges() || equalBoardValues(this.serialize().objects, drawing.objects)) return;
    const tool = this.tool, paint = {...this.paint}, viewport = [...this.canvas.viewportTransform], selected = this.canvas.getActiveObjects().map(object => object.id);
    await this.load({...drawing,viewport});
    if (this.closed) return;
    this.paint = paint; this.setTool(tool);
    const remaining = this.canvas.getObjects().filter(object => selected.includes(object.id));
    if (remaining.length === 1) this.canvas.setActiveObject(remaining[0]);
    this.canvas.requestRenderAll(); this.emit();
  }
  setDark(value: boolean) { this.dark = value; this.syncLabels(); this.canvas.requestRenderAll(); }
  serialize(): Drawing { return { objects: JSON.parse(this.snapshot()).objects, viewport: [...this.canvas.viewportTransform] }; }
  private selectionPaint(): Paint {
    const object = this.canvas.getActiveObjects()[0];
    if (!object) return { ...this.paint };
    const label = object instanceof IText ? object : this.canvas.getObjects().find(o => o.labelFor === object.id) as IText | undefined;
    const color = object instanceof MuzeNote ? (object.stroke || this.paint.color) : object instanceof IText ? object.fill : object.stroke;
    return { ...this.paint, color: typeof color === 'string' && color !== 'transparent' ? color : this.paint.color,
      fill: (object.muzeFill as Paint['fill']) || (object.fill === 'transparent' ? 'none' : object instanceof IText ? this.paint.fill : 'solid'),
      dash: (object.muzeDash as Paint['dash']) || (object.strokeDashArray ? 'dashed' : 'solid'),
      size: object instanceof IText ? (SIZES.find(s => s.text === object.fontSize || s.label === object.fontSize)?.stroke || this.paint.size) : object.strokeWidth,
      opacity: object.opacity, font: label?.fontFamily || object.fontFamily || this.paint.font,
      fontSize: label?.fontSize || object.fontSize || this.paint.fontSize,
      align: (label?.textAlign as Paint['align']) || (object.textAlign as Paint['align']) || this.paint.align,
      verticalAlign: label?.verticalAlign || 'middle', arrowStart: object.arrowStart || 'none', arrowEnd: object.arrowEnd || 'arrow' };
  }
  private emit() {
    if (this.closed) return;
    const active = this.canvas.getActiveObjects().filter(o => !o.labelFor), first = active[0];
    const kind = active.length > 1 ? 'mixed' : first instanceof MuzeNote ? 'note' : first instanceof IText ? 'text' : first instanceof MuzeArrow ? 'arrow' : first instanceof FabricImage ? 'image' : first ? 'shape' : 'none';
    this.state({ ready: !this.loading, tool: this.tool, zoom: this.canvas.getZoom(), selected: active.length, canUndo: this.history.length > 1, canRedo: !!this.future.length, count: this.canvas.getObjects().filter(o => !o.labelFor).length, locked: this.locked, snap: this.snap, paint: this.selectionPaint(), selectionKind: kind, guides: this.guides, viewport: [...this.canvas.viewportTransform], items: this.canvas.getObjects().filter(o => !o.labelFor).map(object => { const b = object.getBoundingRect(); return { id: object.id, x: b.left, y: b.top, w: b.width, h: b.height }; }) });
  }
  private publish() { if (this.loading || this.closed) return; this.changed(this.serialize()); this.emit(); }
  checkpoint() {
    if (this.loading || this.closed) return;
    const next = this.snapshot();
    if (next !== this.history.at(-1)) { this.history = [...this.history.slice(-59), next]; this.future = []; }
    this.canvas.requestRenderAll(); this.publish();
  }
  async undo(redo = false) {
    if (this.loading || (redo ? !this.future.length : this.history.length < 2)) return;
    this.loading = true; this.canvas.discardActiveObject();
    if (redo) this.history.push(this.future.pop()!); else this.future.push(this.history.pop()!);
    await this.canvas.loadFromJSON(this.history.at(-1)!);
    if (this.closed) return;
    this.canvas.getObjects().forEach(object => this.configure(object)); this.rememberFrames();
    this.loading = false; this.setTool('select'); this.canvas.requestRenderAll(); this.publish();
  }
  setTool(tool: Tool) {
    if (this.tool !== tool) this.locked = false;
    this.tool = tool; const c = this.canvas;
    if (tool !== 'select') c.discardActiveObject();
    c.selection = tool === 'select' && !this.space;
    c.skipTargetFind = !['select', 'eraser'].includes(tool) || this.space;
    c.isDrawingMode = ['draw', 'highlight'].includes(tool) && !this.space;
    c.defaultCursor = tool === 'hand' || this.space ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    c.hoverCursor = tool === 'eraser' ? 'crosshair' : 'move';
    const brush = new PencilBrush(c); brush.color = this.paint.color; brush.width = tool === 'highlight' ? this.paint.size * 5 + 8 : this.paint.size; brush.decimate = .25;
    c.freeDrawingBrush = brush; c.requestRenderAll(); this.emit();
  }
  private options() { const p = this.paint; return { id: crypto.randomUUID(), fill: p.fill === 'none' ? 'transparent' : p.fill === 'soft' || p.fill === 'pattern' ? pale(p.color, .18) : p.color, stroke: p.color, strokeWidth: p.size, muzeDash: p.dash, muzeFill: p.fill, strokeDashArray: p.dash === 'dashed' ? [p.size * 3, p.size * 2] : p.dash === 'dotted' ? [.1, p.size * 2.5] : undefined, strokeLineCap: 'round' as const, strokeLineJoin: 'round' as const, opacity: p.opacity, objectCaching: false, fontFamily: p.font, fontSize: SIZES.find(s => s.stroke === p.size)?.label || 22, textAlign: 'center' }; }
  private target(point: Point) { return this.canvas.getObjects().slice().reverse().find(o => !(o instanceof Line) && !o.labelFor && o.muzeKind !== 'frame' && o.containsPoint(point)); }
  toggleToolLock() { this.locked = !this.locked; this.emit(); }
  toggleSnap() { this.snap = !this.snap; this.emit(); }
  private down(event: TPointerEvent) {
    if (this.loading || this.pinch) return;
    const e = event as PointerEvent;
    if (e.button === 1 || this.tool === 'hand' || this.space) { this.pan = { x: e.clientX, y: e.clientY }; this.canvas.selection = false; this.canvas.setCursor('grabbing'); return; }
    if (e.button !== 0) return;
    if (this.tool === 'comment') { const point=this.canvas.getScenePoint(event);this.setTool('select');this.onComment?.({x:point.x,y:point.y});return; }
    if (this.tool === 'laser') { this.onLaser?.({ x: e.clientX, y: e.clientY }); return; }
    if (this.tool === 'select' || this.canvas.isDrawingMode) { this.rememberFrames(); return; }
    const point = this.canvas.getScenePoint(event); this.start = point;
    if (this.tool === 'eraser') { this.erase(event); return; }
    if (this.tool === 'text' || this.tool === 'note') return;
    const base = { ...this.options(), left: point.x, top: point.y, width: 1, height: 1, muzeKind: this.tool };
    switch (this.tool) {
      case 'arrow': this.drawing = new MuzeArrow([point.x, point.y, point.x + 1, point.y + 1], { ...this.options(), muzeKind: 'arrow', arrowStart: this.paint.arrowStart, arrowEnd: this.paint.arrowEnd, startBinding: this.target(point)?.id }); break;
      case 'line': this.drawing = new Line([point.x, point.y, point.x + 1, point.y + 1], { ...this.options(), muzeKind: 'line' }); break;
      case 'frame': this.drawing = new Rect({ ...base, stroke: '#a1a8b2', strokeWidth: 1, fill: 'transparent', strokeDashArray: undefined }); break;
      default: this.drawing = new MuzeShape(base);
    }
    this.canvas.add(this.drawing);
    if (this.tool === 'frame') this.canvas.sendObjectToBack(this.drawing);
  }
  private move(event: TPointerEvent) {
    const e = event as PointerEvent;
    if (this.pan) { const v = [...this.canvas.viewportTransform] as TMat2D; v[4] += e.clientX - this.pan.x; v[5] += e.clientY - this.pan.y; this.pan = { x: e.clientX, y: e.clientY }; this.canvas.setViewportTransform(v); this.emit(); return; }
    if (this.tool === 'laser' && e.buttons) { this.onLaser?.({ x: e.clientX, y: e.clientY }); return; }
    if (this.tool === 'eraser' && this.start) { this.erase(event); return; }
    if (!this.start || !this.drawing) return;
    const point = this.canvas.getScenePoint(event); let dx = point.x - this.start.x, dy = point.y - this.start.y;
    if (e.shiftKey) {
      if (this.drawing instanceof Line) { const length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * Math.PI / 12; dx = Math.cos(angle) * length; dy = Math.sin(angle) * length; }
      else { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size; }
    }
    const left = Math.min(this.start.x, this.start.x + dx), top = Math.min(this.start.y, this.start.y + dy), width = Math.max(1, Math.abs(dx)), height = Math.max(1, Math.abs(dy));
    const o = this.drawing;
    if (o instanceof Line) o.set({ x2: this.start.x + dx, y2: this.start.y + dy });
    else if (o instanceof Ellipse) o.set({ left, top, rx: width / 2, ry: height / 2 });
    else if (o instanceof Polygon) o.set({ left, top, scaleX: width / 100, scaleY: height / 100 });
    else o.set({ left, top, width, height });
    o.setCoords(); this.canvas.requestRenderAll();
  }
  private up(event?: TPointerEvent) {
    if (this.pinch) return;
    if (this.pan) { this.pan = null; this.setTool(this.tool); this.publish(); return; }
    if (this.start && (this.tool === 'text' || this.tool === 'note')) {
      const end = event ? this.canvas.getScenePoint(event) : this.start;
      const width = this.tool === 'text' && Math.abs(end.x - this.start.x) > 8 / this.canvas.getZoom() ? Math.abs(end.x - this.start.x) : undefined;
      this.addText('', new Point(Math.min(this.start.x, end.x), this.start.y), this.tool === 'note', width);
    } else if (this.drawing) {
      const o = this.drawing;
      if (o instanceof MuzeArrow) { const { b } = o.worldPoints(); o.endBinding = this.target(b)?.id; if (o.startBinding === o.endBinding) delete o.endBinding; this.connectors(); }
      if (o.width < 3 && o.height < 3) {
        if (o instanceof Line) { this.canvas.remove(o); this.drawing = null; this.start = null; return; }
        o.set({ left: o.left - 100, top: o.top - 100, width: 200, height: 200, scaleX: 1, scaleY: 1 });
      }
      o.setCoords(); this.drawing = null;
      if (!this.locked) this.setTool('select');
      this.canvas.setActiveObject(o);
      if (o.muzeKind === 'frame') this.makeLabel(o, 'Frame ' + this.canvas.getObjects().filter(item => item.muzeKind === 'frame').length);
      this.assignFrames(); this.checkpoint();
    } else if (this.erased) { this.erased = false; this.checkpoint(); }
    this.start = null; this.guides = []; this.emit();
  }
  private erase(event: TPointerEvent) {
    const target = this.canvas.findTarget(event).target;
    if (target && !target.isLocked) { this.canvas.remove(...this.withLabels([target])); this.erased = true; this.canvas.requestRenderAll(); }
  }
  private anchor(object: FabricObject, other: Point) {
    const b = object.getBoundingRect(); const center = object.getCenterPoint(); const dx = other.x - center.x, dy = other.y - center.y; const scale = 1 / Math.max(Math.abs(dx) / (b.width / 2 + 6), Math.abs(dy) / (b.height / 2 + 6), 1);
    return new Point(center.x + dx * scale, center.y + dy * scale);
  }
  private connectors() {
    const objects = this.canvas.getObjects();
    const all = (list: FabricObject[]): FabricObject[] => list.flatMap(o => o instanceof Group ? [o, ...all(o.getObjects())] : [o]);
    const byId = new Map(all(objects).map(object => [object.id, object]));
    for (const arrow of objects) if (arrow instanceof MuzeArrow && (arrow.startBinding || arrow.endBinding)) {
      const a = byId.get(arrow.startBinding), b = byId.get(arrow.endBinding);
      const points = arrow.worldPoints();
      const ac = a?.getCenterPoint() || points.a, bc = b?.getCenterPoint() || points.b;
      const start = a ? this.anchor(a, bc) : ac, end = b ? this.anchor(b, ac) : bc;
      if (!(arrow.group instanceof ActiveSelection)) arrow.setEnds(start, end);
    }
    this.syncLabels(); this.canvas.requestRenderAll();
  }
  addText(text: string, point = this.center(), note = false, width?: number) {
    const color = this.paint.color, size = SIZES.find(s => s.stroke === this.paint.size);
    const options = { id: crypto.randomUUID(), left: note ? point.x - 100 : point.x, top: note ? point.y - 100 : point.y - Math.round(this.paint.fontSize * 1.35) / 2, width: note ? 200 : width || 16, minWidth: 1, autoWidth: !note && !width, fontSize: note ? size?.label || 22 : this.paint.fontSize, fontFamily: this.paint.font, fontWeight: note ? 500 : 400, lineHeight: 1, fill: note ? '#000000' : color, backgroundColor: note ? ['#202124', '#1d1d1d'].includes(color) ? '#fbe19d' : pale(color, .3) : '', stroke: note ? color : undefined, strokeWidth: 0, inset: 16, boxHeight: note ? 200 : undefined, verticalAlign: this.paint.verticalAlign, padding: 0, muzeKind: note ? 'note' : 'text', textAlign: note ? 'center' : this.paint.align, opacity: this.paint.opacity, objectCaching: false };
    const object = note ? new MuzeNote(text, options) : new MuzeText(text, options);
    this.canvas.add(object); this.setTool('select'); this.canvas.setActiveObject(object); this.growText(object); object.enterEditing(); object.selectAll(); this.canvas.requestRenderAll(); this.assignFrames(); this.checkpoint();
  }
  focusAppearance() {
    const object=this.canvas.getObjects().find(o=>o.id==='muse-appearance');
    if(object){this.setTool('select');this.canvas.setActiveObject(object);this.fit(true);this.emit();return true;}return false;
  }
  appearanceSelected() {return this.canvas.getActiveObjects().length===1&&this.canvas.getActiveObjects()[0].id==='muse-appearance';}
  async updateAppearance(source:string) {
    const object=this.canvas.getObjects().find(o=>o.id==='muse-appearance');
    if(object instanceof FabricImage){const width=object.getScaledWidth(),height=object.getScaledHeight();await object.setSrc(source);object.set({scaleX:width/object.width,scaleY:height/object.height});object.setCoords();this.canvas.requestRenderAll();this.checkpoint();}
  }
  selectedDocument() {
    const selected=this.canvas.getActiveObjects();
    const object=selected.length===1&&selected[0] instanceof MuzeDocument?selected[0]:null;
    return object?{id:object.id!,title:object.documentTitle||'Document',canonical:['muse-file-soul','muse-file-memory'].includes(object.id||'')}:null;
  }
  renameDocument(id:string,title:string) {
    const object=this.canvas.getObjects().find(item=>item.id===id);
    if(!(object instanceof MuzeDocument)||['muse-file-soul','muse-file-memory'].includes(id)||!title.trim())return;
    object.documentTitle=title.trim().slice(0,160);object.present();this.canvas.requestRenderAll();this.checkpoint();
  }
  addDocument(markdown = '# A new page\n\nStart anywhere.', title = 'Document.md') {
    if (markdown.length > 24000) { this.report('Keep imported documents under 24,000 characters.'); return; }
    const center=this.center();
    const object=new MuzeDocument(markdown,{id:crypto.randomUUID(),markdown,documentTitle:title.slice(0,160),left:center.x-220,top:center.y-190,width:440,boxHeight:380,inset:28,fontSize:20,fontFamily:'IBM Plex Sans',fill:'#202124',backgroundColor:'#ffffff',strokeWidth:0,verticalAlign:'top',muzeKind:'document'});
    this.canvas.add(object);this.setTool('select');this.canvas.setActiveObject(object);this.assignFrames();this.checkpoint();
  }
  addMuseText(text: string) {
    const plain = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1');
    const boxes = this.canvas.getObjects().map(object => object.getBoundingRect()), center = this.center();
    const left = boxes.length ? Math.max(...boxes.map(box => box.left + box.width)) + 80 : center.x - 260;
    const object = new MuzeText(plain, { id: crypto.randomUUID(), left, top: center.y - 170, width: 520, autoWidth: false, fontFamily: FONTS[1].family, fontSize: 22, lineHeight: 1.3, fill: '#1d1d1d', muzeKind: 'text', objectCaching: false });
    this.canvas.add(object); this.setTool('select'); this.canvas.setActiveObject(object); this.assignFrames(); this.checkpoint(); this.fit(true);
  }
  applyMuseActions(actions: MuseActions): MuseApplyResult {
    if (this.closed || this.loading || !this.enabled) return { ids: [], skipped: actions.cards.length + actions.updates.length+(actions.images?.length||0) };
    for(const image of actions.images||[])void this.addRemoteImage(image);
    const c = this.canvas, changed: FabricObject[] = [];
    let skipped = 0;
    // Keep any newer text or active edits made while Muse was answering.
    for (const update of actions.updates) {
      const object = c.getObjects().find(item => item.id === update.id);
      if (!(object instanceof IText) || object.isLocked || object.isEditing || object.isMoving || object.labelFor || object.text !== update.expectedText) { skipped++; continue; }
      const before = object.getBoundingRect();
      const previousLines = object.text.split('\n'), styles: typeof object.styles = {};
      update.text.split('\n').forEach((line, index) => { if (line === previousLines[index] && object.styles[index]) styles[index] = structuredClone(object.styles[index]); });
      const heading = object instanceof MuzeNote && object.muzeLeading ? { fontSize: 24, fontWeight: 600, ...object.styles[0]?.[0] } : null;
      object.set({ text: update.text, styles });
      if (heading) object.setSelectionStyles(heading, 0, update.text.split('\n')[0].length);
      object.initDimensions(); this.growText(object);
      const after = object.getBoundingRect();
      if (after.height > before.height + 1 && c.getObjects().some(other => {
        if (other === object || other.labelFor || other.muzeKind === 'frame') return false;
        const b = other.getBoundingRect();
        return after.left < b.left + b.width && after.left + after.width > b.left && after.top < b.top + b.height && after.top + after.height > b.top;
      })) {
        const right = Math.max(...c.getObjects().filter(other => other !== object).map(other => { const b = other.getBoundingRect(); return b.left + b.width; }));
        object.set('left', right + 48); object.setCoords();
      }
      changed.push(object);
    }
    const center = this.center(), boxes = c.getObjects().map(object => object.getBoundingRect());
    const columns = c.width <= 700 ? 1 : 2, width = 360, gap = 48, organic=actions.layout!=='aligned';
    const left = boxes.length ? Math.max(...boxes.map(b => b.left + b.width)) + 80 : center.x - (columns * (width + gap) - gap) / 2;
    let top = boxes.length ? Math.min(...boxes.map(b => b.top)) : center.y - 240, rowHeight = 0, index = 0;
    for (const card of actions.cards) {
      if (c.getObjects().some(object => object.id === card.id)) continue;
      if (index && index % columns === 0) { top += rowHeight + gap; rowHeight = 0; }
      const object = new MuzeNote(card.title + '\n\n' + card.body, { id: card.id, left: left + (index % columns) * (width + gap), top, angle:organic&&card.body.length<320?[0,-.65,.5,0,.4,-.5][index%6]:0, width, boxHeight: 240, inset: 26, fontSize: 18, fontFamily: FONTS[1].family, fontWeight: 400, muzeLeading: 1.5, textAlign: 'left', verticalAlign: 'top', fill: '#1d1d1d', backgroundColor: ['#f8e9b5', '#dfece5', '#e4e7f5'][index % 3], stroke: '#1d1d1d', strokeWidth: 0, muzeKind: 'note', objectCaching: false });
      object.setSelectionStyles({ fontWeight: 600, fontSize: 24 }, 0, card.title.length);
      object.initDimensions(); object.setCoords();
      // Keep rotated bounds clear of both existing work and this batch.
      for(let attempt=0;attempt<100;attempt++){const bounds=object.getBoundingRect();if(!boxes.some(b=>bounds.left<b.left+b.width+16&&bounds.left+bounds.width+16>b.left&&bounds.top<b.top+b.height+16&&bounds.top+bounds.height+16>b.top))break;object.set('top',object.top+24);object.setCoords();}
      const bounds=object.getBoundingRect();boxes.push(bounds);
      c.add(object); changed.push(object); rowHeight = Math.max(rowHeight, bounds.top+bounds.height-top); index++;
    }
    if (changed.length) {
      this.assignFrames(); this.connectors(); this.checkpoint();
      this.scheduleFrame(changed, true);
    }
    return { ids: changed.map(object => object.id!), skipped };
  }
  private growText(object: EditableText) {
    if (object instanceof MuzeText && object.autoWidth) {
      object.set('width', 100000); object.initDimensions();
      object.set('width', Math.max(16, Math.ceil(object.calcTextWidth() * 64) / 64 + 1)); object.initDimensions();
    }
    if (object.labelFor) {
      const owner = this.canvas.getObjects().find(item => item.id === object.labelFor);
      if (owner instanceof MuzeShape && object.height > owner.height * owner.scaleY) { owner.set('height', object.height / owner.scaleY); this.syncLabels(); }
    }
    object.setCoords(); this.canvas.requestRenderAll();
  }
  private finishText(object: EditableText) {
    if (this.closed || this.loading) return;
    if (object.labelFor) {
      object.set({ selectable: false, evented: false }); this.editingLabel = null;
      const owner = this.canvas.getObjects().find(item => item.id === object.labelFor);
      if (!object.text.trim() && owner?.muzeKind !== 'frame') this.canvas.remove(object);
      if (owner) this.canvas.setActiveObject(owner);
    } else if (!object.text.trim() && !(object instanceof MuzeNote)) { this.canvas.discardActiveObject(); this.canvas.remove(object); }
    this.checkpoint();
  }
  private makeLabel(owner: FabricObject, text = '') {
    const label = new MuzeLabel(text, { id: crypto.randomUUID(), labelFor: owner.id, muzeKind: 'label', width: Math.max(40, owner.width), boxHeight: owner.height, fontFamily: owner.fontFamily || this.paint.font, fontWeight: 500, fontSize: owner.fontSize || 22, textAlign: (owner.textAlign as Paint['align']) || 'center', verticalAlign: 'middle', fill: typeof owner.stroke === 'string' ? owner.stroke : '#202124', strokeWidth: 0, padding: 0, lineHeight: 1.18, selectable: false, evented: false, objectCaching: false, minWidth: 1 });
    this.canvas.add(label); this.syncLabels(); return label;
  }
  editLabel(owner = this.canvas.getActiveObject(), initialText?: string) {
    if (!owner || owner.isLocked || owner instanceof FabricImage || owner instanceof Group) return;
    if (owner instanceof IText) { owner.enterEditing(); owner.selectAll(); return; }
    let label = this.canvas.getObjects().find(item => item.labelFor === owner.id) as MuzeLabel | undefined;
    label ||= this.makeLabel(owner);
    this.editingLabel = label; label.set({ selectable: true, evented: true }); this.canvas.setActiveObject(label); label.enterEditing(); label.selectAll();
    if (initialText) { label.set('text', initialText); label.selectionStart = label.selectionEnd = initialText.length; label.hiddenTextarea!.value = initialText; label.initDimensions(); }
    this.canvas.requestRenderAll(); this.emit();
  }
  private syncLabels() {
    const all = (objects: FabricObject[]): FabricObject[] => objects.flatMap(o => o instanceof Group ? [o, ...all(o.getObjects())] : [o]);
    const objects = all(this.canvas.getObjects()), byId = new Map(objects.map(o => [o.id, o]));
    for (const label of objects) if (label instanceof MuzeLabel && label.labelFor) {
      const owner = byId.get(label.labelFor); if (!owner) continue;
      let center = owner.getCenterPoint();
      let width = Math.max(40, owner.getScaledWidth()), height = Math.max(24, owner.getScaledHeight());
      if (owner instanceof MuzeArrow) { const { a, b, control } = owner.worldPoints(); center = a.add(b).add(control.scalarMultiply(2)).scalarMultiply(.25); width = Math.max(80, Math.min(220, a.distanceFrom(b) - 24)); height = 36; }
      if (owner.muzeKind === 'frame') { center = new Point(owner.getBoundingRect().left + width / 2, owner.getBoundingRect().top - 16); height = 26; }
      if (label.group) center = util.transformPoint(center, util.invertTransform(label.group.calcTransformMatrix()));
      label.set({ width, boxHeight: height, angle: owner.angle, fontSize: owner.muzeKind === 'frame' ? 13 : owner.fontSize || label.fontSize, fontFamily: owner.muzeKind === 'frame' ? FONTS[1].family : owner.fontFamily || label.fontFamily, inset: owner instanceof MuzeArrow || owner.muzeKind === 'frame' ? 0 : 16, textAlign: owner.muzeKind === 'frame' ? 'left' : label.textAlign, backgroundColor: owner instanceof MuzeArrow && label.text ? (this.dark ? '#23252a' : '#f9fafb') : '' });
      label.initDimensions(); label.setPositionByOrigin(center, 'center', 'center'); label.setCoords();
    }
  }
  private center() { return util.transformPoint(new Point(this.canvas.width / 2, this.canvas.height / 2), util.invertTransform(this.canvas.viewportTransform)); }
  applyPaint(patch: Partial<Paint>) {
    this.paint = { ...this.selectionPaint(), ...patch };
    const preset = SIZES.find(size => size.stroke === patch.size);
    if (preset) this.paint.fontSize = preset.text;
    for (const object of this.canvas.getActiveObjects()) {
      const children = object instanceof Group ? object.getObjects() : [object];
      for (const item of children) {
        if (patch.color) {
          if (item instanceof MuzeNote) item.set({ stroke: patch.color, strokeWidth: 0, backgroundColor: ['#202124', '#1d1d1d'].includes(patch.color) ? '#fbe19d' : pale(patch.color, .3) });
          else if (item instanceof IText) item.set({ fill: patch.color });
          else item.set({ stroke: patch.color, ...(item.fill !== 'transparent' ? { fill: this.paint.fill === 'solid' ? patch.color : pale(patch.color, .18) } : {}) });
        }
        if (patch.fill && !(item instanceof IText)) item.set({ muzeFill: patch.fill, fill: patch.fill === 'none' ? 'transparent' : patch.fill === 'solid' ? this.paint.color : pale(this.paint.color, .18) });
        if (patch.size && !(item instanceof IText)) item.set({ strokeWidth: patch.size });
        if (patch.opacity !== undefined) item.set({ opacity: patch.opacity });
        if (patch.dash) item.set({ muzeDash: patch.dash, strokeDashArray: patch.dash === 'dashed' ? [this.paint.size * 3, this.paint.size * 2] : patch.dash === 'dotted' ? [.1, this.paint.size * 2.5] : undefined });
        if (patch.arrowStart) item.set('arrowStart', patch.arrowStart);
        if (patch.arrowEnd) item.set('arrowEnd', patch.arrowEnd);
        const labels = item instanceof IText ? [item] : this.canvas.getObjects().filter(o => o.labelFor === item.id) as IText[];
        if (patch.font) item.set('fontFamily', patch.font);
        if (patch.fontSize || preset) item.set('fontSize', patch.fontSize || (item instanceof MuzeText ? preset!.text : preset!.label));
        if (patch.align) item.set('textAlign', patch.align);
        for (const label of labels) {
          label.set({ ...(patch.font ? { fontFamily: patch.font } : {}), ...(patch.fontSize || preset ? { fontSize: patch.fontSize || (label instanceof MuzeText ? preset!.text : preset!.label) } : {}), ...(patch.align ? { textAlign: patch.align } : {}), ...(patch.verticalAlign ? { verticalAlign: patch.verticalAlign } : {}), ...(patch.color && !(label instanceof MuzeNote) ? { fill: patch.color } : {}) });
          this.growText(label);
        }
        item.setCoords();
      }
    }
    this.syncLabels();
    if (this.canvas.isDrawingMode) this.setTool(this.tool);
    this.checkpoint();
  }
  formatText(style: 'bold' | 'italic' | 'underline') {
    const object = this.canvas.getActiveObject(); if (!(object instanceof IText)) return;
    const key = style === 'bold' ? 'fontWeight' : style === 'italic' ? 'fontStyle' : 'underline';
    const current = object.isEditing ? object.getSelectionStyles()[0]?.[key] ?? object[key] : object[key];
    const value = style === 'bold' ? current === 'bold' || current === 700 ? 'normal' : 'bold' : style === 'italic' ? current === 'italic' ? 'normal' : 'italic' : !current;
    if (object.isEditing) object.setSelectionStyles({ [key]: value }); else object.set(key, value);
    object.initDimensions(); this.growText(object); this.checkpoint();
  }
  selectAll() { this.setTool('select'); this.canvas.discardActiveObject(); this.canvas.setActiveObject(new ActiveSelection(this.canvas.getObjects().filter(o => o.selectable && !o.isLocked), { canvas: this.canvas })); this.canvas.requestRenderAll(); this.emit(); }
  remove() { const selected = this.withLabels(this.canvas.getActiveObjects().filter(o => !o.isLocked)); this.canvas.discardActiveObject(); this.canvas.remove(...selected); this.checkpoint(); }
  private withLabels(selected: FabricObject[]) {
    const ids = new Set(selected.map(o => o.id));
    return [...new Set([...selected, ...this.canvas.getObjects().filter(o => o.labelFor && ids.has(o.labelFor) || o.frameId && ids.has(o.frameId))])];
  }
  private clipboardPayload() {
    const ids = new Set(this.withLabels(this.canvas.getActiveObjects()).map(o => o.id));
    return JSON.stringify({ format: 'muze-objects', objects: this.serialize().objects.filter(o => ids.has(String(o.id))) });
  }
  async pasteText(text: string) {
    try {
      let data: unknown; try { data = JSON.parse(text); } catch { /* Plain text belongs on the canvas. */ }
      if (data && typeof data === 'object' && 'format' in data && data.format === 'muze-objects' && 'objects' in data) {
        const objects = await util.enlivenObjects<FabricObject>(parseObjects(data.objects));
        if (this.closed || !objects.length) return;
        this.clipboard = objects.length === 1 ? objects[0] : new ActiveSelection(objects);
        sharedClipboard = this.clipboard; await this.paste();
      } else this.addText(text);
    } catch { this.report('Could not paste that drawing.'); }
  }
  async copy(cut = false, system = false) {
    if (system) void navigator.clipboard?.writeText(this.clipboardPayload()).catch(() => {});
    const selected = this.canvas.getActiveObjects(); if (!selected.length) return;
    const expanded = this.withLabels(selected);
    this.canvas.discardActiveObject();
    const source = expanded.length === 1 ? expanded[0] : new ActiveSelection(expanded, { canvas: this.canvas });
    const clone = await source.clone(); if (this.closed) return;
    if (source instanceof ActiveSelection) source.removeAll();
    this.canvas.setActiveObject(selected.length === 1 ? selected[0] : new ActiveSelection(selected, { canvas: this.canvas }));
    this.clipboard = clone; sharedClipboard = clone; this.canvas.requestRenderAll(); if (cut) this.remove();
  }
  async paste() {
    this.clipboard ||= sharedClipboard;
    if (!this.clipboard || this.closed) return;
    const clone = await this.clipboard.clone(); if (this.closed) return;
    const collect = (object: FabricObject): FabricObject[] => object instanceof Group ? [object, ...object.getObjects().flatMap(collect)] : [object];
    const copied = collect(clone), ids = new Map<string, string>();
    for (const object of copied) { const id = crypto.randomUUID(); if (object.id) ids.set(object.id, id); object.id = id; }
    for (const object of copied) { object.startBinding = object.startBinding ? ids.get(object.startBinding) : undefined; object.endBinding = object.endBinding ? ids.get(object.endBinding) : undefined; object.labelFor = object.labelFor ? ids.get(object.labelFor) : undefined; object.frameId = object.frameId ? ids.get(object.frameId) : undefined; this.configure(object); }
    this.canvas.discardActiveObject(); clone.set({ left: clone.left + 24, top: clone.top + 24 });
    if (clone instanceof ActiveSelection) { clone.canvas = this.canvas; clone.forEachObject(object => this.canvas.add(object)); }
    else this.canvas.add(clone);
    this.canvas.setActiveObject(clone); this.syncLabels(); this.clipboard.set({ left: this.clipboard.left + 24, top: this.clipboard.top + 24 }); this.checkpoint();
  }
  async duplicate() { await this.copy(); await this.paste(); }
  group(ungroup = false) {
    if (!ungroup) {
      const selected = this.withLabels(this.canvas.getActiveObjects());
      if (selected.length > 1) { this.canvas.discardActiveObject(); this.canvas.setActiveObject(new ActiveSelection(selected, { canvas: this.canvas })); }
    }
    const active = this.canvas.getActiveObject();
    if (ungroup && active instanceof Group && !(active instanceof ActiveSelection)) { this.canvas.discardActiveObject(); const objects = active.removeAll(); this.canvas.remove(active); this.canvas.add(...objects); this.canvas.setActiveObject(new ActiveSelection(objects, { canvas: this.canvas })); }
    else if (active instanceof ActiveSelection) { const objects = active.removeAll(); this.canvas.discardActiveObject(); this.canvas.remove(...objects); const group = new Group(objects, { id: crypto.randomUUID() }); this.canvas.add(group); this.canvas.setActiveObject(group); }
    this.checkpoint();
  }
  layer(front: boolean) { for (const object of this.canvas.getActiveObjects()) { if (front) this.canvas.bringObjectToFront(object); else this.canvas.sendObjectToBack(object); } this.checkpoint(); }
  align(axis: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    const selected = this.canvas.getActiveObjects(); if (selected.length < 2) return; this.canvas.discardActiveObject();
    const boxes = selected.map(o => o.getBoundingRect()); const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top)), right = Math.max(...boxes.map(b => b.left + b.width)), bottom = Math.max(...boxes.map(b => b.top + b.height));
    selected.forEach((o, i) => { const b = boxes[i]; const x = axis === 'left' ? left : axis === 'right' ? right - b.width : axis === 'center' ? (left + right - b.width) / 2 : b.left; const y = axis === 'top' ? top : axis === 'bottom' ? bottom - b.height : axis === 'middle' ? (top + bottom - b.height) / 2 : b.top; o.set({ left: o.left + x - b.left, top: o.top + y - b.top }); o.setCoords(); });
    this.canvas.setActiveObject(new ActiveSelection(selected, { canvas: this.canvas })); this.syncLabels(); this.connectors(); this.checkpoint();
  }
  zoom(value: number, point = new Point(this.canvas.width / 2, this.canvas.height / 2)) { this.canvas.zoomToPoint(point, clampZoom(value)); this.publish(); }
  fit(selection = false) {
    const objects = selection ? this.canvas.getActiveObjects() : this.canvas.getObjects();
    if (!objects.length) { if (!selection) this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]); this.publish(); return; }
    this.frameObjects(objects, false, selection ? MAX_ZOOM : 1);
  }
  private frameObjects(objects: FabricObject[], readable: boolean, maxZoom = 1) {
    const app = this.canvas.upperCanvasEl.closest('.muze-app');
    const visibleBounds = (selector: string) => [...(app?.querySelectorAll<HTMLElement>(selector) || [])].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const header = visibleBounds('.muze-header'), composer = visibleBounds('.muse-chat-stack'), toolbar = visibleBounds('.muze-toolbar-dock');
    const area = usableCanvasArea(this.canvas.width, this.canvas.height, {
      headerBottom: header.length ? Math.max(...header.map(rect => rect.bottom)) : undefined,
      composerTop: composer.length ? Math.min(...composer.map(rect => rect.top)) : undefined,
      toolbarTop: toolbar.length ? Math.min(...toolbar.map(rect => rect.top)) : undefined,
    });
    const visible = objects.filter(object => !object.labelFor), content = visible.filter(object => object.muzeKind !== 'frame');
    const viewport = frameCanvasBoxes((readable && content.length ? content : visible).map(object => object.getBoundingRect()), area, readable, maxZoom);
    if (viewport) { this.canvas.setViewportTransform(viewport); this.publish(); }
  }
  private scheduleFrame(objects: FabricObject[], readable: boolean) {
    if (!objects.length || this.closed) return;
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    const version = this.loadVersion, viewport = [...this.canvas.viewportTransform];
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = requestAnimationFrame(() => {
        this.frameRequest = null;
        if (this.closed || this.loading || !this.enabled || this.pointerBusy || this.pan || this.pinch || this.canvas._currentTransform || version !== this.loadVersion || viewport.some((value, index) => value !== this.canvas.viewportTransform[index])) return;
        this.frameObjects(objects.filter(object => this.canvas.getObjects().includes(object)), readable);
      });
    });
  }
  panTo(point: Point) { const v = [...this.canvas.viewportTransform] as TMat2D; v[4] = this.canvas.width / 2 - point.x * v[0]; v[5] = this.canvas.height / 2 - point.y * v[0]; this.canvas.setViewportTransform(v); this.publish(); }
  private normalizeShape(shape: MuzeShape) {
    const point = shape.getRelativeCenterPoint();
    shape.set({ width: shape.width * Math.abs(shape.scaleX), height: shape.height * Math.abs(shape.scaleY), scaleX: 1, scaleY: 1 }); shape.setPositionByOrigin(point, 'center', 'center'); shape.setCoords();
  }
  private configure(object: FabricObject) {
    if (object.labelFor) object.set({ selectable: false, evented: false });
    if (object.isLocked) object.set({ lockMovementX: true, lockMovementY: true, lockScalingX: true, lockScalingY: true, lockRotation: true, hasControls: false });
    if (object instanceof Group) object.getObjects().forEach(child => this.configure(child));
  }
  lockSelection() {
    const selected = this.canvas.getActiveObjects(), locked = !selected.every(o => o.isLocked);
    for (const object of selected) object.set({ isLocked: locked, lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked, hasControls: !locked });
    this.checkpoint();
  }
  flip(horizontal = true) { for (const object of this.canvas.getActiveObjects()) { object.set(horizontal ? 'flipX' : 'flipY', horizontal ? !object.flipX : !object.flipY); object.setCoords(); } this.syncLabels(); this.connectors(); this.checkpoint(); }
  distribute(horizontal = true) {
    const objects = this.canvas.getActiveObjects(); if (objects.length < 3) return;
    this.canvas.discardActiveObject();
    objects.sort((a, b) => horizontal ? a.getBoundingRect().left - b.getBoundingRect().left : a.getBoundingRect().top - b.getBoundingRect().top);
    const first = objects[0].getBoundingRect(), last = objects.at(-1)!.getBoundingRect();
    const start = horizontal ? first.left : first.top, end = horizontal ? last.left + last.width : last.top + last.height;
    const total = objects.reduce((sum, o) => sum + (horizontal ? o.getBoundingRect().width : o.getBoundingRect().height), 0), gap = (end - start - total) / (objects.length - 1);
    let position = start;
    for (const object of objects) { const b = object.getBoundingRect(); object.set(horizontal ? 'left' : 'top', (horizontal ? object.left - b.left : object.top - b.top) + position); position += (horizontal ? b.width : b.height) + gap; object.setCoords(); }
    this.canvas.setActiveObject(new ActiveSelection(objects, { canvas: this.canvas })); this.syncLabels(); this.connectors(); this.checkpoint();
  }
  private rememberFrames() { this.framePositions = new Map(this.canvas.getObjects().filter(o => o.muzeKind === 'frame').map(o => [o.id!, o.getCenterPoint()])); }
  private assignFrames() {
    const frames = this.canvas.getObjects().filter(o => o.muzeKind === 'frame');
    for (const object of this.canvas.getObjects()) if (!object.labelFor && object.muzeKind !== 'frame') object.frameId = frames.slice().reverse().find(frame => frame.containsPoint(object.getCenterPoint()))?.id;
    this.rememberFrames();
  }
  private moveFrame(object: FabricObject) {
    if (object.muzeKind !== 'frame') return;
    const previous = this.framePositions.get(object.id!), center = object.getCenterPoint();
    if (previous) for (const child of this.canvas.getObjects()) if (child.frameId === object.id && !child.group) { child.set({ left: child.left + center.x - previous.x, top: child.top + center.y - previous.y }); child.setCoords(); }
    this.framePositions.set(object.id!, center);
  }
  private snapObject(object: FabricObject, event: PointerEvent) {
    object.setCoords(); this.guides = [];
    if (object.labelFor || !(this.snap || event.ctrlKey || event.metaKey || this.grid)) return;
    if (this.grid) { object.set({ left: Math.round(object.left / GRID_STEP) * GRID_STEP, top: Math.round(object.top / GRID_STEP) * GRID_STEP }); object.setCoords(); }
    const b = object.getBoundingRect(), threshold = 6 / this.canvas.getZoom();
    const xs = [b.left, b.left + b.width / 2, b.left + b.width], ys = [b.top, b.top + b.height / 2, b.top + b.height];
    let dx = threshold, dy = threshold;
    let guideX: number | undefined, guideY: number | undefined;
    for (const other of this.canvas.getObjects()) {
      if (other === object || other.labelFor || object instanceof Group && object.contains(other)) continue;
      const box = other.getBoundingRect();
      for (const x of [box.left, box.left + box.width / 2, box.left + box.width]) for (const candidate of xs) if (Math.abs(x - candidate) < Math.abs(dx)) { dx = x - candidate; guideX = x; }
      for (const y of [box.top, box.top + box.height / 2, box.top + box.height]) for (const candidate of ys) if (Math.abs(y - candidate) < Math.abs(dy)) { dy = y - candidate; guideY = y; }
    }
    if (guideX !== undefined) { object.left += dx; this.guides.push({ x1: guideX, x2: guideX, y1: b.top - 2000, y2: b.top + b.height + 2000 }); }
    if (guideY !== undefined) { object.top += dy; this.guides.push({ x1: b.left - 2000, x2: b.left + b.width + 2000, y1: guideY, y2: guideY }); }
    object.setCoords();
  }
  private installTouch() {
    const element = this.canvas.upperCanvasEl;
    const midpoint = () => { const [a, b] = [...this.touchPoints.values()]; return { center: a.midPointFrom(b), distance: a.distanceFrom(b) }; };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      this.touchPoints.set(event.pointerId, new Point(event.clientX, event.clientY));
      if (this.touchPoints.size === 2) {
        const { center, distance } = midpoint();
        this.pinch = { distance, zoom: this.canvas.getZoom(), world: util.transformPoint(center, util.invertTransform(this.canvas.viewportTransform)) };
        if (this.drawing) { this.canvas.remove(this.drawing); this.drawing = null; }
        this.start = null; this.pan = null; this.canvas.isDrawingMode = false;
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    const move = (event: PointerEvent) => {
      if (!this.touchPoints.has(event.pointerId)) return;
      this.touchPoints.set(event.pointerId, new Point(event.clientX, event.clientY));
      if (!this.pinch || this.touchPoints.size < 2) return;
      const { center, distance } = midpoint(), zoom = clampZoom(this.pinch.zoom * distance / Math.max(1, this.pinch.distance));
      this.canvas.setViewportTransform([zoom, 0, 0, zoom, center.x - this.pinch.world.x * zoom, center.y - this.pinch.world.y * zoom]);
      this.emit(); event.preventDefault(); event.stopImmediatePropagation();
    };
    const up = (event: PointerEvent) => {
      this.touchPoints.delete(event.pointerId);
      if (this.pinch) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!this.touchPoints.size) { this.pinch = null; this.setTool(this.tool); this.publish(); }
      }
    };
    element.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move, { capture: true, passive: false }); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    this.disposers.push(() => { element.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); });
  }
  museNameSelected(){return this.canvas.getActiveObjects().length===1&&this.canvas.getActiveObject()?.id==='muse-name';}
  renameMuse(name:string){
    const visit=(objects:FabricObject[]):FabricObject[]=>objects.flatMap(object=>object instanceof Group?[object,...visit(object.getObjects())]:[object]);
    const objects=visit(this.canvas.getObjects()),object=objects.find(item=>item.id==='muse-name');
    if(!(object instanceof IText))return;
    const previousName=nameFromText(object.text);
    object.set({text:'Hello, my name is '+name+'.',styles:museNameStyles(name)});object.initDimensions();object.setCoords();
    for(const document of objects)if(document.id==='muse-file-soul'&&document instanceof MuzeDocument){
      document.markdown=renameMuseInSoul(document.markdown??'',previousName,name);document.present();
    }
    this.canvas.discardActiveObject();this.canvas.requestRenderAll();this.checkpoint();
  }
  clearSelection(){this.canvas.discardActiveObject();this.canvas.requestRenderAll();this.emit();}
  async addRemoteImage(item:NonNullable<MuseActions['images']>[number]) {
    if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.src)||item.src.length>16000000)return;
    const canvas=this.canvas,version=this.loadVersion;
    try{const image=await FabricImage.fromURL(item.src);if(version!==this.loadVersion||this.closed||this.loading||!this.enabled||canvas.getObjects().some(o=>o.id===item.id))return;
      const center=this.center(),boxes=canvas.getObjects().map(o=>o.getBoundingRect());
      image.set({id:item.id,left:boxes.length?Math.max(...boxes.map(b=>b.left+b.width))+48:center.x,top:center.y-160,...{sourceUrl:item.sourceUrl,sourceTitle:item.sourceTitle,retrievedAt:item.retrievedAt,imageUrl:item.imageUrl,attribution:item.attribution}});image.scale(Math.min(1,420/image.width,320/image.height));canvas.add(image);this.setTool('select');canvas.setActiveObject(image);this.checkpoint();this.fit(true);
    }catch{this.report('The image could not be placed.');}
  }
  async addImage(file: File, canApply:()=>boolean=()=>true) {
    const version=this.loadVersion;
    const current=()=>!this.closed&&!this.loading&&this.enabled&&this.loadVersion===version&&canApply();
    if(!current())return false;
    try {
      if (file.size > 20_000_000 || !file.type.startsWith('image/')) throw new Error('Choose an image smaller than 20 MB.');
      const url = URL.createObjectURL(file);
      let image: FabricImage;
      try { image = await FabricImage.fromURL(url); } finally { URL.revokeObjectURL(url); }
      if(!current())return false;
      const src = image.toDataURL({ format: 'png', multiplier: 1 });
      const portable = await FabricImage.fromURL(src); const center = this.center();
      if (!current()) return false;
      portable.set({ id: crypto.randomUUID(), left: center.x - Math.min(portable.width, 480) / 2, top: center.y - Math.min(portable.height, 320) / 2 }); portable.scale(Math.min(1, 480 / portable.width, 360 / portable.height));
      this.canvas.add(portable); this.setTool('select'); this.canvas.setActiveObject(portable); this.checkpoint(); return true;
    } catch (error) { if(current())this.report(error instanceof Error ? error.message : 'Could not open that image.'); return false; }
  }
  async export(format: 'png' | 'svg', title: string) {
    const fonts = format === 'svg' ? await svgFonts() : '';
    if (this.closed) return;
    const viewport = [...this.canvas.viewportTransform] as TMat2D;
    const dark = this.dark; this.dark = false; this.exporting = true;
    this.canvas.discardActiveObject(); const boxes = this.canvas.getObjects().map(o => o.getBoundingRect());
    const left = boxes.length ? Math.min(...boxes.map(b => b.left)) - 32 : 0, top = boxes.length ? Math.min(...boxes.map(b => b.top)) - 32 : 0;
    const width = boxes.length ? Math.max(...boxes.map(b => b.left + b.width)) - left + 32 : 1200, height = boxes.length ? Math.max(...boxes.map(b => b.top + b.height)) - top + 32 : 800;
    try {
      this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      if (format === 'svg') download(new Blob([this.canvas.toSVG({ viewBox: { x: left, y: top, width, height }, width: String(width), height: String(height) }).replace('</svg>', fonts + '</svg>')], { type: 'image/svg+xml' }), filename(title) + '.svg');
      else { const data = this.canvas.toDataURL({ format: 'png', left, top, width, height, multiplier: Math.min(2, 4096 / Math.max(width, height)) }); const link = document.createElement('a'); link.href = data; link.download = filename(title) + '.png'; link.click(); }
    } catch { this.report('Could not export that image. Try a smaller selection.'); }
    finally { this.dark = dark; this.exporting = false; this.canvas.setViewportTransform(viewport); this.canvas.requestRenderAll(); }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      const active = this.canvas.getActiveObject();
      if (active instanceof IText && active.isEditing) active.exitEditing();
      this.space = false;
      this.setTool(this.tool);
    }
  }
  private editing() { const target = document.activeElement; return !!target?.closest('input,textarea,select,[contenteditable="true"]') || (this.canvas.getActiveObject() instanceof IText && (this.canvas.getActiveObject() as IText).isEditing); }
  private key(event: KeyboardEvent) {
    if (!this.enabled || this.loading) return;
    if (event.target instanceof Element && event.target.closest('[data-muse-ui]') && ['Enter', ' '].includes(event.key)) return;
    const key = event.key.toLowerCase(), mod = event.metaKey || event.ctrlKey;
    if (this.editing()) {
      if (this.canvas.getActiveObject() instanceof IText) {
        if (key === 'escape' || mod && key === 'enter') { event.preventDefault(); (this.canvas.getActiveObject() as IText).exitEditing(); this.canvas.upperCanvasEl.focus(); }
        if (mod && ['b', 'i', 'u'].includes(key)) { event.preventDefault(); this.formatText(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline'); }
      }
      return;
    }
    if (mod) {
      if (['z', 'y', 'a', 'd', 'g', '=', '+', '-', '0', 'l'].includes(key)) event.preventDefault();
      if (key === 'z') void this.undo(event.shiftKey); else if (key === 'y') void this.undo(true);
      else if (key === 'a') this.selectAll(); else if (key === 'd') void this.duplicate(); else if (key === 'g') this.group(event.shiftKey);
      else if (key === 'c' || key === 'x' || key === 'v') return;
      else if (key === '=' || key === '+') this.zoom(this.canvas.getZoom() * 1.25); else if (key === '-') this.zoom(this.canvas.getZoom() / 1.25); else if (key === '0') this.zoom(1);
      else if (key === 'l' && event.shiftKey) this.lockSelection();
      return;
    }
    if (event.code === 'Space') { event.preventDefault(); this.space = true; this.setTool(this.tool); return; }
    if (key === 'backspace' || key === 'delete') { event.preventDefault(); this.remove(); return; }
    if (key === 'escape') { this.locked = false; this.canvas.discardActiveObject(); this.setTool('select'); return; }
    if (key === 'enter') { event.preventDefault(); this.editLabel(); return; }
    if (key === 'q') { this.toggleToolLock(); return; }
    if (key === '1' || event.code === 'Digit1') this.fit(); else if (key === '2' || event.code === 'Digit2') this.fit(true); else if (key === '0' || event.code === 'Digit0') this.zoom(1); else if (key === '+' || key === '=') this.zoom(this.canvas.getZoom() * 1.25); else if (key === '-') this.zoom(this.canvas.getZoom() / 1.25);
    const keys: Record<string, Tool> = { c: 'comment', v: 'select', h: 'hand', d: event.shiftKey ? 'highlight' : 'draw', p: 'draw', e: 'eraser', a: 'arrow', t: 'text', n: 'note', r: 'rectangle', o: 'ellipse', l: 'line', f: 'frame', k: 'laser' };
    if (keys[key]) { event.preventDefault(); this.setTool(keys[key]); }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
      event.preventDefault(); const delta = event.shiftKey ? 10 : 1;
      const active = this.canvas.getActiveObject(); if (!active || active.isLocked) return;
      active.set({ left: active.left + (key === 'arrowleft' ? -delta : key === 'arrowright' ? delta : 0), top: active.top + (key === 'arrowup' ? -delta : key === 'arrowdown' ? delta : 0) }); active.setCoords(); this.moveFrame(active); this.syncLabels(); this.connectors(); this.checkpoint();
    }
  }
  dispose() { this.closed = true; if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest); this.resize.disconnect(); this.disposers.forEach(fn => fn()); void this.canvas.dispose(); }
}
