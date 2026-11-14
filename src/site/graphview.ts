// Draws a layered graph in SVG. drawLevel makes one level's group (nodes, edges, hover); graphView wraps it in a
// pannable, zoomable figure for the detail pages; the explorer animates between levels' groups in one SVG.
import { h, s, nodeHref } from './dom.js';
import { edgePath, layout, type Layout } from './layout.js';

export interface GNode {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
  /** A CSS colour (a token: `var(--layer-tool)`). */
  readonly color?: string;
  readonly rank?: number;
  readonly badge?: { count: number; severity: 'error' | 'warning' | 'info' };
  /** Where a click goes; defaults to the node's page. */
  readonly href?: string;
  /** The node id the explorer opens for it, when not its own id (a dimmed repository stands for that repository). */
  readonly target?: string;
  readonly muted?: boolean;
}

export interface GEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly weight: number;
  readonly title: string;
  /** A link to something outside the view: drawn lighter. */
  readonly muted?: boolean;
}

export interface GraphOptions {
  readonly maxPerRow?: number;
  readonly rankLabels?: Map<number, string>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawnLevel {
  readonly group: SVGGElement;
  readonly layout: Layout;
  /** The drawing's extent, padding and rank labels included. */
  readonly bounds: Rect;
  readonly nodeEls: Map<string, SVGElement>;
}

export const EDGE_KINDS = ['call', 'import', 'dev-import', 'type-import', 'dynamic-import', 'reexport', 'worker', 'npm', 'dev', 'pin', 'packed', 'runtime'];
const CHAR = 7.2;

export function layoutGraph(nodes: GNode[], edges: GEdge[], options: GraphOptions = {}): { layout: Layout; edges: GEdge[]; bounds: Rect } {
  const sized = nodes.map((n) => ({
    id: n.id,
    width: Math.round(Math.min(280, Math.max(110, Math.max(n.label.length * (CHAR + 0.6), (n.sub ?? '').length * 6.2) + 34))),
    height: n.sub ? 46 : 32,
    rank: n.rank,
  }));
  const known = new Set(nodes.map((n) => n.id));
  const drawn = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const lay = layout(sized, drawn, { maxPerRow: options.maxPerRow ?? 8, gapY: options.rankLabels ? 84 : 64 });
  const pad = 40;
  const labelPad = options.rankLabels ? 150 : 0;
  // The layout can leave room on the left after nudging rows toward their links: measure from the leftmost box.
  const minX = Math.min(0, ...[...lay.nodes.values()].map((p) => p.x));
  const left = lay.nodes.size ? Math.min(...[...lay.nodes.values()].map((p) => p.x)) : 0;
  const x0 = Math.max(minX, left);
  return { layout: lay, edges: drawn, bounds: { x: x0 - pad - labelPad, y: -pad, w: lay.width - x0 + pad * 2 + labelPad, h: Math.max(lay.height, 40) + pad * 2 } };
}

/** Arrowheads for every kind of link, once per SVG. */
export function arrowDefs(): SVGElement {
  const defs = s('defs');
  for (const kind of EDGE_KINDS) {
    defs.append(s('marker', { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', class: `arrow edge-${kind}` })));
  }
  return defs;
}

export function drawLevel(nodes: GNode[], edges: GEdge[], options: GraphOptions = {}): DrawnLevel {
  const { layout: lay, edges: drawn, bounds } = layoutGraph(nodes, edges, options);
  const group = s('g', { class: 'level' }) as SVGGElement;
  const edgeLayer = s('g', { class: 'edges' });
  const nodeLayer = s('g', { class: 'nodes' });

  if (options.rankLabels) {
    // Each rank's label sits just left of the leftmost node on its first row.
    const rows = new Map<number, { x: number; y: number; h: number }>();
    for (const p of lay.nodes.values()) {
      const cur = rows.get(p.rank);
      if (!cur || p.y < cur.y - 1) rows.set(p.rank, { x: p.x, y: p.y, h: p.height });
      else if (Math.abs(p.y - cur.y) < 1 && p.x < cur.x) cur.x = p.x;
    }
    for (const [rank, row] of rows) {
      const label = options.rankLabels.get(rank);
      if (label) group.append(s('text', { class: 'rank-label', x: row.x - 16, y: row.y + row.h / 2 + 4, 'text-anchor': 'end' }, label));
    }
  }
  // Flowing dots along each link, from importer to imported: shown when the SVG has the `flowing` class.
  const flowLayer = s('g', { class: 'flows', 'aria-hidden': 'true' });
  group.append(edgeLayer, flowLayer, nodeLayer);

  const max = Math.max(1, ...drawn.map((e) => e.weight));
  const edgeEls = new Map<string, SVGElement[]>();
  for (const e of drawn) {
    const a = lay.nodes.get(e.from)!;
    const b = lay.nodes.get(e.to)!;
    const width = 1 + 3 * Math.log(1 + e.weight) / Math.log(1 + max);
    const path = s('path', { d: edgePath(a, b), class: `edge edge-${e.kind}${e.muted ? ' outer' : ''}`, 'stroke-width': width.toFixed(2), 'marker-end': `url(#arrow-${e.kind})` }, s('title', null, e.title));
    edgeLayer.append(path);
    const seconds = Math.max(0.9, 3.2 - Math.log2(1 + e.weight) * 0.45);
    const flow = s('path', { d: edgePath(a, b), class: `flow edge-${e.kind}${e.muted ? ' outer' : ''}`, style: `animation-duration:${seconds.toFixed(2)}s` });
    flowLayer.append(flow);
    for (const id of [e.from, e.to]) (edgeEls.get(id) ?? edgeEls.set(id, []).get(id)!).push(path, flow);
  }

  const nodeEls = new Map<string, SVGElement>();
  for (const n of nodes) {
    const p = lay.nodes.get(n.id)!;
    const g = s('a', { href: n.href ?? nodeHref(n.id), class: `node${n.muted ? ' muted' : ''}`, transform: `translate(${p.x},${p.y})`, 'data-id': n.id, 'aria-label': `${n.label}${n.sub ? `, ${n.sub}` : ''}` });
    g.append(
      s('rect', { width: p.width, height: p.height, rx: 7, class: 'node-box' }),
      s('rect', { width: 5, height: p.height, rx: 2, class: 'node-bar', style: `fill:${n.color ?? 'var(--text-3)'}` }),
      s('text', { x: 14, y: n.sub ? 19 : 20, class: 'node-label' }, n.label),
    );
    if (n.sub) g.append(s('text', { x: 14, y: 36, class: 'node-sub' }, n.sub));
    if (n.badge && n.badge.count) {
      const text = String(n.badge.count);
      const bw = 10 + text.length * 7;
      g.append(s('g', { class: `badge badge-${n.badge.severity}`, transform: `translate(${p.width - bw / 2 - 4},${-6})` },
        s('rect', { x: -bw / 2, y: -8, width: bw, height: 16, rx: 8 }), s('text', { x: 0, y: 4, 'text-anchor': 'middle' }, text)));
    }
    nodeLayer.append(g);
    nodeEls.set(n.id, g);
  }

  // Hover: light up a node's edges and neighbours.
  const neighbours = new Map<string, Set<string>>();
  for (const e of drawn) {
    (neighbours.get(e.from) ?? neighbours.set(e.from, new Set()).get(e.from)!).add(e.to);
    (neighbours.get(e.to) ?? neighbours.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const focus = (id: string | null): void => {
    group.classList.toggle('focused', id !== null);
    for (const [nid, el] of nodeEls) el.classList.toggle('lit', id !== null && (nid === id || !!neighbours.get(id)?.has(nid)));
    for (const el of edgeLayer.children) el.classList.remove('lit');
    for (const el of flowLayer.children) el.classList.remove('lit');
    if (id) for (const el of edgeEls.get(id) ?? []) el.classList.add('lit');
  };
  for (const [id, el] of nodeEls) {
    el.addEventListener('mouseenter', () => focus(id));
    el.addEventListener('focus', () => focus(id));
    el.addEventListener('mouseleave', () => focus(null));
    el.addEventListener('blur', () => focus(null));
  }
  return { group, layout: lay, bounds, nodeEls };
}

/** The viewBox showing `r` whole in a viewport of aspect `aspect` (width / height), centred. */
export function fitRect(r: Rect, aspect: number): Rect {
  if (!Number.isFinite(aspect) || aspect <= 0) return { ...r };
  if (r.w / r.h > aspect) {
    const h = r.w / aspect;
    return { x: r.x, y: r.y - (h - r.h) / 2, w: r.w, h };
  }
  const w = r.h * aspect;
  return { x: r.x - (w - r.w) / 2, y: r.y, w, h: r.h };
}

/** Drag to pan, wheel (with Ctrl or ⌘ unless `always`) to zoom, on an SVG whose viewBox `get`/`set` manage. */
export function panZoom(svg: SVGSVGElement, get: () => Rect, set: (r: Rect) => void, always: boolean): void {
  const toUser = (ev: { clientX: number; clientY: number }): [number, number] => {
    const vb = get();
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb.w / r.width, vb.h / r.height);
    const offX = (r.width * scale - vb.w) / 2;
    const offY = (r.height * scale - vb.h) / 2;
    return [vb.x - offX + (ev.clientX - r.left) * scale, vb.y - offY + (ev.clientY - r.top) * scale];
  };
  svg.addEventListener('wheel', (ev) => {
    if (!always && !ev.ctrlKey && !ev.metaKey && !svg.classList.contains('zoomed')) return; // let the page scroll until the graph is used
    ev.preventDefault();
    const [cx, cy] = toUser(ev);
    const vb = get();
    const k = Math.exp(ev.deltaY * 0.0015);
    set({ x: cx - (cx - vb.x) * k, y: cy - (cy - vb.y) * k, w: vb.w * k, h: vb.h * k });
  }, { passive: false });
  let drag: { x: number; y: number; vb: Rect; moved: boolean } | null = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, vb: { ...get() }, moved: false };
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const scale = Math.max(drag.vb.w / r.width, drag.vb.h / r.height);
    const dx = (ev.clientX - drag.x) * scale;
    const dy = (ev.clientY - drag.y) * scale;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) {
      if (!drag.moved) svg.setPointerCapture(ev.pointerId);
      drag.moved = true;
    }
    if (drag.moved) set({ ...drag.vb, x: drag.vb.x - dx, y: drag.vb.y - dy });
  });
  const endDrag = (ev: PointerEvent): void => {
    if (drag?.moved) {
      svg.classList.add('zoomed');
      // A drag is not a click on the node under the pointer.
      const stop = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      svg.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => svg.removeEventListener('click', stop, { capture: true }), 0);
    }
    drag = null;
    if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
}

export const toolButton = (label: string, title: string, fn: () => void): HTMLButtonElement =>
  h('button', { type: 'button', class: 'icon-button', title, 'aria-label': title, onclick: fn }, label);

/** A graph as a figure on a page: fits its box, pans, zooms. */
export function graphView(nodes: GNode[], edges: GEdge[], options: GraphOptions = {}): HTMLElement {
  const drawn = drawLevel(nodes, edges, options);
  const W = drawn.bounds.w;
  const H = drawn.bounds.h;
  const svg = s('svg', { class: 'graph', role: 'img', 'aria-label': 'Dependency graph' }) as SVGSVGElement;
  svg.append(arrowDefs(), drawn.group);
  let vb: Rect = { ...drawn.bounds };
  const apply = (): void => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  apply();
  panZoom(svg, () => vb, (r) => {
    if (r.w > W * 4 || r.w < 120) return;
    vb = r;
    apply();
  }, false);
  const zoomBy = (k: number): void => {
    svg.classList.add('zoomed');
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    vb = { x: cx - (vb.w * k) / 2, y: cy - (vb.h * k) / 2, w: vb.w * k, h: vb.h * k };
    apply();
  };
  const tools = h('div', { class: 'graph-tools' },
    toolButton('+', 'Zoom in', () => zoomBy(0.8)),
    toolButton('−', 'Zoom out', () => zoomBy(1.25)),
    toolButton('⤢', 'Fit', () => { svg.classList.remove('zoomed'); vb = { ...drawn.bounds }; apply(); }),
  );
  return h('div', { class: 'graph-wrap', style: `aspect-ratio:${W} / ${H}` }, svg, tools);
}
