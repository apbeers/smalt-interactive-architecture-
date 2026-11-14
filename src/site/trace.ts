// Traces: a path through the code, played as a pulse that walks it step by step across repositories and folders.
// Named traces come from intent files; any other path is found here, from one node to another, through calls between
// declarations and imports between files.
import type { IndexData, Trace } from '../model.js';
import { loadAllRepos } from './data.js';
import { h, s } from './dom.js';
import { layerColor } from './levels.js';

const LANE = 230;
const STEP = 86;

/** The shortest path from `from` to `to`: through declarations' calls when both are declarations, else through files' imports. */
async function findPath(idx: IndexData, from: string, to: string): Promise<string[] | null> {
  const repos = await loadAllRepos(idx);
  const calls = new Map<string, string[]>();
  const imports = new Map<string, string[]>();
  for (const r of repos) {
    for (const sym of r.symbols) if (sym.calls) calls.set(sym.id, sym.calls);
    for (const e of r.edges) if (e.kind !== 'type-import') (imports.get(e.from) ?? imports.set(e.from, []).get(e.from)!).push(e.to);
  }
  const bfs = (start: string, goal: string, next: (n: string) => string[]): string[] | null => {
    const prev = new Map<string, string>([[start, '']]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift()!;
      if (n === goal) {
        const path = [n];
        for (let p = prev.get(n)!; p; p = prev.get(p)!) path.unshift(p);
        return path;
      }
      for (const m of next(n)) if (!prev.has(m)) {
        prev.set(m, n);
        queue.push(m);
      }
    }
    return null;
  };
  if (from.includes('#') && to.includes('#')) {
    const p = bfs(from, to, (n) => calls.get(n) ?? []);
    if (p) return p;
  }
  const fileOf = (id: string): string => id.split('#')[0]!;
  const p = bfs(fileOf(from), fileOf(to), (n) => imports.get(n) ?? []);
  if (!p) return null;
  if (from.includes('#')) p[0] = from;
  if (to.includes('#') && p.length > 1) p[p.length - 1] = to;
  return p;
}

