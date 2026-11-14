// The city: every repository a district, every folder a block, every file a building. Height is lines of code;
// colour is health, hot spots, change or layer. Click a building to see its imports as arcs; click a district's name to
// fly there.
import type { IndexData } from '../model.js';
import { loadJson } from './data.js';
import { h } from './dom.js';
import { colorReader, mix, rgba, treemap, View3D, type Box, type Rgb, type Screen, type V3 } from './engine3d.js';
import { layerColor } from './levels.js';

interface CityData {
  readonly roles: string[];
  readonly files: [string, number, number, number, number, number, number, number, number, number][];
  readonly links: [number, number, number][];
}

interface Building {
  readonly i: number;
  readonly id: string;
  readonly repo: string;
  readonly path: string;
  readonly loc: number;
  readonly exported: number;
  readonly tested: number;
  readonly worst: number;
  readonly churnLines: number;
  readonly commits: number;
  readonly dependents: number;
  readonly role: string;
  readonly hotspot: number;
  box: Box;
}

interface Plate {
  readonly id: string;
  readonly label: string;
  readonly repo: string;
  readonly depth: number;
  readonly box: Box;
}

interface Tree {
  name: string;
  path: string;
  weight: number;
  dirs: Map<string, Tree>;
  files: Building[];
}

interface Pick {
  readonly b: Building;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly depth: number;
}

type Mode = 'health' | 'hotspots' | 'churn' | 'layer';

const WORLD = 240;
const MODES: [Mode, string, string][] = [
  ['health', 'Health', 'Tested source green, untested amber, files with warnings or errors in their colours; tests and docs grey'],
  ['hotspots', 'Hot spots', 'Change × dependents: where bugs tend to come from'],
  ['churn', 'Change', 'How often each file changed (commits)'],
  ['layer', 'Layers', 'The brand colour of each repository\'s layer'],
];

