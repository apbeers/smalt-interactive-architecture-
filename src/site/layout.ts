// A layered graph layout (the Sugiyama idea, kept small): rank nodes so that what depends sits above what it depends
// on, order each rank to cut crossings, then place. Pure functions with no DOM, so tests run it in Node.

export interface LayoutNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** A rank to keep (the platform view ranks by layer); otherwise ranked from the edges. */
  readonly rank?: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
}

export interface Placed {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rank: number;
}

export interface Layout {
  readonly nodes: Map<string, Placed>;
  readonly width: number;
  readonly height: number;
}

export interface LayoutOptions {
  readonly gapX?: number;
  readonly gapY?: number;
  /** At most this many nodes on one row; a fuller rank wraps onto more rows. */
  readonly maxPerRow?: number;
}

/** Ranks from the edges: sources at 0, each node one below the lowest of the nodes that point at it. Cycles are broken where DFS finds them. */
export function rankNodes(ids: string[], edges: LayoutEdge[]): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) if (out.has(e.from) && out.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  // Drop back edges (DFS, iterative) so the rest is acyclic.
  const state = new Map<string, number>(); // 1 on stack, 2 done
  const keep = new Map<string, string[]>();
  for (const id of ids) keep.set(id, []);
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const succ = out.get(top[0])!;
      if (top[1] < succ.length) {
        const w = succ[top[1]++]!;
        const s = state.get(w);
        if (s === 1) continue; // back edge
        keep.get(top[0])!.push(w);
        if (!s) {
          state.set(w, 1);
          stack.push([w, 0]);
        }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  // Longest path from the sources, in topological order.
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const succ of keep.values()) for (const w of succ) indegree.set(w, indegree.get(w)! + 1);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of keep.get(v)!) {
      rank.set(w, Math.max(rank.get(w)!, rank.get(v)! + 1));
      indegree.set(w, indegree.get(w)! - 1);
      if (indegree.get(w) === 0) queue.push(w);
    }
  }
  return rank;
}

export function layout(nodes: LayoutNode[], edges: LayoutEdge[], options: LayoutOptions = {}): Layout {
  const gapX = options.gapX ?? 28;
  const gapY = options.gapY ?? 70;
  const maxPerRow = options.maxPerRow ?? 10;
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ranks = nodes.every((n) => n.rank !== undefined) ? new Map(nodes.map((n) => [n.id, n.rank!])) : rankNodes(ids, edges);

  // Rows: each rank, wrapped when too full.
  const rankList = [...new Set(ranks.values())].sort((a, b) => a - b);
  let rows: string[][] = [];
  for (const r of rankList) rows.push(ids.filter((id) => ranks.get(id) === r));

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    succs.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
  }

  // Order: barycenter sweeps, down then up.
  const position = new Map<string, number>();
  const index = (): void => rows.forEach((row) => row.forEach((id, i) => position.set(id, i / Math.max(1, row.length - 1))));
  index();
  const bary = (id: string, neighbours: string[]): number => {
    const ps = neighbours.map((n) => position.get(n)).filter((p): p is number => p !== undefined);
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : position.get(id)!;
  };
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
    for (const i of order) {
      const row = rows[i]!;
      const keyed = row.map((id) => ({ id, key: bary(id, down ? preds.get(id)! : succs.get(id)!) }));
      keyed.sort((a, b) => a.key - b.key);
      rows[i] = keyed.map((k) => k.id);
      rows[i]!.forEach((id, j) => position.set(id, j / Math.max(1, row.length - 1)));
    }
  }

  // Wrap full rows.
  const wrapped: { ids: string[]; rank: number }[] = [];
  rows.forEach((row, i) => {
    for (let k = 0; k < row.length; k += maxPerRow) wrapped.push({ ids: row.slice(k, k + maxPerRow), rank: rankList[i]! });
  });
  rows = wrapped.map((w) => w.ids);

  // Place: rows centred on the widest, then nudged toward their neighbours without overlapping.
  const rowWidth = (row: string[]): number => row.reduce((s, id) => s + byId.get(id)!.width, 0) + gapX * Math.max(0, row.length - 1);
  const width = Math.max(1, ...rows.map(rowWidth));
  const x = new Map<string, number>();
  rows.forEach((row) => {
    let cx = (width - rowWidth(row)) / 2;
    for (const id of row) {
      x.set(id, cx);
      cx += byId.get(id)!.width + gapX;
    }
  });
  for (let pass = 0; pass < 4; pass++) {
    for (const row of rows) {
      const want = row.map((id) => {
        const ns = [...preds.get(id)!, ...succs.get(id)!].filter((n) => x.has(n));
        if (!ns.length) return x.get(id)!;
        const centre = ns.reduce((s, n) => s + x.get(n)! + byId.get(n)!.width / 2, 0) / ns.length;
        return centre - byId.get(id)!.width / 2;
      });
      // Keep order and gaps: forward then backward pass.
      for (let i = 0; i < row.length; i++) {
        const prev = i > 0 ? x.get(row[i - 1]!)! + byId.get(row[i - 1]!)!.width + gapX : 0;
        x.set(row[i]!, Math.max(prev, (want[i]! + x.get(row[i]!)!) / 2));
      }
      for (let i = row.length - 1; i >= 0; i--) {
        const next = i < row.length - 1 ? x.get(row[i + 1]!)! - gapX - byId.get(row[i]!)!.width : Infinity;
        x.set(row[i]!, Math.max(0, Math.min(x.get(row[i]!)!, next)));
      }
    }
  }
  const placed = new Map<string, Placed>();
  let y = 0;
  let maxX = 0;
  rows.forEach((row, i) => {
    const h = Math.max(...row.map((id) => byId.get(id)!.height));
    for (const id of row) {
      const n = byId.get(id)!;
      placed.set(id, { id, x: x.get(id)!, y: y + (h - n.height) / 2, width: n.width, height: n.height, rank: wrapped[i]!.rank });
      maxX = Math.max(maxX, x.get(id)! + n.width);
    }
    y += h + gapY;
  });
  return { nodes: placed, width: maxX, height: Math.max(0, y - gapY) };
}

/** An SVG path from the bottom of `a` to the top of `b` (or around, when `b` is not below). */
export function edgePath(a: Placed, b: Placed): string {
  const ax = a.x + a.width / 2;
  const bx = b.x + b.width / 2;
  if (b.y > a.y + a.height / 2) {
    const ay = a.y + a.height;
    const by = b.y;
    const my = (ay + by) / 2;
    return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`;
  }
  if (b.y + b.height < a.y) {
    const ay = a.y;
    const by = b.y + b.height;
    const my = (ay + by) / 2;
    return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`;
  }
  // Same row: an arc below.
  const ay = a.y + a.height;
  const by = b.y + b.height;
  const dip = Math.max(ay, by) + 30 + Math.abs(ax - bx) / 8;
  return `M${ax},${ay} C${ax},${dip} ${bx},${dip} ${bx},${by}`;
}
