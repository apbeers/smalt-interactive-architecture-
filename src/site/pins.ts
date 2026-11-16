// Pin drift: one lane per pinned repository, running through time to the head of its main. Each consumer's pin is a
// dot at the date of the commit it is stuck on, with a line to main's head: the longer and redder the line, the
// further behind. On arrival the dots slide back from main to where they really are.
import type { IndexData } from '../model.js';
import { h, plural, s } from './dom.js';
import { layerColor } from './levels.js';

interface Pin {
  readonly consumer: string;
  readonly target: string;
  readonly name: string;
  readonly ref: string;
  readonly date?: string;
  readonly behind?: number;
  readonly onMain?: boolean;
  readonly source: string;
}

const LANE = 64;
const LEFT = 170;
const RIGHT = 90;
const WIDTH = 1200;

export function pinsView(idx: IndexData): HTMLElement {
  const pins: Pin[] = idx.repos.flatMap((r) => r.dependencies.filter((d) => d.ref && d.repo && d.repo !== r.name).map((d) => ({ consumer: r.name, target: d.repo!, name: d.name, ref: d.ref!, date: d.refDate, behind: d.behind, onMain: d.onMain, source: d.source })));
  const targets = [...new Set(pins.map((p) => p.target))].sort((a, b) => pins.filter((p) => p.target === b).length - pins.filter((p) => p.target === a).length);
  const head = (repo: string): string => idx.repos.find((r) => r.name === repo)?.date ?? idx.generatedAt;
  const dates = [...pins.map((p) => p.date).filter((d): d is string => !!d), ...targets.map(head)].map((d) => Date.parse(d));
  const t0 = Math.min(...dates) - 86400000 / 2;
  const t1 = Math.max(...dates, Date.parse(idx.generatedAt)) + 86400000 / 4;
  const x = (iso: string): number => LEFT + ((Date.parse(iso) - t0) / (t1 - t0)) * (WIDTH - LEFT - RIGHT);
  const H = targets.length * LANE + 60;
  const svg = s('svg', { class: 'pins-svg natural', width: WIDTH, height: H, viewBox: `0 0 ${WIDTH} ${H}`, role: 'img', 'aria-label': 'Commit pins against each repository\'s main' }) as SVGSVGElement;

  // Day ticks.
  const axis = s('g', { class: 'pins-axis' });
  for (let t = Math.ceil(t0 / 86400000) * 86400000; t <= t1; t += 86400000) {
    const xx = LEFT + ((t - t0) / (t1 - t0)) * (WIDTH - LEFT - RIGHT);
    const d = new Date(t);
    axis.append(s('line', { x1: xx, x2: xx, y1: 24, y2: H - 10, class: 'tick' }));
    if (d.getUTCDay() === 1 || t === Math.ceil(t0 / 86400000) * 86400000) axis.append(s('text', { x: xx + 3, y: 16 }, d.toISOString().slice(5, 10)));
  }
  svg.append(axis);

  const color = (p: Pin): string => (p.behind === undefined ? 'var(--text-3)' : p.behind === 0 ? 'var(--success)' : p.behind <= 10 ? 'var(--warning)' : 'var(--danger)');
  const dots: { g: SVGElement; dx: number }[] = [];
  targets.forEach((target, k) => {
    const y = 40 + k * LANE + LANE / 2;
    const repo = idx.repos.find((r) => r.name === target);
    const hx = x(head(target));
    const start = repo?.history?.first ? Math.max(LEFT, x(repo.history.first)) : LEFT;
    svg.append(
      s('a', { href: `#/e/${encodeURIComponent(target)}` }, s('text', { x: LEFT - 14, y: y + 4, 'text-anchor': 'end', class: 'lane-label' }, target)),
      s('line', { x1: start, x2: hx, y1: y, y2: y, class: 'lane', style: `stroke:${layerColor(idx, repo?.layer ?? '')}` }),
      s('g', { transform: `translate(${hx},${y})`, class: 'head' }, s('circle', { r: 7 }), s('text', { x: 11, y: 4 }, 'main')),
    );
    const here = pins.filter((p) => p.target === target).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const stack = new Map<number, number>();
    for (const p of here) {
      const px = p.date ? x(p.date) : LEFT + 6;
      const bucket = Math.round(px / 14);
      const n = stack.get(bucket) ?? 0;
      stack.set(bucket, n + 1);
      const py = y - 10 - n * 13;
      const g = s('g', { class: 'pin', style: `--dx:${(hx - px).toFixed(1)}px` },
        s('path', { d: `M${px},${y} C${(px + hx) / 2},${y - 26} ${(px + hx) / 2},${y - 26} ${hx},${y}`, class: 'drift', style: `stroke:${color(p)}` }),
        s('circle', { cx: px, cy: y, r: 5, style: `fill:${color(p)}` }),
        s('text', { x: px, y: py, 'text-anchor': 'middle', class: 'pin-label' }, p.consumer),
        s('title', null, `${p.consumer} pins ${p.name} at ${p.ref.slice(0, 7)} (${p.source})\n${p.date ? new Date(p.date).toLocaleString() : 'date unknown'}\n${p.behind === undefined ? 'not found in main\'s history' : p.behind === 0 ? 'at main' : `${p.behind} commits behind main`}${p.onMain === false ? '\nnot on main: a branch commit' : ''}`));
      dots.push({ g, dx: hx - px });
      svg.append(g);
    }
  });
  // Slide in from main.
  requestAnimationFrame(() => {
    for (const d of dots) d.g.classList.add('from-head');
    requestAnimationFrame(() => requestAnimationFrame(() => dots.forEach((d) => d.g.classList.remove('from-head'))));
  });

  const behind = pins.filter((p) => (p.behind ?? 0) > 0);
  const table = h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Consumer'), h('th', null, 'Pins'), h('th', null, 'In'), h('th', null, 'Commit'), h('th', null, 'Made'), h('th', { class: 'num' }, 'Behind main'))),
    h('tbody', null, [...pins].sort((a, b) => (b.behind ?? -1) - (a.behind ?? -1)).map((p) => h('tr', null,
      h('td', null, h('a', { href: `#/e/${encodeURIComponent(p.consumer)}` }, p.consumer)), h('td', null, p.target), h('td', null, p.source),
      h('td', null, h('code', null, p.ref.slice(0, 7))), h('td', null, p.date ? p.date.slice(0, 10) : '?'),
      h('td', { class: 'num' }, h('span', { class: `chip sev ${p.behind ? (p.behind > 10 ? 'sev-error' : 'sev-warning') : ''}` }, p.behind === undefined ? '?' : String(p.behind))))))));
  return h('div', { class: 'view-page scroll' },
    h('div', { class: 'view-bar' }, h('h1', null, 'Pin drift'), h('span', { class: 'muted' }, `${plural(pins.length, 'commit pin')}; ${behind.length} behind main, the furthest by ${Math.max(0, ...pins.map((p) => p.behind ?? 0))} commits`)),
    h('div', { class: 'pins-stage' }, svg),
    h('p', { class: 'view-help muted' }, 'Green: at main. Amber: up to 10 commits behind. Red: more. Hover a dot for the commit.'),
    h('div', { class: 'page' }, table),
  );
}
