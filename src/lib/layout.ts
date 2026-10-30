import type { Edge, XYPosition } from "@xyflow/react";
import type { FlowNode } from "./store";

const FALLBACK_SIZE = { width: 300, height: 240 };
/** Vertical gap between nodes of a column, and horizontal gap between columns. */
const NODE_GAP = 20;
const RANK_GAP = 56;
/** Space between separate workflows once packed together. */
const GROUP_GAP = 56;
/** Packed workflows aim for a block about this much wider than tall, like a screen. */
const ASPECT = 16 / 10;

interface Box {
  width: number;
  height: number;
}

interface Rect extends Box {
  x: number;
  y: number;
}

/** The size React Flow measured on screen; set sizes and a default otherwise. */
function sizeOf(n: FlowNode): Box {
  return {
    width: n.measured?.width ?? n.width ?? FALLBACK_SIZE.width,
    height: n.measured?.height ?? n.height ?? FALLBACK_SIZE.height,
  };
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** Groups of nodes linked to each other, directly or not. */
function components(nodes: FlowNode[], edges: Edge[]): FlowNode[][] {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const root = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const r = root(p);
    parent.set(id, r);
    return r;
  };
  for (const e of edges) if (parent.has(e.source) && parent.has(e.target)) parent.set(root(e.source), root(e.target));
  const groups = new Map<string, FlowNode[]>();
  for (const n of nodes) groups.set(root(n.id), [...(groups.get(root(n.id)) ?? []), n]);
  return [...groups.values()];
}

/**
 * Left-to-right layout of one workflow as top-aligned columns: a node sits one
 * column right of the nodes feeding it (a node fed by nothing sits just left
 * of what it feeds), and each column is a stack from the top, like a masonry
 * grid. Within a column, nodes follow the height of the nodes they link to, to
 * keep links short and uncrossed. Top-left at (0, 0).
 */
function layered(nodes: FlowNode[], edges: Edge[]): { positions: Map<string, XYPosition>; box: Box } {
  const ids = new Set(nodes.map((n) => n.id));
  const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const preds = new Map(nodes.map((n) => [n.id, [] as string[]]));
  const succs = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of links) {
    preds.get(e.target)!.push(e.source);
    succs.get(e.source)!.push(e.target);
  }

  // Columns: longest path from the sources. The graph has no cycles (the editor
  // refuses them), but the guard keeps a bad file from looping forever.
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let changed = true, guard = 0; changed && guard < nodes.length; guard++) {
    changed = false;
    for (const e of links) {
      if (rank.get(e.target)! < rank.get(e.source)! + 1) {
        rank.set(e.target, rank.get(e.source)! + 1);
        changed = true;
      }
    }
  }
  // Inputs fed by nothing move next to the first node they feed.
  for (const n of nodes) {
    const next = succs.get(n.id)!;
    if (!preds.get(n.id)!.length && next.length) rank.set(n.id, Math.min(...next.map((t) => rank.get(t)!)) - 1);
  }

  const columnCount = Math.max(...rank.values()) + 1;
  // Start from the current top-to-bottom order, then sort each column by the
  // mean slot of its neighbours, a few sweeps each way.
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const n of [...nodes].sort((a, b) => a.position.y - b.position.y)) columns[rank.get(n.id)!].push(n.id);
  const slot = new Map<string, number>();
  const index = () => columns.forEach((c) => c.forEach((id, i) => slot.set(id, i / Math.max(1, c.length - 1))));
  index();
  const sortBy = (c: string[], neighbours: Map<string, string[]>) => {
    const mean = new Map(
      c.map((id, i) => {
        const near = neighbours.get(id)!.filter((o) => slot.has(o));
        return [id, near.length ? near.reduce((a, o) => a + slot.get(o)!, 0) / near.length : i / Math.max(1, c.length - 1)];
      }),
    );
    c.sort((a, b) => mean.get(a)! - mean.get(b)!);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let r = 1; r < columnCount; r++) {
      sortBy(columns[r], preds);
      index();
    }
    for (let r = columnCount - 2; r >= 0; r--) {
      sortBy(columns[r], succs);
      index();
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const positions = new Map<string, XYPosition>();
  let x = 0;
  let height = 0;
  for (const column of columns) {
    if (!column.length) continue;
    let y = 0;
    let width = 0;
    for (const id of column) {
      const size = sizeOf(byId.get(id)!);
      positions.set(id, { x, y });
      y += size.height + NODE_GAP;
      width = Math.max(width, size.width);
    }
    height = Math.max(height, y - NODE_GAP);
    x += width + RANK_GAP;
  }
  return { positions, box: { width: x - RANK_GAP, height } };
}

