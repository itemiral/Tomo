import { classRegistry, Control, FabricObject, Line, Point, Textbox, util, type TMat2D } from 'fabric';

export type Arrowhead = 'none' | 'arrow' | 'triangle' | 'dot' | 'bar';

declare module 'fabric' {
  interface FabricObject {
    id?: string; muzeKind?: string; startBinding?: string; endBinding?: string;
    muzeDash?: string; muzeFill?: string; labelFor?: string; autoWidth?: boolean;
    boxHeight?: number; inset?: number; verticalAlign?: 'top' | 'middle' | 'bottom';
    frameId?: string; isLocked?: boolean; bend?: number; arrowStart?: Arrowhead; arrowEnd?: Arrowhead;
    fontFamily?: string; fontSize?: number; textAlign?: string;
  }
  interface SerializedObjectProps {
    id?: string; muzeKind?: string; startBinding?: string; endBinding?: string;
    muzeDash?: string; muzeFill?: string; labelFor?: string; autoWidth?: boolean;
    boxHeight?: number; inset?: number; verticalAlign?: 'top' | 'middle' | 'bottom';
    frameId?: string; isLocked?: boolean; bend?: number; arrowStart?: Arrowhead; arrowEnd?: Arrowhead;
  }
}
FabricObject.customProperties = ['id', 'muzeKind', 'startBinding', 'endBinding', 'muzeDash', 'muzeFill', 'labelFor', 'autoWidth', 'boxHeight', 'inset', 'verticalAlign', 'frameId', 'isLocked', 'bend', 'arrowStart', 'arrowEnd', 'fontFamily', 'fontSize', 'textAlign'];
Object.assign(FabricObject.ownDefaults, { originX: 'left', originY: 'top', transparentCorners: false, cornerColor: '#ffffff', cornerStrokeColor: '#3278ef', borderColor: '#3278ef', cornerSize: 8, touchCornerSize: 24, padding: 0, borderScaleFactor: 1, strokeUniform: true });

let measuringContext: CanvasRenderingContext2D | null = null;
const measuredGlyphs = new Map<string, number>();
function measureCharacter(...[character, style, previous, previousStyle]: Parameters<Textbox['_measureChar']>) {
  const ctx = measuringContext ||= document.createElement('canvas').getContext('2d')!;
  const font = `${style.fontStyle || 'normal'} ${style.fontWeight || 400} ${style.fontSize}px "${style.fontFamily}"`;
  ctx.font = font;
  const measure = (text: string) => { const key = font + ':' + text; let width = measuredGlyphs.get(key); if (width === undefined) { width = ctx.measureText(text).width; measuredGlyphs.set(key, width); } return width; };
  const width = measure(character);
  const sameStyle = previous && style.fontFamily === previousStyle.fontFamily && style.fontSize === previousStyle.fontSize && style.fontWeight === previousStyle.fontWeight && style.fontStyle === previousStyle.fontStyle;
  return { width, kernedWidth: sameStyle ? measure(previous + character) - measure(previous) : width };
}

function measureRun(text: string, style: ReturnType<Textbox['getCompleteStyleDeclaration']>) {
  const ctx = measuringContext ||= document.createElement('canvas').getContext('2d')!;
  ctx.font = `${style.fontStyle || 'normal'} ${style.fontWeight || 400} ${style.fontSize}px "${style.fontFamily}"`;
  return ctx.measureText(text).width;
}
function measureLine(text: Textbox, index: number, result: ReturnType<Textbox['_measureLine']>) {
  if (Object.keys(text.styles || {}).length || text.charSpacing) return result;
  const characters = text._textLines[index], style = text.getCompleteStyleDeclaration(index, 0);
  let prefix = '', previous = 0;
  for (let i = 0; i < characters.length; i++) {
    prefix += characters[i]; const width = measureRun(prefix, style), box = text.__charBounds[index][i];
    box.left = previous; box.width = box.kernedWidth = width - previous; previous = width;
  }
  text.__charBounds[index][characters.length].left = previous;
  return { ...result, width: previous };
}

