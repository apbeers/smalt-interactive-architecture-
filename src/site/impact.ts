// What breaks: pick anything and a ripple spreads through everything that depends on it, one ring per hop, with a
// count at each ring. The reverse of the import graph, across every repository.
import type { FileNode, IndexData } from '../model.js';
import { loadAllRepos } from './data.js';
import { h, plural, s } from './dom.js';
import { layerColor } from './levels.js';

const RING = 120;

export async function impactView(idx: IndexData, id: string, params: URLSearchParams): Promise<HTMLElement> {
  const sourceOnly = params.get('src') === '1';
  const repos = await loadAllRepos(idx);
  const files = new Map<string, FileNode>();
  for (const r of repos) for (const f of r.files) files.set(f.id, f);
  const reverse = new Map<string, Set<string>>();
  for (const r of repos) {
    for (const e of r.edges) {
      if (e.kind === 'type-import' || !files.has(e.to)) continue;
      (reverse.get(e.to) ?? reverse.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
  }

  // The centre: the files that stand for the node, and the first ring when the node is a declaration.
  let centre: string[] = [];
  let firstRing: string[] | null = null;
  let title = id;
  if (id.includes('#')) {
    const repo = repos.find((r) => r.repo === id.split('/')[0]);
    const sym = repo?.symbols.find((x) => x.id === id);
    centre = sym ? [sym.file] : [];
    firstRing = sym ? sym.usedBy.filter((f) => f !== sym.file) : [];
    title = sym ? `${sym.name} (${sym.symbolKind})` : id;
  } else if (id.startsWith('entry:')) {
    const e = idx.entries.find((x) => x.id === id);
    centre = e?.file ? [e.file] : [];
    title = e?.name ?? id;
  } else if (files.has(id)) centre = [id];
  else if (idx.repos.some((r) => r.id === id)) {
    centre = [...files.values()].filter((f) => f.repo === id).map((f) => f.id);
    title = id;
  } else centre = [...files.values()].filter((f) => f.id.startsWith(id)).map((f) => f.id);

  const isRepo = idx.repos.some((r) => r.id === id);
  const keep = (f: string): boolean => {
    const node = files.get(f);
    if (!node) return false;
    if (sourceOnly && node.role !== 'src') return false;
    return !(isRepo && node.repo === id);
  };
  const seen = new Set(centre);
  const parent = new Map<string, string>();
  const rings: string[][] = [];
  let frontier = centre;
  if (firstRing) {
    const ring = firstRing.filter((f) => keep(f) && !seen.has(f));
    ring.forEach((f) => {
      seen.add(f);
      parent.set(f, centre[0]!);
    });
    rings.push(ring);
    frontier = ring;
  }
  while (frontier.length && rings.length < 12) {
    const ring: string[] = [];
    for (const t of frontier) {
      for (const f of reverse.get(t) ?? []) {
        if (seen.has(f) || !keep(f)) continue;
        seen.add(f);
        parent.set(f, t);
        ring.push(f);
      }
    }
    if (!ring.length) break;
    rings.push(ring);
    frontier = ring;
  }
  const total = rings.reduce((n, r) => n + r.length, 0);
  const repoOf = (f: string): string => f.split('/')[0]!;
  const reposHit = new Map<string, number>();
  for (const r of rings) for (const f of r) reposHit.set(repoOf(f), (reposHit.get(repoOf(f)) ?? 0) + 1);

  // Radial layout: each ring's files around a circle, grouped by repository.
  const pos = new Map<string, { x: number; y: number; ring: number }>();
  rings.forEach((ring, k) => {
    const sorted = [...ring].sort((a, b) => a.localeCompare(b));
    const radius = RING * (k + 1);
    sorted.forEach((f, i) => {
      const a = (i / sorted.length) * Math.PI * 2 - Math.PI / 2 + k * 0.37;
      pos.set(f, { x: Math.cos(a) * radius, y: Math.sin(a) * radius, ring: k });
    });
  });
  const R = RING * (rings.length + 1);
  const colorOf = (f: string): string => layerColor(idx, idx.repos.find((r) => r.name === repoOf(f))?.layer ?? '');
  const svg = s('svg', { class: 'impact-svg', viewBox: `${-R} ${-R} ${R * 2} ${R * 2}`, role: 'img', 'aria-label': `What depends on ${title}` }) as SVGSVGElement;
  const guides = s('g', { class: 'rings' });
  rings.forEach((ring, k) => guides.append(
    s('circle', { r: RING * (k + 1), class: 'ring-guide' }),
    s('text', { x: 6, y: -RING * (k + 1) - 8, class: 'ring-label', style: `font-size:${Math.max(12, R / 45).toFixed(0)}px` }, `${k + 1} hop${k ? 's' : ''}: ${ring.length}`),
  ));
  const wave = s('circle', { r: 0, class: 'wave' });
  const links = s('g', { class: 'impact-links' });
  const dots = s('g', { class: 'impact-dots' });
  const els: { el: SVGElement; link?: SVGElement; r: number }[] = [];
  for (const [f, p] of pos) {
    const par = parent.get(f)!;
    const pp = pos.get(par) ?? { x: 0, y: 0 };
    const link = s('path', { d: `M${pp.x},${pp.y} Q${(pp.x + p.x) * 0.5 * 0.85},${(pp.y + p.y) * 0.5 * 0.85} ${p.x},${p.y}`, class: 'impact-link' });
    const node = files.get(f)!;
    const dot = s('a', { href: `#/e/${encodeURIComponent(f)}`, class: 'impact-dot' },
      s('circle', { cx: p.x, cy: p.y, r: 3 + Math.min(9, Math.sqrt(node.loc) / 5), style: `fill:${colorOf(f)}` }),
      s('title', null, `${f}\n${node.role}, ${node.loc} lines\nvia ${par}`));
    links.append(link);
    dots.append(dot);
    els.push({ el: dot, link, r: RING * (p.ring + 1) });
  }
  const centreDot = s('g', { class: 'impact-centre' }, s('circle', { r: 14 }), s('text', { y: 32 + R / 60, 'text-anchor': 'middle', style: `font-size:${Math.max(14, R / 38).toFixed(0)}px` }, title));
  svg.append(guides, wave, links, dots, centreDot);

  // The ripple: a wave front moves out; files light up as it reaches their ring.
  let raf = 0;
  const play = (): void => {
    cancelAnimationFrame(raf);
    const start = performance.now();
    const speed = RING / 0.55; // a ring every 0.55 s
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frame = (now: number): void => {
      const front = reduce ? R * 2 : ((now - start) / 1000) * speed;
      wave.setAttribute('r', String(Math.min(front, R)));
      wave.style.opacity = String(front > R ? 0 : 0.9 - (front / R) * 0.6);
      for (const e of els) {
        const on = front >= e.r;
        e.el.classList.toggle('on', on);
        e.link?.classList.toggle('on', on);
      }
      if (front <= R) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  requestAnimationFrame(play);

  const srcToggle = h('input', { type: 'checkbox', checked: sourceOnly, onchange: () => (location.hash = `#/impact/${encodeURIComponent(id)}${srcToggle.checked ? '?src=1' : ''}`) });
  const side = h('div', { class: 'city-card impact-card' },
    h('strong', null, total ? `${plural(total, 'file')} in ${plural(reposHit.size, 'repository', 'repositories')} depend on it` : 'Nothing depends on it'),
    h('p', { class: 'muted' }, sourceOnly ? 'Source files only.' : 'Including tests, docs and scripts.'),
    h('ol', { class: 'plain rings-list' }, rings.map((r, k) => h('li', null, h('strong', null, `${k + 1} hop${k ? 's' : ''}: `), plural(r.length, 'file')))),
    h('h3', null, 'By repository'),
    h('ul', { class: 'plain' }, [...reposHit].sort((a, b) => b[1] - a[1]).map(([r, n]) => h('li', null, h('span', { class: 'swatch-dot', style: `background:${colorOf(r + '/')}` }), h('a', { href: `#/e/${encodeURIComponent(r)}` }, r), ` ${n}`))),
  );
  return h('div', { class: 'view-page' },
    h('div', { class: 'view-bar' },
      h('h1', null, 'What breaks?'),
      h('span', null, h('a', { href: `#/e/${encodeURIComponent(id)}` }, title)),
      h('label', { class: 'toggle' }, srcToggle, ' Source files only'),
      h('button', { type: 'button', class: 'icon-button', onclick: play }, 'Replay')),
    h('div', { class: 'view-body' }, h('div', { class: 'impact-stage' }, svg), side),
    h('p', { class: 'view-help muted' }, 'Each ring is one more step of imports away. Hover a dot for the file and what it reaches it through; click to explore it. Type-only imports are left out: they vanish at run time.'),
  );
}
