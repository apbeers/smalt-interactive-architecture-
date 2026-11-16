// The layer cake: the platform's layers as slabs, user tools on top and engines at the bottom, each repository a
// block on its slab sized by its code. Links run between blocks; a link that climbs from a lower layer to a higher one
// goes against the architecture and pulses red.
import type { IndexData } from '../model.js';
import { h, plural } from './dom.js';
import { colorReader, mix, rgba, View3D, type Box, type Screen, type V3 } from './engine3d.js';
import { LAYER_ORDER, layerColor, layerName } from './levels.js';

const SLAB_GAP = 26;
const SLAB = 120;

export function cakeView(idx: IndexData, params: URLSearchParams): HTMLElement {
  const includeDev = params.get('dev') === '1';
  const stage = h('div', { class: 'city-stage' });
  const view = new View3D(stage);
  view.canvas.setAttribute('role', 'img');
  view.canvas.setAttribute('aria-label', 'The layers as slabs, with links between repositories');
  let col = colorReader(stage);
  new MutationObserver(() => {
    col = colorReader(stage);
    view.redraw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const layers = LAYER_ORDER.filter((l) => l !== 'other' && l !== 'brand' && idx.repos.some((r) => r.layer === l && r.stats.files > 0));
  const level = (layer: string): number => layers.indexOf(layer);
  const blocks = new Map<string, { box: Box; layer: string; top: V3 }>();
  layers.forEach((layer, i) => {
    const y = (layers.length - 1 - i) * SLAB_GAP;
    const repos = idx.repos.filter((r) => r.layer === layer && r.stats.files > 0).sort((a, b) => b.stats.loc - a.stats.loc);
    const sizes = repos.map((r) => 6 + Math.sqrt(r.stats.loc) * 0.12);
    const total = sizes.reduce((s, v) => s + v, 0) + (repos.length - 1) * 6;
    let x = -total / 2;
    repos.forEach((r, k) => {
      const w = sizes[k]!;
      const box = { x0: x, x1: x + w, z0: -w / 2, z1: w / 2, y0: y + 1.2, y1: y + 1.2 + 2 + Math.sqrt(r.stats.loc) * 0.05 };
      blocks.set(r.name, { box, layer, top: { x: x + w / 2, y: box.y1, z: 0 } });
      x += w + 6;
    });
  });

  // Links between repositories: source imports and runtime dependencies (and, if asked, tests' imports).
  const kinds = new Set(['import', 'npm', 'pin', 'runtime', 'worker', ...(includeDev ? ['dev-import', 'packed'] : [])]);
  const links = idx.edges.filter((e) => kinds.has(e.kind) && blocks.has(e.from) && blocks.has(e.to) && e.from !== e.to).map((e) => {
    const a = blocks.get(e.from)!;
    const b = blocks.get(e.to)!;
    const up = level(a.layer) > level(b.layer);
    const same = a.layer === b.layer;
    return { e, a, b, up, same };
  });
  const upward = links.filter((l) => l.up);

  let hover: string | null = null;
  const picks: { repo: string; quad: Screen[]; depth: number }[] = [];
  view.animating = upward.length > 0;
  view.onDraw = (now) => {
    const bg = col('var(--bg)');
    const text = col('var(--text)');
    const text3 = col('var(--text-3)');
    const surface = col('var(--surface)');
    const danger = col('var(--danger)');
    picks.length = 0;
    // Slabs, bottom first (the camera looks down), each with its links' lower ends and blocks.
    const slabOrder = layers.map((l, i) => ({ l, i })).reverse();
    for (const { l, i } of slabOrder) {
      const y = (layers.length - 1 - i) * SLAB_GAP;
      const tint = mix(surface, col(layerColor(idx, l)), 0.22);
      view.box({ x0: -SLAB / 2, x1: SLAB / 2, z0: -SLAB / 4, z1: SLAB / 4, y0: y, y1: y + 1.2 }, tint, 0.9);
      const at = view.project({ x: -SLAB / 2, y: y + 1.2, z: SLAB / 4 });
      view.label(layerName(idx, l), { ...at, sx: at.sx - 8 }, rgba(text3), rgba(bg, 0.9), '700 12px system-ui, sans-serif', 'right');
      const here = [...blocks].filter(([, b]) => b.layer === l).sort((p, q) => view.project(q[1].top).depth - view.project(p[1].top).depth);
      for (const [name, b] of here) {
        const lit = !hover || hover === name || links.some((k) => (k.e.from === hover && k.e.to === name) || (k.e.to === hover && k.e.from === name));
        const quad = view.box(b.box, col(layerColor(idx, l)), lit ? 1 : 0.3, hover === name ? rgba(col('var(--accent)')) : undefined);
        picks.push({ repo: name, quad, depth: view.project(b.top).depth });
        const t = view.project(b.top);
        view.label(name, { ...t, sy: t.sy - 6 }, rgba(text, lit ? 1 : 0.4), rgba(bg, 0.85), '600 11px system-ui, sans-serif');
      }
    }
    // Links over everything: downward in the link colour, upward red and moving.
    const offset = -(now / 30) % 14;
    for (const l of links) {
      const focus = !hover || l.e.from === hover || l.e.to === hover;
      if (!focus && !l.up) continue;
      const lift = l.same ? 8 : 4;
      const pts = view.arc(l.a.top, l.b.top, lift, 14);
      if (l.up) view.stroke(pts, rgba(danger, focus ? 0.95 : 0.4), 2.2, [7, 7], offset);
      else view.stroke(pts, rgba(col('var(--primary)'), 0.45), 1 + Math.log2(1 + l.e.weight) * 0.35, [4, 10], offset / 2);
    }
  };
  view.onHover = (x, y) => {
    const hit = picks.filter((p) => View3D.inside(p.quad, x, y)).sort((a, b) => a.depth - b.depth)[0]?.repo ?? null;
    if (hit !== hover) {
      hover = hit;
      view.canvas.style.cursor = hit ? 'pointer' : 'grab';
      view.redraw();
    }
  };
  view.onClick = (x, y) => {
    const hit = picks.filter((p) => View3D.inside(p.quad, x, y)).sort((a, b) => a.depth - b.depth)[0]?.repo;
    if (hit) location.hash = `#/e/${encodeURIComponent(hit)}`;
  };
  const centreY = ((layers.length - 1) * SLAB_GAP) / 2;
  const home = (): void => view.flyTo({ x: 0, y: centreY, z: 0 }, 400, 800, -0.5, 0.42);
  view.cam = { target: { x: 0, y: centreY, z: 0 }, yaw: 0.6, pitch: 0.9, dist: 640 };
  home();

  const list = upward.length
    ? h('ul', { class: 'plain' }, upward.map((l) => h('li', null, h('span', { class: 'chip sev sev-warning' }, 'up'), ' ', h('a', { href: `#/e/${encodeURIComponent(l.e.from)}` }, l.e.from), ` (${layerName(idx, l.a.layer)}) → `, h('a', { href: `#/e/${encodeURIComponent(l.e.to)}` }, l.e.to), ` (${layerName(idx, l.b.layer)}), ${l.e.kind} ×${l.e.weight}`)))
    : h('p', { class: 'muted' }, 'None: every link points down the stack.');
  const devToggle = h('input', { type: 'checkbox', checked: includeDev, onchange: () => (location.hash = `#/layers${devToggle.checked ? '?dev=1' : ''}`) });
  return h('div', { class: 'view-page' },
    h('div', { class: 'view-bar' },
      h('h1', null, 'Layers'),
      h('label', { class: 'toggle' }, devToggle, ' Include tests\' and docs\' imports and packed.json pins'),
      h('button', { type: 'button', class: 'icon-button', onclick: home }, 'Reset view'),
      h('span', { class: 'muted' }, `${plural(links.length, 'link')}; ${plural(upward.length, 'climbs', 'climb')} against the layers`)),
    h('div', { class: 'view-body' }, stage, h('div', { class: 'city-card' }, h('strong', null, 'Links that climb'), h('p', { class: 'muted' }, 'A lower layer depending on a higher one: the layers no longer stack.'), list)),
    h('p', { class: 'view-help muted' }, 'Drag to turn · scroll or pinch to zoom · hover a block for its links · click it to explore'),
  );
}