export async function traceView(idx: IndexData, params: URLSearchParams): Promise<HTMLElement> {
  const traces: Trace[] = idx.traces ?? [];
  const from = params.get('from');
  const to = params.get('to');
  let trace: Trace | undefined = traces.find((t) => t.name === params.get('name'));
  let notice = '';
  if (!trace && from && to) {
    const path = await findPath(idx, from, to);
    if (path) trace = { name: `${from.split('/').pop()} → ${to.split('/').pop()}`, about: 'The shortest path found: calls between declarations where it can, imports between files where not.', steps: path.map((node) => ({ node })) };
    else notice = `No path from ${from} to ${to} through calls or imports. Paths run the way imports point: try the other direction.`;
  }
  trace ??= traces[0];

  const picker = h('div', { class: 'trace-picker' },
    traces.length ? h('label', null, 'Trace ', h('select', { onchange: (e: Event) => (location.hash = `#/trace?name=${encodeURIComponent((e.target as HTMLSelectElement).value)}`) },
      traces.map((t) => h('option', { value: t.name, selected: t.name === trace?.name }, `${t.name} (${t.repo})`)))) : null,
    h('form', { class: 'trace-form', onsubmit: (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const a = (f.elements.namedItem('from') as HTMLInputElement).value.trim();
      const b = (f.elements.namedItem('to') as HTMLInputElement).value.trim();
      if (a && b) location.hash = `#/trace?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}`;
    } },
      h('input', { name: 'from', placeholder: 'From: a file or declaration id', value: from ?? '', 'aria-label': 'From' }),
      h('input', { name: 'to', placeholder: 'To', value: to ?? '', 'aria-label': 'To' }),
      h('button', { class: 'button', type: 'submit' }, 'Find a path')),
  );
  const head = h('div', { class: 'view-bar' }, h('h1', null, 'Trace'), picker);
  if (!trace) return h('div', { class: 'view-page scroll' }, head, h('div', { class: 'page' }, h('p', null, notice || 'No traces yet. Find a path between two nodes, or start one from the explorer\'s panel ("Trace from here").')));

  // Lanes: a repository and its top folders, in the order the path reaches them.
  const groupOf = (id: string): string => {
    const [repo, ...rest] = id.split('#')[0]!.split('/');
    return [repo, ...rest.slice(0, Math.min(2, rest.length - 1))].join('/');
  };
  const lanes: string[] = [];
  for (const st of trace.steps) if (!lanes.includes(groupOf(st.node))) lanes.push(groupOf(st.node));
  const W = Math.max(600, lanes.length * LANE + 40);
  const H = trace.steps.length * STEP + 80;
  const svg = s('svg', { class: 'trace-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Trace: ${trace.name}` }) as SVGSVGElement;
  lanes.forEach((lane, i) => {
    const repo = idx.repos.find((r) => r.name === lane.split('/')[0]);
    svg.append(s('rect', { x: 20 + i * LANE, y: 10, width: LANE - 16, height: H - 20, rx: 10, class: 'trace-lane', style: `stroke:${layerColor(idx, repo?.layer ?? '')}` }),
      s('text', { x: 20 + i * LANE + (LANE - 16) / 2, y: 34, 'text-anchor': 'middle', class: 'trace-lane-label' }, lane));
  });
  const centres = trace.steps.map((st, k) => ({ x: 20 + lanes.indexOf(groupOf(st.node)) * LANE + (LANE - 16) / 2, y: 70 + k * STEP }));
  const path = s('path', { class: 'trace-path', d: centres.map((c, k) => `${k ? 'L' : 'M'}${c.x},${c.y}`).join(' ') });
  svg.append(path);
  const stepEls = trace.steps.map((st, k) => {
    const c = centres[k]!;
    const label = st.node.includes('#') ? st.node.split('#')[1]! : st.node.split('/').pop()!;
    const g = s('a', { href: `#/e/${encodeURIComponent(st.node)}`, class: 'trace-step' },
      s('rect', { x: c.x - 95, y: c.y - 22, width: 190, height: 44, rx: 8 }),
      s('text', { x: c.x, y: c.y - 3, 'text-anchor': 'middle', class: 'trace-step-label' }, `${k + 1}. ${label}`),
      s('text', { x: c.x, y: c.y + 13, 'text-anchor': 'middle', class: 'trace-step-sub' }, st.node.includes('#') ? st.node.split('#')[0]!.split('/').pop()! : st.node.split('/').slice(1, -1).join('/') || st.node.split('/')[0]!),
      s('title', null, `${st.node}${st.note ? `\n${st.note}` : ''}`));
    svg.append(g);
    return g;
  });
  const pulse = s('circle', { r: 9, class: 'trace-pulse' });
  svg.append(pulse);

  const notes = h('ol', { class: 'trace-notes' }, trace.steps.map((st, k) => h('li', { 'data-k': k },
    h('a', { href: `#/e/${encodeURIComponent(st.node)}` }, st.node), st.note ? h('div', { class: 'muted' }, st.note) : null)));
  let raf = 0;
  const setActive = (k: number): void => {
    stepEls.forEach((g, i) => {
      g.classList.toggle('active', i === k);
      g.classList.toggle('done', i < k);
    });
    notes.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === k));
  };
  const play = (): void => {
    cancelAnimationFrame(raf);
    const total = (path as SVGPathElement).getTotalLength();
    const lengths = centres.map((_, k) => {
      const sub = s('path', { d: centres.slice(0, k + 1).map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join(' ') }) as SVGPathElement;
      svg.append(sub);
      const len = k ? sub.getTotalLength() : 0;
      sub.remove();
      return len;
    });
    const per = 1100;
    const start = performance.now();
    const frame = (now: number): void => {
      const el = now - start;
      const k = Math.min(trace!.steps.length - 1, Math.floor(el / per));
      // Rest on a step for the first 40% of its time, then travel to the next.
      const frac = (el % per) / per;
      const a = lengths[k]!;
      const b = lengths[Math.min(k + 1, lengths.length - 1)]!;
      const move = k >= trace!.steps.length - 1 ? 0 : Math.max(0, (frac - 0.4) / 0.6);
      const at = (path as SVGPathElement).getPointAtLength(Math.min(total, a + (b - a) * move));
      pulse.setAttribute('cx', String(at.x));
      pulse.setAttribute('cy', String(at.y));
      setActive(k);
      if (el < per * trace!.steps.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  requestAnimationFrame(play);
  head.append(h('button', { type: 'button', class: 'button primary', onclick: play }, 'Replay'));
  return h('div', { class: 'view-page scroll' },
    head,
    notice ? h('p', { class: 'page muted' }, notice) : null,
    h('div', { class: 'view-body' }, h('div', { class: 'trace-stage' }, svg), h('div', { class: 'city-card' }, h('strong', null, trace.name), trace.about ? h('p', { class: 'muted' }, trace.about) : null, notes)),
  );
}
