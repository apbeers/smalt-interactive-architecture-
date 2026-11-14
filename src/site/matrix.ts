// The dependency matrix: everything at one level against everything, rows importing columns. Rows are ordered so
// that what depends comes before what it depends on: links then sit above the diagonal. A cell below it climbs
// against that order, and a pair mirrored across it is a cycle. Holds up where node graphs turn to hairballs.
import type { IndexData } from '../model.js';
import { h, plural, s } from './dom.js';
import { rankNodes } from './layout.js';
import { levelFor, pathOf, PLATFORM, savedKinds } from './levels.js';

const CELL = 18;

export async function matrixView(idx: IndexData, params: URLSearchParams): Promise<HTMLElement> {
  const of = params.get('of') ?? PLATFORM;
  const level = await levelFor(idx, of, savedKinds());
  if (!level) return h('div', { class: 'page' }, h('h1', null, 'Matrix'), h('p', null, 'Nothing to show for ', of, '.'));
  const nodes = level.nodes.filter((n) => !n.muted);
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const edges = level.edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const ranks = rankNodes(ids, edges);
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const order = [...ids].sort((a, b) => ranks.get(a)! - ranks.get(b)! || label.get(a)!.localeCompare(label.get(b)!));
  const at = new Map(order.map((id, i) => [id, i]));
  const cell = new Map<string, { w: number; title: string; kind: string }>();
  for (const e of edges) {
    const key = `${e.from}|${e.to}`;
    const cur = cell.get(key);
    cell.set(key, cur ? { ...cur, w: cur.w + e.weight } : { w: e.weight, title: e.title, kind: e.kind });
  }
  const maxW = Math.max(1, ...[...cell.values()].map((c) => c.w));
  const n = order.length;
  const labelW = Math.min(240, 40 + Math.max(...order.map((id) => label.get(id)!.length)) * 7);
  const W = labelW + n * CELL + 20;
  const Hh = labelW + n * CELL + 20;
  const svg = s('svg', { class: 'matrix-svg', viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Dependency matrix' }) as SVGSVGElement;
  const grid = s('g', { transform: `translate(${labelW},${labelW})` });
  const info = h('div', { class: 'city-card' }, h('strong', null, 'Hover a cell'), h('p', { class: 'muted' }, 'Row imports column. Blue above the diagonal is the normal direction; red below it climbs against the order; outlined pairs are cycles.'));
  let back = 0;
  let cycles = 0;
  // Bands and grid.
  for (let i = 0; i < n; i++) {
    grid.append(s('rect', { x: 0, y: i * CELL, width: n * CELL, height: CELL, class: `band${i % 2 ? ' odd' : ''}`, 'data-row': i }));
  }
  grid.append(s('path', { d: `M0,0 L${n * CELL},${n * CELL}`, class: 'diagonal' }));
  for (const [key, c] of cell) {
    const [from, to] = key.split('|') as [string, string];
    const i = at.get(from)!;
    const j = at.get(to)!;
    const mirrored = cell.has(`${to}|${from}`);
    const below = j < i;
    if (below) back++;
    if (mirrored && i < j) cycles++;
    const strength = 0.25 + 0.75 * (Math.log(1 + c.w) / Math.log(1 + maxW));
    const rect = s('rect', { x: j * CELL + 1, y: i * CELL + 1, width: CELL - 2, height: CELL - 2, rx: 3, class: `cell${below ? ' back' : ''}${mirrored ? ' cycle' : ''}`, style: `opacity:${strength.toFixed(2)}` }, s('title', null, c.title));
    rect.addEventListener('mouseenter', () => {
      svg.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
      svg.querySelector(`[data-row="${i}"]`)?.classList.add('hl');
      svg.querySelector(`[data-col="${j}"]`)?.classList.add('hl');
      info.replaceChildren(h('strong', null, `${label.get(from)} → ${label.get(to)}`), h('p', { class: 'muted' }, `${c.w} import${c.w > 1 ? 's' : ''}${below ? ' · against the order' : ''}${mirrored ? ' · part of a cycle' : ''}`), h('pre', { class: 'sig' }, c.title.split('\n').slice(1).join('\n')));
    });
    grid.append(rect);
  }
  // Labels: rows on the left, columns on top; a folder's label drills into it.
  order.forEach((id, i) => {
    const text = label.get(id)!;
    const zoom = level.zoomable.has(id) && (id.endsWith('/') || level.kind === 'platform');
    const href = zoom ? `#/matrix?of=${encodeURIComponent(id)}` : `#/e/${encodeURIComponent(id)}`;
    svg.append(s('a', { href }, s('text', { x: labelW - 6, y: labelW + i * CELL + CELL * 0.7, 'text-anchor': 'end', class: 'mx-label' }, text)));
    svg.append(s('a', { href }, s('text', { transform: `translate(${labelW + i * CELL + CELL * 0.65},${labelW - 6}) rotate(-60)`, class: 'mx-label', 'data-col': i }, text)));
  });
  svg.append(grid);

  const crumbs = pathOf(idx, of).map((p, i, all) => [i ? ' › ' : '', i === all.length - 1 ? h('strong', null, p || 'Platform') : h('a', { href: `#/matrix?of=${encodeURIComponent(p)}` }, p ? p.replace(/\/$/, '').split('/').pop() + (p.endsWith('/') ? '/' : '') : 'Platform')]);
  return h('div', { class: 'view-page' },
    h('div', { class: 'view-bar' }, h('h1', null, 'Matrix'), h('span', null, crumbs), h('span', { class: 'muted' }, `${plural(n, 'row')} · ${plural(cell.size, 'link')} · ${plural(back, 'climbs', 'climb')} against the order · ${plural(cycles, 'cycle')}`), h('a', { href: `#/e/${encodeURIComponent(of)}` }, 'Explore this level')),
    h('div', { class: 'view-body' }, h('div', { class: 'matrix-stage' }, svg), info),
    h('p', { class: 'view-help muted' }, 'Click a folder\'s name to open its own matrix, or a file\'s to explore it.'),
  );
}
