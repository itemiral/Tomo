export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Size = { width: number; height: number };

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export function clipRect(rect: Rect, bounds: Rect): Rect | null {
  const x = Math.max(rect.x, bounds.x), y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

// Includes the name, floating animation and, while working, the status bubble.
export function agentFootprint(point: Point, active: boolean, compact: boolean): Rect {
  const offset = compact
    ? { x: 14, y: -8, width: 76, height: 120 }
    : active ? { x: -68, y: -50, width: 240, height: 190 } : { x: 0, y: -10, width: 104, height: 140 };
  return { ...offset, x: point.x + offset.x, y: point.y + offset.y };
}

export function findAgentPosition({ preferred, target, obstacles, size, active, compact }: {
  preferred: Point; target?: Rect; obstacles: Rect[]; size: Size; active: boolean; compact: boolean;
}): Point | null {
  const gap = compact ? 4 : 8;
  const footprint = agentFootprint({ x: 0, y: 0 }, active, compact);
  const minX = gap - footprint.x, maxX = size.width - gap - footprint.width - footprint.x;
  const minY = gap - footprint.y, maxY = size.height - gap - footprint.height - footprint.y;
  if (maxX < minX || maxY < minY) return null;
  const clamp = (point: Point) => ({ x: Math.max(minX, Math.min(maxX, point.x)), y: Math.max(minY, Math.min(maxY, point.y)) });
  const desired = clamp(target ? { x: target.x + target.width + gap - footprint.x, y: target.y + 24 } : preferred);
  const safe = (point: Point) => {
    const rect = agentFootprint(point, active, compact);
    return !obstacles.some(obstacle => intersects({ x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 }, obstacle));
  };
  if (safe(desired)) return desired;

  // Search the free space beside every obstacle, including narrow gaps and
  // viewport edges. Four fixed offsets miss space after a pan or panel opens.
  const xs = new Set([minX, maxX, desired.x, clamp(preferred).x]);
  const ys = new Set([minY, maxY, desired.y, clamp(preferred).y]);
  for (const obstacle of obstacles) {
    xs.add(clamp({ x: obstacle.x - gap - footprint.width - footprint.x, y: 0 }).x);
    xs.add(clamp({ x: obstacle.x + obstacle.width + gap - footprint.x, y: 0 }).x);
    ys.add(clamp({ x: 0, y: obstacle.y - gap - footprint.height - footprint.y }).y);
    ys.add(clamp({ x: 0, y: obstacle.y + obstacle.height + gap - footprint.y }).y);
  }
  let best: Point | null = null, score = Infinity;
  for (const x of xs) for (const y of ys) {
    const distance = (x - desired.x) ** 2 + (y - desired.y) ** 2;
    if (distance < score && safe({ x, y })) { best = { x, y }; score = distance; }
  }
  return best;
}