/**
 * Bottom-left packing within `maxWidth`: each box, tallest first, goes where
 * it sits highest, so short workflows fill the space beside and under taller
 * ones instead of leaving rows half empty.
 */
function skyline(boxes: Box[], maxWidth: number): { corners: XYPosition[]; width: number; height: number } {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].height - boxes[a].height || boxes[b].width - boxes[a].width);
  const placed: Rect[] = [];
  const corners: XYPosition[] = [];
  for (const i of order) {
    const b = boxes[i];
    let best: XYPosition | null = null;
    for (const x of [0, ...placed.map((p) => p.x + p.width + GROUP_GAP)]) {
      if (x > 0 && x + b.width > maxWidth) continue;
      const y = placed
        .filter((p) => x < p.x + p.width + GROUP_GAP && p.x < x + b.width + GROUP_GAP)
        .reduce((top, p) => Math.max(top, p.y + p.height + GROUP_GAP), 0);
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
    }
    corners[i] = best!;
    placed.push({ ...best!, ...b });
  }
  return {
    corners,
    width: Math.max(...placed.map((p) => p.x + p.width)),
    height: Math.max(...placed.map((p) => p.y + p.height)),
  };
}

/** Packs boxes at the width that gives the smallest block close to a screen's shape. */
function pack(boxes: Box[]): XYPosition[] {
  const widest = Math.max(...boxes.map((b) => b.width));
  const total = boxes.reduce((a, b) => a + b.width + GROUP_GAP, 0);
  let best: { corners: XYPosition[]; score: number } | null = null;
  for (let i = 0; i <= 24; i++) {
    const r = skyline(boxes, widest + ((total - widest) * i) / 24);
    // Area, scaled up the further the block strays from the target shape.
    const stretch = Math.max(r.width / r.height / ASPECT, (ASPECT * r.height) / r.width);
    const score = r.width * r.height * stretch;
    if (!best || score < best.score) best = { corners: r.corners, score };
  }
  return best!.corners;
}

/**
 * Arranges `nodes` compactly: each workflow (nodes linked together) is laid out
 * in top-aligned columns, a node one column right of the nodes feeding it, then the
 * workflows are packed together instead of stacked in one tall column. The
 * result keeps the group's top-left corner, so arranging a selection doesn't
 * move it across the canvas, and steps down past `others` (the nodes left in
 * place) rather than covering them.
 */
export function arrange(nodes: FlowNode[], edges: Edge[], others: FlowNode[] = []): Map<string, XYPosition> {
  const laid = components(nodes, edges).map((group) => layered(group, edges));
  const corners = pack(laid.map((l) => l.box));

  const origin = {
    x: Math.min(...nodes.map((n) => n.position.x)),
    y: Math.min(...nodes.map((n) => n.position.y)),
  };
  const relative = new Map<string, XYPosition>();
  laid.forEach((l, i) => {
    for (const [id, p] of l.positions) relative.set(id, { x: corners[i].x + p.x, y: corners[i].y + p.y });
  });

  // Move the whole group down until none of its nodes sits on a node left in place.
  const fixed: Rect[] = others.map((n) => ({ ...n.position, ...sizeOf(n) }));
  const rects = (dy: number) =>
    nodes.map((n) => ({ x: origin.x + relative.get(n.id)!.x, y: origin.y + dy + relative.get(n.id)!.y, ...sizeOf(n) }));
  let dy = 0;
  for (let guard = 0; guard < 100; guard++) {
    const hits = rects(dy).flatMap((r) => fixed.filter((f) => overlaps(r, f, NODE_GAP)).map((f) => f.y + f.height + NODE_GAP - r.y));
    if (!hits.length) break;
    dy += Math.max(...hits);
  }

  const positions = new Map<string, XYPosition>();
  for (const [id, p] of relative) positions.set(id, { x: origin.x + p.x, y: origin.y + dy + p.y });
  return positions;
}