export async function cityView(idx: IndexData, params: URLSearchParams): Promise<HTMLElement> {
  const data = await loadJson<CityData>('data/city.json');
  let mode = (params.get('color') as Mode) ?? 'health';
  if (!MODES.some((m) => m[0] === mode)) mode = 'health';
  let showRepoLinks = params.get('links') === 'repos';

  const stage = h('div', { class: 'city-stage' });
  const view = new View3D(stage);
  view.canvas.setAttribute('role', 'img');
  view.canvas.setAttribute('aria-label', 'The platform as a city: districts are repositories, buildings are files');
  let col = colorReader(stage);
  new MutationObserver(() => {
    col = colorReader(stage);
    view.redraw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Buildings, grouped into a tree per repository.
  const buildings: Building[] = data.files.map(([id, loc, exported, tested, worst, churnLines, commits, dependents, role, hotspot], i) => {
    const repo = id.split('/')[0]!;
    return { i, id, repo, path: id.slice(repo.length + 1), loc, exported, tested, worst, churnLines, commits, dependents, role: data.roles[role] ?? 'src', hotspot, box: { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0 } };
  });
  const trees = new Map<string, Tree>();
  for (const b of buildings) {
    let t = trees.get(b.repo);
    if (!t) trees.set(b.repo, (t = { name: b.repo, path: '', weight: 0, dirs: new Map(), files: [] }));
    const segs = b.path.split('/');
    let node = t;
    node.weight += Math.max(b.loc, 6);
    for (const seg of segs.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) node.dirs.set(seg, (next = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, weight: 0, dirs: new Map(), files: [] }));
      next.weight += Math.max(b.loc, 6);
      node = next;
    }
    node.files.push(b);
  }

  // Layout: districts by size, then blocks and buildings inside, each level a little higher and inset.
  const plates: Plate[] = [];
  const districts = treemap([...trees.values()].map((t) => ({ item: t, weight: t.weight })), -WORLD / 2, -WORLD / 2, WORLD, WORLD);
  const place = (t: Tree, repo: string, x: number, z: number, w: number, d: number, depth: number): void => {
    const pad = depth === 0 ? 2.2 : 0.7;
    const y0 = depth * 0.35;
    plates.push({ id: depth === 0 ? repo : `${repo}/${t.path}/`, label: depth === 0 ? repo : t.name + '/', repo, depth, box: { x0: x + 0.3, x1: x + w - 0.3, z0: z + 0.3, z1: z + d - 0.3, y0, y1: y0 + 0.35 } });
    const inner = { x: x + pad, z: z + pad, w: Math.max(0.1, w - pad * 2), d: Math.max(0.1, d - pad * 2) };
    const cells = treemap<Tree | Building>([...[...t.dirs.values()].map((c) => ({ item: c as Tree | Building, weight: c.weight })), ...t.files.map((f) => ({ item: f as Tree | Building, weight: Math.max(f.loc, 6) }))], inner.x, inner.z, inner.w, inner.d);
    for (const c of cells) {
      if ('dirs' in c.item) place(c.item, repo, c.x, c.y, c.w, c.h, depth + 1);
      else {
        const b = c.item;
        const inset = Math.min(c.w, c.h) * 0.12;
        const base = (depth + 1) * 0.35;
        b.box = { x0: c.x + inset, x1: c.x + c.w - inset, z0: c.y + inset, z1: c.y + c.h - inset, y0: base, y1: base + 0.5 + Math.sqrt(b.loc) * 0.55 };
      }
    }
  };
  for (const d of districts) place(d.item, d.item.name, d.x, d.y, d.w, d.h, 0);
  const districtOf = new Map(districts.map((d) => [d.item.name, d]));

  const maxHot = Math.max(1, ...buildings.map((b) => b.hotspot));
  const maxCommits = Math.max(1, ...buildings.map((b) => b.commits));
  const linksOf = new Map<number, { other: number; out: boolean; w: number }[]>();
  for (const [a, b, w] of data.links) {
    (linksOf.get(a) ?? linksOf.set(a, []).get(a)!).push({ other: b, out: true, w });
    (linksOf.get(b) ?? linksOf.set(b, []).get(b)!).push({ other: a, out: false, w });
  }

  let selected: Building | null = null;
  let hover: Building | null = null;
  const picks: Pick[] = [];
  const plateLabels: { p: Plate; at: Screen }[] = [];

  const colorOf = (b: Building): Rgb => {
    const grey = col('var(--text-3)');
    switch (mode) {
      case 'layer':
        return col(layerColor(idx, idx.repos.find((r) => r.name === b.repo)?.layer ?? ''));
      case 'hotspots':
        return b.hotspot ? mix(col('var(--smalt-300)'), col('var(--danger)'), Math.min(1, b.hotspot / maxHot) ** 0.7) : mix(grey, col('var(--surface)'), 0.4);
      case 'churn':
        return b.commits ? mix(col('var(--smalt-200)'), col('var(--kiln-500)'), Math.min(1, b.commits / maxCommits) ** 0.6) : mix(grey, col('var(--surface)'), 0.4);
      default:
        if (b.worst === 3) return col('var(--danger)');
        if (b.worst === 2) return col('var(--warning)');
        if (b.role !== 'src') return mix(grey, col('var(--surface)'), 0.35);
        return b.tested === 0 ? mix(col('var(--warning)'), col('var(--surface)'), 0.35) : col('var(--success)');
    }
  };
  const top = (b: Building): V3 => ({ x: (b.box.x0 + b.box.x1) / 2, y: b.box.y1, z: (b.box.z0 + b.box.z1) / 2 });

  view.onDraw = (now) => {
    const bg = col('var(--bg)');
    const text = col('var(--text)');
    const text3 = col('var(--text-3)');
    const surface = col('var(--surface)');
    // Plates (ground), far first.
    const order = (box: Box): number => view.project({ x: (box.x0 + box.x1) / 2, y: box.y0, z: (box.z0 + box.z1) / 2 }).depth;
    plateLabels.length = 0;
    for (const p of [...plates].sort((a, b) => a.depth - b.depth || order(b.box) - order(a.box))) {
      const tint = p.depth === 0 ? mix(surface, col(layerColor(idx, idx.repos.find((r) => r.name === p.repo)?.layer ?? '')), 0.18) : mix(surface, text3, 0.08 + p.depth * 0.04);
      view.box(p.box, tint, 1);
      if (p.depth === 0) plateLabels.push({ p, at: view.project({ x: (p.box.x0 + p.box.x1) / 2, y: p.box.y1, z: p.box.z1 }) });
    }
    // Buildings, far first.
    picks.length = 0;
    const sorted = [...buildings].sort((a, b) => order(b.box) - order(a.box));
    const linked = new Set<number>();
    if (selected) for (const l of linksOf.get(selected.i) ?? []) linked.add(l.other);
    for (const b of sorted) {
      const dim = selected && b !== selected && !linked.has(b.i) ? 0.25 : 1;
      const outline = b === selected ? rgba(col('var(--accent)')) : b === hover ? rgba(col('var(--primary)')) : undefined;
      const topQuad = view.box(b.box, colorOf(b), dim, outline);
      const base = [view.project({ x: b.box.x0, y: b.box.y0, z: b.box.z0 }), view.project({ x: b.box.x1, y: b.box.y0, z: b.box.z1 }), view.project({ x: b.box.x0, y: b.box.y0, z: b.box.z1 }), view.project({ x: b.box.x1, y: b.box.y0, z: b.box.z0 })];
      const all = [...topQuad, ...base];
      picks.push({ b, minX: Math.min(...all.map((p) => p.sx)), maxX: Math.max(...all.map((p) => p.sx)), minY: Math.min(...all.map((p) => p.sy)), maxY: Math.max(...all.map((p) => p.sy)), depth: order(b.box) });
    }
    // Links: the selected building's, or every link between districts.
    const offset = -(now / 40) % 16;
    if (selected) {
      for (const l of linksOf.get(selected.i) ?? []) {
        const other = buildings[l.other]!;
        const a = l.out ? selected : other;
        const b = l.out ? other : selected;
        const lift = 6 + Math.hypot(top(a).x - top(b).x, top(a).z - top(b).z) * 0.25;
        view.stroke(view.arc(top(a), top(b), lift), rgba(col(l.out ? 'var(--primary)' : 'var(--accent)'), 0.9), 1.6, [6, 10], offset);
      }
    } else if (showRepoLinks) {
      for (const e of idx.edges) {
        if (e.kind !== 'import') continue;
        const a = districtOf.get(e.from);
        const b = districtOf.get(e.to);
        if (!a || !b) continue;
        const pa = { x: a.x + a.w / 2, y: 2, z: a.y + a.h / 2 };
        const pb = { x: b.x + b.w / 2, y: 2, z: b.y + b.h / 2 };
        view.stroke(view.arc(pa, pb, 12 + Math.hypot(pa.x - pb.x, pa.z - pb.z) * 0.3), rgba(col('var(--primary)'), 0.55), 1 + Math.log2(1 + e.weight) * 0.6, [6, 10], offset);
      }
    }
    view.animating = !!selected || showRepoLinks;
    // District names, and building names when close.
    for (const { p, at } of plateLabels) view.label(p.label, { ...at, sy: at.sy + 16 }, rgba(text), rgba(bg, 0.9), '700 13px system-ui, sans-serif');
    for (const b of [hover, selected]) {
      if (!b) continue;
      const at = view.project(top(b));
      view.label(b.path, { ...at, sy: at.sy - 8 }, rgba(text), rgba(bg, 0.9), '600 12px system-ui, sans-serif');
    }
    if (view.cam.dist < 120) {
      for (const pk of picks) {
        const w = pk.maxX - pk.minX;
        if (w < 46 || pk.b === hover || pk.b === selected) continue;
        const at = view.project(top(pk.b));
        view.label(pk.b.path.split('/').pop()!, { ...at, sy: at.sy - 4 }, rgba(text, 0.85), rgba(bg, 0.8), '11px system-ui, sans-serif');
      }
    }
  };

  const pick = (x: number, y: number): Building | null => {
    let best: Pick | null = null;
    for (const p of picks) if (x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && (!best || p.depth < best.depth)) best = p;
    return best?.b ?? null;
  };
  view.onHover = (x, y) => {
    const b = pick(x, y);
    if (b !== hover) {
      hover = b;
      view.canvas.style.cursor = b ? 'pointer' : 'grab';
      view.redraw();
    }
  };
  const card = h('div', { class: 'city-card', hidden: true });
  const select = (b: Building | null): void => {
    selected = b;
    if (!b) {
      card.hidden = true;
    } else {
      const links = linksOf.get(b.i) ?? [];
      card.hidden = false;
      card.replaceChildren(
        h('strong', null, b.path), h('div', { class: 'muted' }, b.repo),
        h('p', null, `${b.loc.toLocaleString()} lines · ${b.exported} exports · imported by ${b.dependents} file${b.dependents === 1 ? '' : 's'}`),
        h('p', { class: 'muted' }, `${b.commits} commits, ${b.churnLines.toLocaleString()} lines changed${b.hotspot ? ` · hot spot ${b.hotspot}` : ''}${b.tested === 0 ? ' · no test reaches it' : ''}`),
        h('p', { class: 'legend-line' }, h('span', { class: 'key out' }), `imports ${links.filter((l) => l.out).length}  `, h('span', { class: 'key in' }), `imported by ${links.filter((l) => !l.out).length}`),
        h('div', { class: 'actions' },
          h('a', { class: 'button primary', href: `#/e/${encodeURIComponent(b.id)}` }, 'Explore'),
          h('a', { class: 'button', href: `#/impact/${encodeURIComponent(b.id)}` }, 'What breaks?'),
          h('a', { class: 'button', href: `#/n/${encodeURIComponent(b.id)}` }, 'Details')),
      );
    }
    view.redraw();
  };
  view.onClick = (x, y) => {
    const b = pick(x, y);
    if (b) return select(b === selected ? null : b);
    // A district's name: fly there.
    for (const { p, at } of plateLabels) {
      if (Math.abs(x - at.sx) < 60 && Math.abs(y - (at.sy + 12)) < 12) {
        const d = districtOf.get(p.repo)!;
        view.flyTo({ x: d.x + d.w / 2, y: 0, z: d.y + d.h / 2 }, Math.max(40, Math.max(d.w, d.h) * 1.6));
        return;
      }
    }
    select(null);
  };

  const home = (): void => view.flyTo({ x: 0, y: 0, z: 0 }, WORLD * 2.1, 800, -0.7, 0.62);
  view.cam = { target: { x: 0, y: 0, z: 0 }, yaw: -0.7, pitch: 0.62, dist: WORLD * 2.1 };
  // Fly in from above on arrival.
  view.cam.dist = WORLD * 3.4;
  view.cam.pitch = 1.35;
  home();

  const modeButtons = MODES.map(([m, label, about]) => {
    const b = h('button', { type: 'button', class: `seg${m === mode ? ' on' : ''}`, title: about, 'aria-pressed': m === mode ? 'true' : 'false', onclick: () => {
      mode = m;
      for (const x of modeButtons) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      }
      legend.textContent = about;
      history.replaceState(null, '', `#/city?color=${m}${showRepoLinks ? '&links=repos' : ''}`);
      view.redraw();
    } }, label);
    return b;
  });
  const legend = h('span', { class: 'muted' }, MODES.find((m) => m[0] === mode)![2]);
  const linksToggle = h('input', { type: 'checkbox', checked: showRepoLinks, onchange: () => {
    showRepoLinks = linksToggle.checked;
    history.replaceState(null, '', `#/city?color=${mode}${showRepoLinks ? '&links=repos' : ''}`);
    view.redraw();
  } });
  const bar = h('div', { class: 'view-bar' },
    h('h1', null, 'City'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Colour by' }, modeButtons),
    h('label', { class: 'toggle' }, linksToggle, ' Imports between repositories'),
    h('button', { type: 'button', class: 'icon-button', onclick: home }, 'Reset view'),
    legend,
  );
  const help = h('p', { class: 'view-help muted' }, 'Drag to turn · shift-drag to pan · scroll or pinch to zoom · click a building for its imports · click a district name to fly there');
  return h('div', { class: 'view-page' }, bar, h('div', { class: 'view-body' }, stage, card), help);
}
