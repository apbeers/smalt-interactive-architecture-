// A small 3D engine on a 2D canvas, for the city and the layer cake: an orbiting camera, perspective projection,
// shaded boxes drawn back to front, arcs and labels, picking, and a camera that can fly to a point. No WebGL and no
// libraries: a few thousand boxes draw in a few milliseconds.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Screen {
  sx: number;
  sy: number;
  /** Distance along the view: larger is farther. */
  depth: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Reads a CSS colour (a token or var()) as numbers, through a hidden element; re-made when the theme changes. */
export function colorReader(host: HTMLElement): (css: string) => Rgb {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.append(probe);
  const cache = new Map<string, Rgb>();
  return (css: string): Rgb => {
    let c = cache.get(css);
    if (!c) {
      probe.style.color = '';
      probe.style.color = css;
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
      const [r, g, b] = (m?.[1] ?? '136,136,136').split(',').map((v) => Number(v.trim()));
      c = { r: r!, g: g!, b: b! };
      cache.set(css, c);
    }
    return c;
  };
}

export const rgba = (c: Rgb, a = 1, k = 1): string => `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, ${a})`;
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

export interface Box {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly y0: number;
  readonly y1: number;
}

interface Camera {
  target: V3;
  yaw: number;
  pitch: number;
  dist: number;
}

const ease = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

export class View3D {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  cam: Camera = { target: { x: 0, y: 0, z: 0 }, yaw: -0.7, pitch: 0.75, dist: 160 };
  W = 0;
  H = 0;
  private focal = 1;
  private frame = 0;
  private flight: { from: Camera; to: Camera; start: number; ms: number } | null = null;
  /** Keep drawing every frame (for moving things: flowing links, pulses). */
  animating = false;
  /** Draws the scene; called once per frame with the time. */
  onDraw: (now: number) => void = () => {};
  onClick: (x: number, y: number) => void = () => {};
  onHover: (x: number, y: number) => void = () => {};

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view3d';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.redraw()).observe(this.canvas);
    this.interact();
  }

  redraw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    this.W = canvas.clientWidth;
    this.H = canvas.clientHeight;
    if (!this.W || !this.H) return;
    if (canvas.width !== Math.round(this.W * dpr) || canvas.height !== Math.round(this.H * dpr)) {
      canvas.width = Math.round(this.W * dpr);
      canvas.height = Math.round(this.H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    this.focal = Math.min(this.W, this.H * 1.4) * 1.1;
    let more = this.animating;
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.ms);
      const e = ease(t);
      const a = this.flight.from;
      const b = this.flight.to;
      this.cam = {
        target: { x: a.target.x + (b.target.x - a.target.x) * e, y: a.target.y + (b.target.y - a.target.y) * e, z: a.target.z + (b.target.z - a.target.z) * e },
        yaw: a.yaw + (b.yaw - a.yaw) * e,
        pitch: a.pitch + (b.pitch - a.pitch) * e,
        dist: a.dist * (b.dist / a.dist) ** e,
      };
      if (t >= 1) this.flight = null;
      else more = true;
    }
    this.onDraw(now);
    if (more) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  /** Glides the camera to look at `target` from `dist` (and, if given, a new angle). */
  flyTo(target: V3, dist: number, ms = 900, yaw = this.cam.yaw, pitch = this.cam.pitch): void {
    this.flight = { from: { ...this.cam, target: { ...this.cam.target } }, to: { target, dist, yaw, pitch }, start: performance.now(), ms };
    this.redraw();
  }

  project(v: V3): Screen {
    const { target, yaw, pitch, dist } = this.cam;
    const x = v.x - target.x;
    const y = v.y - target.y;
    const z = v.z - target.z;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = Math.max(1e-3, dist + z2);
    return { sx: this.W / 2 + (x1 * this.focal) / depth, sy: this.H / 2 - (y2 * this.focal) / depth, depth };
  }

  /** Screen size of one world unit at a point. */
  scaleAt(v: V3): number {
    return this.focal / this.project(v).depth;
  }

  poly(points: Screen[]): void {
    const { ctx } = this;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
    ctx.closePath();
  }

  /** A shaded box: the faces that look at the camera, top lightest. Returns the outline for picking. */
  box(b: Box, color: Rgb, alpha = 1, outline?: string): Screen[] {
    const c = (x: number, y: number, z: number): Screen => this.project({ x, y, z });
    const p = [c(b.x0, b.y0, b.z0), c(b.x1, b.y0, b.z0), c(b.x1, b.y0, b.z1), c(b.x0, b.y0, b.z1), c(b.x0, b.y1, b.z0), c(b.x1, b.y1, b.z0), c(b.x1, b.y1, b.z1), c(b.x0, b.y1, b.z1)];
    const centre = this.project({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 }).depth;
    const faces: [number[], number][] = [[[0, 1, 5, 4], 0.62], [[1, 2, 6, 5], 0.78], [[2, 3, 7, 6], 0.62], [[3, 0, 4, 7], 0.78]];
    const { ctx } = this;
    for (const [idx, shade] of faces) {
      const pts = idx.map((i) => p[i]!);
      const d = pts.reduce((s, q) => s + q.depth, 0) / 4;
      if (d > centre) continue; // faces away
      this.poly(pts);
      ctx.fillStyle = rgba(color, alpha, shade);
      ctx.fill();
    }
    const top = [p[4]!, p[5]!, p[6]!, p[7]!];
    this.poly(top);
    ctx.fillStyle = rgba(color, alpha, 1);
    ctx.fill();
    if (outline) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = outline;
      ctx.stroke();
    }
    return top;
  }

  /** A curve from `a` to `b` that rises `lift` units in the middle. */
  arc(a: V3, b: V3, lift: number, steps = 18): Screen[] {
    const out: Screen[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      out.push(this.project({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + Math.sin(Math.PI * t) * lift, z: a.z + (b.z - a.z) * t }));
    }
    return out;
  }

  stroke(points: Screen[], style: string, width = 1, dash?: number[], offset = 0): void {
    const { ctx } = this;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash ?? []);
    ctx.lineDashOffset = offset;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Text with a halo in the background colour, so it reads over anything. */
  label(text: string, at: Screen, color: string, halo: string, font = '600 12px system-ui, sans-serif', align: CanvasTextAlign = 'center'): void {
    const { ctx } = this;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = halo;
    ctx.strokeText(text, at.sx, at.sy);
    ctx.fillStyle = color;
    ctx.fillText(text, at.sx, at.sy);
  }

  /** Whether a screen point is inside a convex outline. */
  static inside(points: Screen[], x: number, y: number): boolean {
    let sign = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const cross = (b.sx - a.sx) * (y - a.sy) - (b.sy - a.sy) * (x - a.sx);
      if (cross !== 0) {
        if (sign === 0) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) return false;
      }
    }
    return true;
  }

  private interact(): void {
    const c = this.canvas;
    let drag: { x: number; y: number; cam: Camera; pan: boolean; moved: boolean } | null = null;
    const pinch = new Map<number, { x: number; y: number }>();
    let pinchStart: { d: number; dist: number } | null = null;
    c.addEventListener('pointerdown', (ev) => {
      pinch.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch.size === 2) {
        const [a, b] = [...pinch.values()];
        pinchStart = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), dist: this.cam.dist };
        drag = null;
        return;
      }
      drag = { x: ev.clientX, y: ev.clientY, cam: { ...this.cam, target: { ...this.cam.target } }, pan: ev.shiftKey || ev.button === 2, moved: false };
    });
    c.addEventListener('pointermove', (ev) => {
      if (pinch.has(ev.pointerId)) pinch.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinchStart && pinch.size === 2) {
        const [a, b] = [...pinch.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.cam.dist = Math.min(4000, Math.max(8, pinchStart.dist * (pinchStart.d / Math.max(1, d))));
        this.redraw();
        return;
      }
      if (!drag) {
        const r = c.getBoundingClientRect();
        this.onHover(ev.clientX - r.left, ev.clientY - r.top);
        return;
      }
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        c.setPointerCapture(ev.pointerId);
      }
      if (!drag.moved) return;
      this.flight = null;
      if (drag.pan) {
        // Move the target in the ground plane, along the screen's axes.
        const k = drag.cam.dist / this.focal;
        const cy = Math.cos(this.cam.yaw);
        const sy = Math.sin(this.cam.yaw);
        const sp = Math.max(0.2, Math.sin(this.cam.pitch));
        this.cam.target = { x: drag.cam.target.x - (dx * cy - (dy / sp) * sy) * k, y: drag.cam.target.y, z: drag.cam.target.z - (-dx * sy - (dy / sp) * cy) * k };
      } else {
        this.cam.yaw = drag.cam.yaw + dx * 0.006;
        this.cam.pitch = Math.min(1.5, Math.max(0.12, drag.cam.pitch + dy * 0.005));
      }
      this.redraw();
    });
    const end = (ev: PointerEvent): void => {
      pinch.delete(ev.pointerId);
      if (pinch.size < 2) pinchStart = null;
      if (c.hasPointerCapture(ev.pointerId)) c.releasePointerCapture(ev.pointerId);
      const moved = drag?.moved;
      drag = null;
      if (moved || ev.type === 'pointercancel') return;
      const r = c.getBoundingClientRect();
      this.onClick(ev.clientX - r.left, ev.clientY - r.top);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.flight = null;
      this.cam.dist = Math.min(4000, Math.max(8, this.cam.dist * Math.exp(ev.deltaY * 0.0012)));
      this.redraw();
    }, { passive: false });
  }
}

