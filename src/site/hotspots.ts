// Hot spots: every source file placed by how much it has changed (across) and how many files depend on it (up).
// Files high and to the right change often and break much when they do: where bugs tend to come from.
import type { IndexData } from '../model.js';
import { loadJson } from './data.js';
import { h, s } from './dom.js';
import { layerColor } from './levels.js';

interface CityData {
  readonly roles: string[];
  readonly files: [string, number, number, number, number, number, number, number, number, number][];
}

export async function hotspotsView(idx: IndexData): Promise<HTMLElement> {
  const data = await loadJson<CityData>('data/city.json');
  const rows = data.files.filter((f) => data.roles[f[8]] === 'src' && f[5] > 0).map(([id, loc, , tested, worst, lines, commits, dependents, , hot]) => ({ id, loc, tested, worst, lines, commits, dependents, hot }));
  const W = 1000;
  const H = 560;
  const L = 70;
  const B = 50;
  const maxLines = Math.max(...rows.map((r) => r.lines));
  const maxDeps = Math.max(1, ...rows.map((r) => r.dependents));
  const x = (v: number): number => L + (Math.log10(1 + v) / Math.log10(1 + maxLines)) * (W - L - 30);
  const y = (v: number): number => H - B - (Math.log10(1 + v) / Math.log10(1 + maxDeps)) * (H - B - 30);
  const svg = s('svg', { class: 'hot-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Source files by change and by dependents' });
  // The hot zone, and axes with powers of ten.
  svg.append(s('rect', { x: x(maxLines ** 0.6), y: 30, width: W - 30 - x(maxLines ** 0.6), height: y(maxDeps ** 0.45) - 30, class: 'hot-zone' }),
    s('text', { x: W - 36, y: 50, 'text-anchor': 'end', class: 'hot-zone-label' }, 'changes often, much depends on it'));
  for (let p = 1; p <= maxLines; p *= 10) svg.append(s('line', { x1: x(p), x2: x(p), y1: 30, y2: H - B, class: 'tick' }), s('text', { x: x(p), y: H - B + 16, 'text-anchor': 'middle', class: 'tl-axis' }, p.toLocaleString()));
  for (let p = 1; p <= maxDeps; p *= 10) svg.append(s('line', { x1: L, x2: W - 30, y1: y(p), y2: y(p), class: 'tick' }), s('text', { x: L - 8, y: y(p) + 4, 'text-anchor': 'end', class: 'tl-axis' }, String(p)));
  svg.append(s('text', { x: (W + L) / 2, y: H - 12, 'text-anchor': 'middle', class: 'tl-axis' }, 'lines changed over the file\'s history'),
    s('text', { transform: `translate(18,${(H - B) / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'tl-axis' }, 'files that import it'));
  const repoColor = (id: string): string => layerColor(idx, idx.repos.find((r) => r.name === id.split('/')[0])?.layer ?? '');
  const dots = s('g');
  rows.sort((a, b) => b.loc - a.loc).forEach((r, i) => {
    const dot = s('a', { href: `#/e/${encodeURIComponent(r.id)}`, class: 'hot-dot', style: `animation-delay:${Math.min(1.2, i * 0.002)}s` },
      s('circle', { cx: x(r.lines), cy: y(r.dependents), r: 2.5 + Math.sqrt(r.loc) / 6, style: `fill:${repoColor(r.id)}` }),
      s('title', null, `${r.id}\n${r.lines.toLocaleString()} lines changed in ${r.commits} commits\nimported by ${r.dependents} files · ${r.loc} lines${r.tested === 0 ? '\nno test reaches it' : ''}`));
    dots.append(dot);
  });
  svg.append(dots);
  const top = [...rows].sort((a, b) => b.hot - a.hot).slice(0, 25);
  return h('div', { class: 'view-page scroll' },
    h('div', { class: 'view-bar' }, h('h1', null, 'Hot spots'), h('span', { class: 'muted' }, 'Source files by how much they change and how much depends on them. Bubble size is lines of code; colour is the repository\'s layer.'), h('a', { href: '#/city?color=hotspots' }, 'See them in the city')),
    h('div', { class: 'hot-stage' }, svg),
    h('div', { class: 'page' }, h('h2', null, 'Top 25'), h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'File'), h('th', { class: 'num' }, 'Score'), h('th', { class: 'num' }, 'Lines changed'), h('th', { class: 'num' }, 'Commits'), h('th', { class: 'num' }, 'Dependents'), h('th', { class: 'num' }, 'Lines'), h('th', null, ''))),
      h('tbody', null, top.map((r) => h('tr', null,
        h('td', null, h('a', { href: `#/e/${encodeURIComponent(r.id)}` }, r.id)), h('td', { class: 'num' }, String(r.hot)), h('td', { class: 'num' }, r.lines.toLocaleString()),
        h('td', { class: 'num' }, String(r.commits)), h('td', { class: 'num' }, String(r.dependents)), h('td', { class: 'num' }, r.loc.toLocaleString()),
        h('td', null, h('a', { href: `#/impact/${encodeURIComponent(r.id)}` }, 'What breaks?')))))))),
  );
}