function setTextMetrics(text: Textbox) {
  const line = Math.round(text.fontSize * 1.35);
  const context = measuringContext ||= document.createElement('canvas').getContext('2d')!;
  context.font = `${text.fontStyle || 'normal'} ${text.fontWeight || 400} ${text.fontSize}px "${text.fontFamily}"`;
  const metrics = context.measureText('Mg');
  const baseline = (line - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
  text._fontSizeMult = line / text.fontSize;
  text._fontSizeFraction = 1 - baseline / line;
  text.lineHeight = 1;
}

export class MuzeText extends Textbox {
  static type = 'MuzeText';
  _toSVG() { return super._toSVG().map(part => part.replace('<text ', '<text transform="translate(.125 .125)" ')); }
  initDimensions() { setTextMetrics(this); super.initDimensions(); }
  _measureChar(...args: Parameters<Textbox['_measureChar']>) { return measureCharacter(...args); }
  _measureLine(index: number): ReturnType<Textbox['_measureLine']> { return measureLine(this, index, super._measureLine(index)); }
  _measureWord(word: string[], line: number, offset = 0) { return Object.keys(this.styles || {}).length ? super._measureWord(word, line, offset) : measureRun(word.join(''), this.getCompleteStyleDeclaration(line, offset)); }
}

export class MuzeLabel extends Textbox {
  static type = 'MuzeLabel';
  initDimensions() { setTextMetrics(this); super.initDimensions(); }
  _measureChar(...args: Parameters<Textbox['_measureChar']>) { return measureCharacter(...args); }
  _measureLine(index: number): ReturnType<Textbox['_measureLine']> { return measureLine(this, index, super._measureLine(index)); }
  _measureWord(word: string[], line: number, offset = 0) { return Object.keys(this.styles || {}).length ? super._measureWord(word, line, offset) : measureRun(word.join(''), this.getCompleteStyleDeclaration(line, offset)); }
  _toSVG() {
    const offset = this._getTopOffset() + this.height / 2;
    return super._toSVG().map(part => part.replace('<text ', `<text transform="translate(.125 ${offset + .125})" `));
  }
  _wrapLine(...args: Parameters<Textbox['_wrapLine']>) {
    args[3] = (args[3] || 0) + (this.inset ?? 16) * 2;
    return super._wrapLine(...args);
  }
  calcTextHeight() { return Math.max(this.boxHeight || 0, super.calcTextHeight() + (this.inset ?? 16) * 2); }
  _getTopOffset() {
    const textHeight = super.calcTextHeight(), inset = this.inset ?? 16;
    const offset = this.verticalAlign === 'top' ? inset : this.verticalAlign === 'bottom' ? this.height - textHeight - inset : (this.height - textHeight) / 2;
    return -this.height / 2 + offset;
  }
  _getLineLeftOffset(line: number) {
    const base = super._getLineLeftOffset(line), inset = this.inset ?? 16;
    return base + (this.textAlign === 'center' ? 0 : this.textAlign === 'right' ? -inset : inset);
  }
}

export class MuzeNote extends MuzeLabel {
  static type = 'MuzeNote';
  calcTextHeight() { return Math.max(this.boxHeight || 200, super.calcTextHeight()); }
  _renderBackground(ctx: CanvasRenderingContext2D) {
    ctx.save(); ctx.shadowColor = '#00000018'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    super._renderBackground(ctx); ctx.restore();
  }
}

export class MuzeArrow extends Line {
  static type = 'MuzeArrow';
  lastControl?: 'start' | 'end' | 'bend';
  constructor(points: [number, number, number, number] = [0, 0, 0, 0], options: ConstructorParameters<typeof Line>[1] = {}) {
    super(points, options);
    this.hasBorders = false;
    this.controls = Object.fromEntries((['start', 'bend', 'end'] as const).map(which => [which, new Control({
      cursorStyle: 'crosshair', actionName: 'changeArrow', sizeX: which === 'bend' ? 8 : 10, sizeY: which === 'bend' ? 8 : 10,
      positionHandler: (_dim, matrix, object) => {
        const arrow = object as MuzeArrow, { a, b, control } = arrow.points();
        const point = which === 'start' ? a : which === 'end' ? b : a.add(b).add(control.scalarMultiply(2)).scalarMultiply(.25);
        return util.transformPoint(point, matrix);
      },
      actionHandler: (_event, transform, x, y) => {
        const arrow = transform.target as MuzeArrow, { a, b } = arrow.worldPoints();
        arrow.lastControl = which;
        if (which === 'bend') {
          const mid = a.midPointFrom(b), dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
          arrow.set('bend', ((x - mid.x) * -dy + (y - mid.y) * dx) / length);
        } else {
          const point = new Point(x, y);
          if (which === 'start') { delete arrow.startBinding; arrow.setEnds(point, b); }
          else { delete arrow.endBinding; arrow.setEnds(a, point); }
        }
        arrow.setCoords(); arrow.canvas?.requestRenderAll(); return true;
      },
    })]));
  }
  points() {
    const p = this.calcLinePoints(), a = new Point(p.x1, p.y1), b = new Point(p.x2, p.y2);
    const length = a.distanceFrom(b) || 1, bend = (this.bend || 0) * 2;
    return { a, b, control: a.midPointFrom(b).add(new Point(-(b.y - a.y) / length * bend, (b.x - a.x) / length * bend)) };
  }
  worldPoints() {
    const { a, b, control } = this.points(), matrix = this.calcTransformMatrix();
    return { a: util.transformPoint(a, matrix), b: util.transformPoint(b, matrix), control: util.transformPoint(control, matrix) };
  }
  setEnds(a: Point, b: Point) {
    this.set({ angle: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false });
    this.set({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); this.setCoords();
  }
  containsPoint(point: Point) {
    const { a, b, control } = this.worldPoints(), tolerance = Math.max(8 / (this.canvas?.getZoom() || 1), this.strokeWidth * 2);
    let previous = a;
    for (let i = 1; i <= 40; i++) {
      const t = i / 40, q = a.scalarMultiply((1 - t) ** 2).add(control.scalarMultiply(2 * (1 - t) * t)).add(b.scalarMultiply(t * t));
      const delta = q.subtract(previous), length = delta.x ** 2 + delta.y ** 2;
      const u = length ? Math.max(0, Math.min(1, ((point.x - previous.x) * delta.x + (point.y - previous.y) * delta.y) / length)) : 0;
      if (point.distanceFrom(previous.add(delta.scalarMultiply(u))) <= tolerance) return true;
      previous = q;
    }
    return false;
  }
  getBoundingRect() {
    const { a, b, control } = this.worldPoints();
    const left = Math.min(a.x, b.x, control.x), top = Math.min(a.y, b.y, control.y);
    return { left, top, width: Math.max(a.x, b.x, control.x) - left, height: Math.max(a.y, b.y, control.y) - top };
  }
  private head(point: Point, from: Point, kind: Arrowhead) {
    const angle = Math.atan2(point.y - from.y, point.x - from.x), size = Math.max(12, this.strokeWidth * 4);
    const a = new Point(point.x - size * Math.cos(angle - .5), point.y - size * Math.sin(angle - .5));
    const b = new Point(point.x - size * Math.cos(angle + .5), point.y - size * Math.sin(angle + .5));
    if (kind === 'none') return '';
    if (kind === 'dot') { const r = size / 3; return `M${point.x - r},${point.y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`; }
    if (kind === 'bar') return `M${point.x + Math.sin(angle) * size / 2},${point.y - Math.cos(angle) * size / 2}L${point.x - Math.sin(angle) * size / 2},${point.y + Math.cos(angle) * size / 2}`;
    return `M${a.x},${a.y}L${point.x},${point.y}L${b.x},${b.y}${kind === 'triangle' ? 'Z' : ''}`;
  }
  _render(ctx: CanvasRenderingContext2D) {
    const { a, b, control } = this.points();
    ctx.strokeStyle = typeof this.stroke === 'string' ? this.stroke : '#202124'; ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = this.strokeWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash(this.strokeDashArray || []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(control.x, control.y, b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    for (const [point, kind] of [[a, this.arrowStart || 'none'], [b, this.arrowEnd || 'arrow']] as const) {
      const path = new Path2D(this.head(point, control, kind));
      if (kind === 'triangle' || kind === 'dot') ctx.fill(path); ctx.stroke(path);
    }
  }
  _toSVG() {
    const { a, b, control } = this.points(), color = typeof this.stroke === 'string' && /^#[\da-f]{3,8}$/i.test(this.stroke) ? this.stroke : '#202124';
    const heads = ([[a, this.arrowStart || 'none'], [b, this.arrowEnd || 'arrow']] as const).map(([point, kind]) => `<path d="${this.head(point, control, kind)}" fill="${kind === 'dot' || kind === 'triangle' ? color : 'none'}" stroke="${color}" stroke-width="${this.strokeWidth}"/>`);
    return ['<g ', 'COMMON_PARTS', ` stroke-linecap="round" stroke-linejoin="round"><path d="M${a.x},${a.y}Q${control.x},${control.y} ${b.x},${b.y}" fill="none" stroke="${color}" stroke-width="${this.strokeWidth}"${this.strokeDashArray ? ` stroke-dasharray="${this.strokeDashArray.join(' ')}"` : ''}/>`, ...heads, '</g>'];
  }
}
for (const constructor of [MuzeArrow, MuzeText, MuzeLabel, MuzeNote]) classRegistry.setClass(constructor);
