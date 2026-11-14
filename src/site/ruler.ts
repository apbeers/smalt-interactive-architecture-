// A timeline ruler: day ticks and dates, curves of what changed drawn inside it, markers for events, and a playhead
// you drag (or click, or move with the arrow keys). It reports fractional positions while you scrub, so whatever it
// drives can blend between days, and settles on a day when you let go.
import { s } from './dom.js';

export interface RulerSeries {
  readonly values: number[];
  readonly label: string;
  readonly cls: string;
  /** Fill the area under the curve. */
  readonly area?: boolean;
}

export interface RulerOptions {
  /** One label per position (an ISO date). */
  readonly labels: string[];
  readonly series: RulerSeries[];
  readonly markers: { at: number; label: string }[];
  /** Called with a fractional position while scrubbing, and a whole one when it settles. */
  readonly onChange: (pos: number) => void;
  /** Called when the user takes hold of the playhead (to pause playback). */
  readonly onGrab?: () => void;
}

export interface Ruler {
  readonly el: SVGSVGElement;
  /** Moves the playhead without reporting back. */
  set(pos: number): void;
}

const H = 150;
const L = 24;
const R = 24;
const CHART_TOP = 26;
const CHART_BOTTOM = 92;

const dayLabel = (iso: string): string => {
  const d = new Date(iso.length > 10 ? iso : `${iso}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export function ruler(options: RulerOptions): Ruler {
  const n = options.labels.length;
  const last = Math.max(1, n - 1);
  // Drawn at the element's real width (redrawn when it changes), so text and ticks keep their size.
  let W = 1000;
  const x = (pos: number): number => L + (pos / last) * (W - L - R);
  const posAt = (px: number): number => Math.min(last, Math.max(0, ((px - L) / (W - L - R)) * last));
  const svg = s('svg', {
    class: 'ruler', role: 'slider', tabindex: 0, 'aria-label': 'Day',
    'aria-valuemin': 0, 'aria-valuemax': last,
  }) as SVGSVGElement;
  const ghost = s('g', { class: 'ruler-ghost' }, s('line', { y1: CHART_TOP - 6, y2: CHART_BOTTOM + 14 }), s('text', { y: CHART_TOP - 10, 'text-anchor': 'middle' }, ''));
  const head = s('g', { class: 'ruler-head' },
    s('rect', { x: -14, y: CHART_TOP - 6, width: 28, height: H - CHART_TOP, class: 'ruler-hit' }),
    s('line', { y1: CHART_TOP - 6, y2: CHART_BOTTOM + 16 }),
    s('path', { d: `M-9,${CHART_BOTTOM + 16} L9,${CHART_BOTTOM + 16} L0,${CHART_BOTTOM + 4} Z`, class: 'ruler-knob' }),
    s('circle', { cy: CHART_TOP - 6, r: 5, class: 'ruler-knob' }));
  const draw = (): void => {
    W = Math.max(320, Math.round(svg.getBoundingClientRect().width) || 1000);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    // Curves of what changed, each scaled to its own maximum.
    for (const series of options.series) {
      const max = Math.max(1, ...series.values);
      const y = (v: number): number => CHART_BOTTOM - (v / max) * (CHART_BOTTOM - CHART_TOP);
      const d = series.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
      if (series.area) svg.append(s('path', { class: `ruler-area ${series.cls}`, d: `${d} L${x(series.values.length - 1)},${CHART_BOTTOM} L${x(0)},${CHART_BOTTOM} Z` }));
      svg.append(s('path', { class: `ruler-line ${series.cls}`, d }));
    }
    // The scale: a tick every day, quarter-day minor ticks, and dates where they fit.
    const scale = s('g', { class: 'ruler-scale' });
    scale.append(s('line', { x1: L, x2: W - R, y1: CHART_BOTTOM, y2: CHART_BOTTOM, class: 'ruler-base' }));
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 70))));
    for (let i = 0; i < n; i++) {
      scale.append(s('line', { x1: x(i), x2: x(i), y1: CHART_BOTTOM, y2: CHART_BOTTOM + 14, class: 'ruler-tick' }));
      if (i < n - 1) for (let q = 1; q < 4; q++) scale.append(s('line', { x1: x(i + q / 4), x2: x(i + q / 4), y1: CHART_BOTTOM, y2: CHART_BOTTOM + 6, class: 'ruler-tick minor' }));
      // A date every few days, and the last; none too close to the last.
      if ((i % every === 0 && n - 1 - i >= every * 0.75) || i === n - 1) {
        scale.append(s('text', { x: x(i), y: CHART_BOTTOM + 30, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'ruler-date' }, i === n - 1 && options.labels[i]!.length > 10 ? 'Now' : dayLabel(options.labels[i]!)));
      }
    }
    svg.append(scale);
    // Events: a dot on the scale, a short label above it.
    for (const m of options.markers) {
      svg.append(s('g', { class: 'ruler-marker', transform: `translate(${x(m.at)},${CHART_BOTTOM})` },
        s('circle', { r: 4 }), s('title', null, m.label)));
    }
    // Legend.
    // Legends: the first at the left, the second at the right.
    options.series.forEach((series, i) => svg.append(s('text', { x: i ? W - R : L, y: 14, 'text-anchor': i ? 'end' : 'start', class: `ruler-legend ${series.cls}` }, series.label)));

    // Hover ghost and the playhead, over everything.
    svg.append(ghost, head);
    place(pos);
  };

  let pos = 0;
  const place = (p: number): void => {
    pos = p;
    head.setAttribute('transform', `translate(${x(p)},0)`);
    const i = Math.round(p);
    svg.setAttribute('aria-valuenow', String(i));
    svg.setAttribute('aria-valuetext', options.labels[i]!.length > 10 ? `${dayLabel(options.labels[i]!)}, now` : dayLabel(options.labels[i]!));
  };
  const report = (p: number): void => {
    place(p);
    options.onChange(p);
  };
  /** Glides to the nearest day after a drag. */
  const settle = (): void => {
    const from = pos;
    const to = Math.round(pos);
    if (from === to) return report(to);
    const start = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / 180);
      report(from + (to - from) * k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const toPos = (ev: PointerEvent): number => {
    const r = svg.getBoundingClientRect();
    return posAt(ev.clientX - r.left);
  };

  let dragging = false;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('dragging');
    svg.focus({ preventScroll: true });
    options.onGrab?.();
    report(toPos(ev));
  });
  svg.addEventListener('pointermove', (ev) => {
    const p = toPos(ev);
    if (dragging) return report(p);
    // Ghost: where a click would go.
    ghost.setAttribute('transform', `translate(${x(p)},0)`);
    ghost.querySelector('text')!.textContent = dayLabel(options.labels[Math.round(p)]!);
    ghost.classList.add('on');
  });
  svg.addEventListener('pointerleave', () => ghost.classList.remove('on'));
  const release = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    svg.classList.remove('dragging');
    if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
    settle();
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.25 : 1;
    let next: number | undefined;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = Math.max(0, (Number.isInteger(pos) || ev.shiftKey ? pos : Math.ceil(pos)) - step);
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = Math.min(last, (Number.isInteger(pos) || ev.shiftKey ? pos : Math.floor(pos)) + step);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = last;
    if (next === undefined) return;
    ev.preventDefault();
    options.onGrab?.();
    report(next);
  });
  new ResizeObserver(() => draw()).observe(svg);
  draw();
  return { el: svg, set: place };
}