/** Squarified treemap: lays `items` (with weights) into a rectangle, keeping cells close to square. */
export function treemap<T>(items: { item: T; weight: number }[], x: number, y: number, w: number, h: number): { item: T; x: number; y: number; w: number; h: number }[] {
  const out: { item: T; x: number; y: number; w: number; h: number }[] = [];
  const list = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = list.reduce((s, i) => s + i.weight, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rect = { x, y, w, h };
  let row: { item: T; area: number }[] = [];
  const worst = (r: { area: number }[], side: number): number => {
    const sum = r.reduce((s, i) => s + i.area, 0);
    const max = Math.max(...r.map((i) => i.area));
    const min = Math.min(...r.map((i) => i.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const layRow = (): void => {
    const sum = row.reduce((s, i) => s + i.area, 0);
    if (rect.w >= rect.h) {
      const colW = sum / rect.h;
      let cy = rect.y;
      for (const r of row) {
        const ch = r.area / colW;
        out.push({ item: r.item, x: rect.x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      const rowH = sum / rect.w;
      let cx = rect.x;
      for (const r of row) {
        const cw = r.area / rowH;
        out.push({ item: r.item, x: cx, y: rect.y, w: cw, h: rowH });
        cx += cw;
      }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
    row = [];
  };
  for (const i of list) {
    const cell = { item: i.item, area: i.weight * scale };
    const side = Math.min(rect.w, rect.h);
    if (row.length && worst([...row, cell], side) > worst(row, side)) layRow();
    row.push(cell);
  }
  if (row.length) layRow();
  return out;
}
