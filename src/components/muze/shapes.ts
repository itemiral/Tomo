import { classRegistry, Rect } from 'fabric';
import { RoughGenerator } from 'roughjs/bin/generator';
import type { Drawable, Options } from 'roughjs/bin/core';
import { pale } from './styles';

export type Geo = 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'star' | 'hexagon' | 'oval' | 'rhombus' | 'cloud' | 'heart' | 'x-box' | 'check-box' | 'arrow-left' | 'arrow-right' | 'arrow-up' | 'arrow-down';
const generator = new RoughGenerator();

export class MuzeShape extends Rect {
  static type = 'MuzeShape';
  private cached?: { key: string; drawing: Drawable[] };

  private paths() {
    const w = this.width, h = this.height, x = -w / 2, y = -h / 2;
    const kind = this.muzeKind || 'rectangle';
    const key = [w, h, kind, this.muzeDash, this.muzeFill, this.stroke, this.strokeWidth, this.id].join(':');
    if (key === this.cached?.key) return this.cached.drawing;
    let seed = 1; for (const character of this.id || 'shape') seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
    const color = typeof this.stroke === 'string' ? this.stroke : '#202124';
    const options: Options = {
      seed: seed || 1, stroke: color, strokeWidth: this.strokeWidth,
      roughness: this.muzeDash === 'draw' ? .65 : 0,
      bowing: .35, disableMultiStroke: true, preserveVertices: true,
      strokeLineDash: this.muzeDash === 'dashed' ? [this.strokeWidth * 3, this.strokeWidth * 2] : this.muzeDash === 'dotted' ? [.1, this.strokeWidth * 2.5] : undefined,
      fill: this.muzeFill === 'none' || !this.muzeFill ? undefined : this.muzeFill === 'solid' ? color : pale(color, .18),
      fillStyle: this.muzeFill === 'pattern' ? 'hachure' : 'solid', fillWeight: 1, hachureGap: 7,
    };
    const polygon = (points: number[][]) => generator.polygon(points.map(([a, b]) => [x + a * w, y + b * h]), options);
    let shape: Drawable;
    switch (kind) {
      case 'ellipse': shape = generator.ellipse(0, 0, w, h, options); break;
      case 'oval': {
        const r = Math.min(w, h) / 2;
        shape = generator.path(`M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`, options); break;
      }
      case 'triangle': shape = polygon([[.5, 0], [1, 1], [0, 1]]); break;
      case 'diamond': shape = polygon([[.5, 0], [1, .5], [.5, 1], [0, .5]]); break;
      case 'rhombus': shape = polygon([[.22, 0], [1, 0], [.78, 1], [0, 1]]); break;
      case 'hexagon': shape = polygon([[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]]); break;
      case 'star': shape = polygon(Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? .22 : .5; return [.5 + Math.cos(i * Math.PI / 5 - Math.PI / 2) * r, .5 + Math.sin(i * Math.PI / 5 - Math.PI / 2) * r]; })); break;
      case 'heart': shape = generator.path(`M0 ${y + h}C${x - w * .4} ${y + h * .3} ${x + w * .08} ${y - h * .35} 0 ${y + h * .24}C${x + w * .92} ${y - h * .35} ${x + w * 1.4} ${y + h * .3} 0 ${y + h}Z`, options); break;
      case 'cloud': shape = generator.path(`M${x + w * .2} ${y + h * .85}C${x - w * .1} ${y + h * .9} ${x - w * .05} ${y + h * .4} ${x + w * .17} ${y + h * .4}C${x + w * .1} ${y + h * .1} ${x + w * .4} ${y - h * .05} ${x + w * .53} ${y + h * .17}C${x + w * .8} ${y - h * .05} ${x + w * 1.05} ${y + h * .25} ${x + w * .88} ${y + h * .46}C${x + w * 1.13} ${y + h * .55} ${x + w * .98} ${y + h * .95} ${x + w * .76} ${y + h * .87}C${x + w * .6} ${y + h * 1.1} ${x + w * .3} ${y + h * 1.04} ${x + w * .2} ${y + h * .85}Z`, options); break;
      case 'arrow-left': case 'arrow-right': case 'arrow-up': case 'arrow-down': {
        let points = [[0, .28], [.65, .28], [.65, 0], [1, .5], [.65, 1], [.65, .72], [0, .72]];
        if (kind === 'arrow-left') points = points.map(([a, b]) => [1 - a, b]);
        if (kind === 'arrow-up') points = points.map(([a, b]) => [b, 1 - a]);
        if (kind === 'arrow-down') points = points.map(([a, b]) => [b, a]);
        shape = polygon(points); break;
      }
      default: shape = generator.rectangle(x, y, w, h, options);
    }
    const drawing = [shape];
    if (kind === 'x-box') drawing.push(generator.line(x, y, -x, -y, options), generator.line(-x, y, x, -y, options));
    if (kind === 'check-box') drawing.push(generator.linearPath([[x + w * .2, y + h * .5], [x + w * .43, y + h * .73], [x + w * .82, y + h * .23]], options));
    this.cached = { key, drawing }; return drawing;
  }

  _render(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const drawable of this.paths()) for (const path of generator.toPaths(drawable)) {
      const shape = new Path2D(path.d);
      if (path.fill && path.fill !== 'none') { ctx.fillStyle = path.fill; ctx.fill(shape); }
      if (path.stroke !== 'none') { ctx.strokeStyle = path.stroke; ctx.lineWidth = path.strokeWidth; ctx.setLineDash(drawable.options.strokeLineDash || []); ctx.stroke(shape); }
    }
  }

  _toSVG() {
    const paths = this.paths().flatMap(shape => generator.toPaths(shape).map(path => `<path d="${path.d}" fill="${path.fill || 'none'}" stroke="${path.stroke}" stroke-width="${path.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${shape.options.strokeLineDash ? ` stroke-dasharray="${shape.options.strokeLineDash.join(' ')}"` : ''}/>`));
    return ['<g ', 'COMMON_PARTS', '>', ...paths, '</g>'];
  }
}
classRegistry.setClass(MuzeShape);
