// The time-lapse: the platform growing day by day. Repositories appear, fill up as their code grows, links come and
// go (new ones glow), and issue counts rise and fall. Play it, or drag through the days.
import type { IndexData } from '../model.js';
import type { Timeline } from '../timeline.js';
import { loadJson } from './data.js';
import { h, plural, s } from './dom.js';
import { layoutGraph } from './graphview.js';
import { edgePath } from './layout.js';
import { platformLevel } from './levels.js';

const KINDS = new Set(['import', 'npm', 'pin', 'runtime', 'worker']);
const STEP_MS = 1300;

export async function timelineView(idx: IndexData, params: URLSearchParams): Promise<HTMLElement> {
  let timeline: Timeline;
  try {
    timeline = await loadJson<Timeline>('data/timeline.json');
  } catch {
    return h('div', { class: 'page' }, h('h1', null, 'Time-lapse'), h('p', null, 'No history in this build.'));
  }
  const frames = timeline.frames;
  const level = platformLevel(idx, KINDS);
  const { layout, bounds } = layoutGraph(level.nodes, level.edges, level.options);
  const maxLoc = Math.max(1, ...frames.flatMap((f) => Object.values(f.repos).map((r) => r.loc)));
  const svg = s('svg', { class: 'tl-svg', viewBox: `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`, role: 'img', 'aria-label': 'The platform at the chosen day' }) as SVGSVGElement;
  const edgeLayer = s('g');
  const nodeLayer = s('g');
  svg.append(edgeLayer, nodeLayer);

  // Every link seen on any day, drawn once and shown or hidden per day.
  const edgeEls = new Map<string, SVGElement>();
  for (const f of frames) {
    for (const [from, to, kind] of f.edges) {
      const key = `${from}|${to}|${kind}`;
      if (!KINDS.has(kind) || edgeEls.has(key)) continue;
      const a = layout.nodes.get(from);
      const b = layout.nodes.get(to);
      if (!a || !b) continue;
      const el = s('path', { d: edgePath(a, b), class: `edge edge-${kind} tl-edge` });
      edgeEls.set(key, el);
      edgeLayer.append(el);
    }
  }
  const nodeEls = new Map<string, { g: SVGElement; fill: SVGElement; sub: SVGElement; badge: SVGElement; badgeText: SVGElement; w: number }>();
  for (const n of level.nodes) {
    const p = layout.nodes.get(n.id)!;
    const fill = s('rect', { x: 0, y: p.height - 6, width: 0, height: 6, rx: 3, class: 'tl-fill', style: `fill:${n.color}` });
    const sub = s('text', { x: 14, y: 36, class: 'node-sub' }, '');
    const badgeText = s('text', { x: 0, y: 4, 'text-anchor': 'middle' }, '');
    const badge = s('g', { class: 'badge badge-warning', transform: `translate(${p.width - 12},-6)` }, s('rect', { x: -12, y: -8, width: 24, height: 16, rx: 8 }), badgeText);
    const g = s('a', { href: `#/e/${encodeURIComponent(n.id)}`, class: 'node tl-node', transform: `translate(${p.x},${p.y})` },
      s('rect', { width: p.width, height: p.height, rx: 7, class: 'node-box' }),
      s('rect', { width: 5, height: p.height, rx: 2, class: 'node-bar', style: `fill:${n.color}` }),
      s('text', { x: 14, y: 19, class: 'node-label' }, n.label), sub, fill, badge);
    nodeLayer.append(g);
    nodeEls.set(n.id, { g, fill, sub, badge, badgeText, w: p.width });
  }

  // Charts: total lines and warnings per day.
  const CW = 1000;
  const CH = 120;
  const totals = frames.map((f) => ({ loc: Object.values(f.repos).reduce((n, r) => n + r.loc, 0), warnings: Object.values(f.repos).reduce((n, r) => n + r.issues[0] + r.issues[1], 0), repos: Object.keys(f.repos).length }));
  const maxTotal = Math.max(1, ...totals.map((t) => t.loc));
  const maxWarn = Math.max(1, ...totals.map((t) => t.warnings));
  const cx = (i: number): number => 40 + (i / Math.max(1, frames.length - 1)) * (CW - 60);
  const chart = s('svg', { class: 'tl-chart', viewBox: `0 0 ${CW} ${CH + 30}`, role: 'img', 'aria-label': 'Lines of code and warnings over time' });
  const line = (vals: number[], max: number, cls: string): SVGElement => s('path', { class: cls, d: vals.map((v, i) => `${i ? 'L' : 'M'}${cx(i)},${CH - (v / max) * (CH - 10)}`).join(' ') });
  chart.append(
    s('path', { class: 'tl-area', d: `M${cx(0)},${CH} ${totals.map((t, i) => `L${cx(i)},${CH - (t.loc / maxTotal) * (CH - 10)}`).join(' ')} L${cx(frames.length - 1)},${CH} Z` }),
    line(totals.map((t) => t.loc), maxTotal, 'tl-line'),
    line(totals.map((t) => t.warnings), maxWarn, 'tl-line warn'),
    s('text', { x: 40, y: CH + 20, class: 'tl-axis' }, frames[0]!.date.slice(0, 10)),
    s('text', { x: CW - 20, y: CH + 20, class: 'tl-axis', 'text-anchor': 'end' }, frames[frames.length - 1]!.date.slice(0, 10)),
    s('text', { x: 44, y: 14, class: 'tl-axis' }, `lines of code (to ${maxTotal.toLocaleString()})`),
    s('text', { x: 44, y: 28, class: 'tl-axis warn' }, `errors and warnings (to ${maxWarn})`),
  );
  const cursor = s('line', { y1: 0, y2: CH, class: 'tl-cursor' });
  chart.append(cursor);

  const dateLabel = h('div', { class: 'tl-date' });
  const happened = h('div', { class: 'city-card tl-card' });
  const slider = h('input', { type: 'range', min: 0, max: frames.length - 1, step: 0.01, value: 0, 'aria-label': 'Day' });
  let t = Number(params.get('day') ?? frames.length - 1);
  let playing = false;
  let last = 0;
  let raf = 0;

  const show = (pos: number): void => {
    const i = Math.min(frames.length - 1, Math.floor(pos));
    const k = pos - i;
    const a = frames[i]!;
    const b = frames[Math.min(frames.length - 1, i + 1)]!;
    const prev = i > 0 ? frames[i - 1] : undefined;
    for (const [id, el] of nodeEls) {
      const ra = a.repos[id];
      const rb = b.repos[id];
      const loc = (ra?.loc ?? 0) * (1 - k) + (rb?.loc ?? ra?.loc ?? 0) * k;
      const present = !!ra || (k > 0.5 && !!rb);
      el.g.classList.toggle('absent', !present);
      el.g.classList.toggle('born', !!ra && !!prev && !prev.repos[id]);
      el.fill.setAttribute('width', String(Math.max(0, (el.w - 10) * Math.sqrt(loc / maxLoc))));
      el.fill.setAttribute('x', '5');
      el.sub.textContent = ra ? `${Math.round(loc).toLocaleString()} lines, ${ra.files} files` : '';
      const warn = ra ? ra.issues[0] + ra.issues[1] : 0;
      el.badge.style.display = warn ? '' : 'none';
      el.badgeText.textContent = String(warn);
    }
    const now = new Set(a.edges.filter((e) => KINDS.has(e[2])).map((e) => `${e[0]}|${e[1]}|${e[2]}`));
    const before = new Set((prev?.edges ?? []).filter((e) => KINDS.has(e[2])).map((e) => `${e[0]}|${e[1]}|${e[2]}`));
    for (const [key, el] of edgeEls) {
      el.classList.toggle('absent', !now.has(key));
      el.classList.toggle('born', now.has(key) && !!prev && !before.has(key));
    }
    const x = cx(pos);
    cursor.setAttribute('x1', String(x));
    cursor.setAttribute('x2', String(x));
    slider.value = String(pos);
    dateLabel.textContent = a.date.length > 10 ? `${a.date.slice(0, 10)} (now)` : a.date;
    // What happened that day.
    const born = Object.keys(a.repos).filter((r) => prev && !prev.repos[r]);
    const grew = Object.entries(a.repos).map(([r, v]) => [r, v.loc - (prev?.repos[r]?.loc ?? 0)] as const).filter(([, d]) => d !== 0).sort((p, q) => Math.abs(q[1]) - Math.abs(p[1])).slice(0, 6);
    const newLinks = [...now].filter((e) => prev && !before.has(e));
    const goneLinks = [...before].filter((e) => !now.has(e));
    happened.replaceChildren(...[
      h('strong', null, a.date.slice(0, 10)),
      h('p', { class: 'muted' }, `${plural(Object.keys(a.repos).length, 'repository', 'repositories')} · ${totals[i]!.loc.toLocaleString()} lines · ${totals[i]!.warnings} errors and warnings`),
      born.length ? h('p', null, h('strong', null, 'New: '), born.join(', ')) : null,
      grew.length ? h('div', null, h('h3', null, 'Change in lines'), h('ul', { class: 'plain' }, grew.map(([r, d]) => h('li', null, `${r} `, h('span', { class: d > 0 ? 'added' : 'removed' }, `${d > 0 ? '+' : ''}${d.toLocaleString()}`))))) : null,
      newLinks.length ? h('div', null, h('h3', null, 'New links'), h('ul', { class: 'plain' }, newLinks.slice(0, 8).map((e) => h('li', { class: 'added' }, e.split('|').slice(0, 2).join(' → '), ` (${e.split('|')[2]})`)))) : null,
      goneLinks.length ? h('div', null, h('h3', null, 'Links gone'), h('ul', { class: 'plain' }, goneLinks.slice(0, 8).map((e) => h('li', { class: 'removed' }, e.split('|').slice(0, 2).join(' → '))))) : null,
    ].filter((x): x is HTMLElement => !!x));
  };
  const stop = (): void => {
    playing = false;
    playButton.textContent = 'Play';
    cancelAnimationFrame(raf);
  };
  const tick = (now: number): void => {
    if (!playing) return;
    t += (now - last) / STEP_MS;
    last = now;
    if (t >= frames.length - 1) {
      t = frames.length - 1;
      show(t);
      return stop();
    }
    show(t);
    raf = requestAnimationFrame(tick);
  };
  const playButton = h('button', { type: 'button', class: 'button primary', onclick: () => {
    if (playing) return stop();
    if (t >= frames.length - 1) t = 0;
    playing = true;
    playButton.textContent = 'Pause';
    last = performance.now();
    raf = requestAnimationFrame(tick);
  } }, 'Play');
  slider.addEventListener('input', () => {
    stop();
    t = Number(slider.value);
    show(t);
  });
  show(t);
  if (params.get('play') === '1') requestAnimationFrame(() => playButton.click());

  return h('div', { class: 'view-page scroll' },
    h('div', { class: 'view-bar' }, h('h1', null, 'Time-lapse'), playButton, slider, dateLabel,
      h('span', { class: 'muted' }, `${plural(frames.length, 'day')} of history, one frame per day`)),
    h('div', { class: 'view-body' }, h('div', { class: 'tl-stage' }, svg), happened),
    h('div', { class: 'tl-charts' }, chart),
    h('p', { class: 'view-help muted' }, 'The bar under each repository grows with its code; new repositories and links glow on the day they appear. Each day is analysed from the repositories\' history by the same analyzer as today\'s map.'),
  );
}
