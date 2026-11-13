// Draws a layered graph in SVG: pan by dragging, zoom with the wheel or the buttons, hover to see a node's links,
// click (or Enter) to open it.
import { h, s, nodeHref } from './dom.js';
import { edgePath, layout } from './layout.js';

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

const CHAR = 7.2;

export function graphView(nodes: GNode[], edges: GEdge[], options: GraphOptions = {}): HTMLElement {
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
  const W = lay.width + pad * 2 + labelPad;
  const H = lay.height + pad * 2;

  const viewport = s('g', { class: 'viewport' });
  const edgeLayer = s('g', { class: 'edges' });
  const nodeLayer = s('g', { class: 'nodes' });
  viewport.append(edgeLayer, nodeLayer);

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
      if (label) viewport.append(s('text', { class: 'rank-label', x: row.x - 16, y: row.y + row.h / 2 + 4, 'text-anchor': 'end' }, label));
    }
  }

  const max = Math.max(1, ...drawn.map((e) => e.weight));
  const edgeEls = new Map<string, SVGElement[]>();
  for (const e of drawn) {
    const a = lay.nodes.get(e.from)!;
    const b = lay.nodes.get(e.to)!;
    const width = 1 + 3 * Math.log(1 + e.weight) / Math.log(1 + max);
    const path = s('path', { d: edgePath(a, b), class: `edge edge-${e.kind}${e.muted ? ' outer' : ''}`, 'stroke-width': width.toFixed(2), 'marker-end': `url(#arrow-${e.kind})` }, s('title', null, e.title));
    edgeLayer.append(path);
    for (const id of [e.from, e.to]) (edgeEls.get(id) ?? edgeEls.set(id, []).get(id)!).push(path);
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

  const svg = s('svg', { class: 'graph', role: 'img', 'aria-label': 'Dependency graph', viewBox: `0 0 ${W} ${H}` });
  const defs = s('defs');
  for (const kind of new Set(drawn.map((e) => e.kind))) {
    defs.append(s('marker', { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', class: `arrow edge-${kind}` })));
  }
  svg.append(defs, viewport);

  // Hover: light up a node's edges and neighbours.
  const neighbours = new Map<string, Set<string>>();
  for (const e of drawn) {
    (neighbours.get(e.from) ?? neighbours.set(e.from, new Set()).get(e.from)!).add(e.to);
    (neighbours.get(e.to) ?? neighbours.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const focus = (id: string | null): void => {
    svg.classList.toggle('focused', id !== null);
    for (const [nid, el] of nodeEls) el.classList.toggle('lit', id !== null && (nid === id || !!neighbours.get(id)?.has(nid)));
    for (const el of edgeLayer.children) el.classList.remove('lit');
    if (id) for (const el of edgeEls.get(id) ?? []) el.classList.add('lit');
  };
  for (const [id, el] of nodeEls) {
    el.addEventListener('mouseenter', () => focus(id));
    el.addEventListener('focus', () => focus(id));
    el.addEventListener('mouseleave', () => focus(null));
    el.addEventListener('blur', () => focus(null));
  }

  // Pan and zoom, by changing the viewBox.
  let vb = { x: -pad - labelPad, y: -pad, w: W, h: H };
  const apply = (): void => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const fit = (): void => {
    vb = { x: -pad - labelPad, y: -pad, w: W, h: H };
    apply();
  };
  fit();
  const zoom = (factor: number, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2): void => {
    const w = Math.min(W * 4, Math.max(120, vb.w * factor));
    const k = w / vb.w;
    vb = { x: cx - (cx - vb.x) * k, y: cy - (cy - vb.y) * k, w, h: vb.h * k };
    apply();
  };
  const toUser = (ev: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb.w / r.width, vb.h / r.height);
    const offX = (r.width * scale - vb.w) / 2;
    const offY = (r.height * scale - vb.h) / 2;
    return [vb.x - offX + (ev.clientX - r.left) * scale, vb.y - offY + (ev.clientY - r.top) * scale];
  };
  svg.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey && !svg.classList.contains('zoomed')) return; // let the page scroll until the graph is used
    ev.preventDefault();
    const [cx, cy] = toUser(ev);
    zoom(Math.exp(ev.deltaY * 0.0015), cx, cy);
  }, { passive: false });
  let drag: { x: number; y: number; vb: typeof vb; moved: boolean } | null = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, vb: { ...vb }, moved: false };
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb.w / r.width, vb.h / r.height);
    const dx = (ev.clientX - drag.x) * scale;
    const dy = (ev.clientY - drag.y) * scale;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      if (!drag.moved) svg.setPointerCapture(ev.pointerId);
      drag.moved = true;
    }
    if (drag.moved) {
      vb = { ...drag.vb, x: drag.vb.x - dx, y: drag.vb.y - dy };
      apply();
    }
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

  const button = (label: string, title: string, fn: () => void): HTMLButtonElement => h('button', { type: 'button', class: 'icon-button', title, 'aria-label': title, onclick: fn }, label);
  const tools = h('div', { class: 'graph-tools' },
    button('+', 'Zoom in', () => { svg.classList.add('zoomed'); zoom(0.8); }),
    button('−', 'Zoom out', () => { svg.classList.add('zoomed'); zoom(1.25); }),
    button('⤢', 'Fit', () => { svg.classList.remove('zoomed'); fit(); }),
  );
  const wrap = h('div', { class: 'graph-wrap', style: `aspect-ratio:${W} / ${H}` }, svg, tools);
  return wrap;
}
