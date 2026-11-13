// The 3D map: the levels you have drilled through, stacked as planes from the platform (top) down to where you are.
// Each plane shows its level's boxes and links as the 2D view lays them out; lines run from the box you zoomed into
// down to the plane it opened. Drawn on a canvas with a small projection of our own: drag to turn, wheel to zoom,
// click a box to go there.
import type { Rect } from './graphview.js';

export interface PlaneNode {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** A CSS colour, resolved when drawn. */
  readonly color: string;
  readonly muted: boolean;
}

export interface Plane {
  readonly id: string;
  readonly title: string;
  readonly nodes: PlaneNode[];
  readonly edges: [string, string][];
  readonly bounds: Rect;
  /** The node that opens the next plane down (or the selected node, on the last plane). */
  readonly focus?: string;
}

interface Vec {
  x: number;
  y: number;
  z: number;
}

interface Projected {
  sx: number;
  sy: number;
  depth: number;
}

interface Fit {
  scale: number;
  cx: number;
  cy: number;
}

interface Hit {
  plane: number;
  node: PlaneNode;
  sx: number;
  sy: number;
  r: number;
}

const GAP = 0.85;
const SIZE = 1;

/** Reads a CSS colour (a token or var()) as the browser computes it. */
function colorResolver(host: HTMLElement): (css: string) => string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.append(probe);
  const cache = new Map<string, string>();
  return (css: string): string => {
    let c = cache.get(css);
    if (!c) {
      probe.style.color = '';
      probe.style.color = css;
      c = getComputedStyle(probe).color || '#888';
      cache.set(css, c);
    }
    return c;
  };
}

function withAlpha(rgb: string, a: number): string {
  const m = /rgba?\(([^)]+)\)/.exec(rgb);
  if (!m) return rgb;
  const [r, g, b] = m[1]!.split(',').map((v) => v.trim());
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private planes: Plane[] = [];
  private current = 0;
  private yaw = -0.55;
  private pitch = 0.62;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  /** Plane centres in world space (each plane sits under the box that opened it). */
  private centres: Vec[] = [];
  private fit: Fit = { scale: 1, cx: 0, cy: 0 };
  private fitFrom: Fit | null = null;
  private fitStart = 0;
  private hover: { plane: number; node: PlaneNode } | null = null;
  private frame = 0;
  private resolve: (css: string) => string;
  private full = false;
  private onPick: (id: string) => void;
  private hit: Hit[] = [];

  constructor(host: HTMLElement, onPick: (id: string) => void) {
    this.onPick = onPick;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene3d';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Where you are, in 3D: one plane per level from the platform down');
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resolve = colorResolver(host);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    // Colours follow the theme.
    new MutationObserver(() => {
      this.resolve = colorResolver(host);
      this.draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.resolve = colorResolver(host);
      this.draw();
    });
    this.interact();
  }

  setFull(full: boolean): void {
    this.full = full;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.draw();
  }

  /** New planes; the camera glides to them. */
  setPlanes(planes: Plane[]): void {
    this.fitFrom = this.planes.length ? { ...this.fit } : null;
    this.fitStart = performance.now();
    this.planes = planes;
    this.current = planes.length - 1;
    // Each plane is centred under its parent's focus box.
    this.centres = [];
    planes.forEach((p, i) => {
      if (i === 0) {
        this.centres.push({ x: 0, y: 0, z: 0 });
        return;
      }
      const parent = planes[i - 1]!;
      const c = this.centres[i - 1]!;
      const f = parent.nodes.find((n) => n.id === parent.focus);
      const at = f ? this.local(parent, f.x + f.w / 2, f.y + f.h / 2) : { x: 0, z: 0 };
      this.centres.push({ x: c.x + at.x * 0.6, y: -i * GAP, z: c.z + at.z * 0.6 });
    });
    this.draw();
  }

  /** A point of a plane's layout in the plane's own world units, centred. */
  private local(p: Plane, x: number, y: number): { x: number; z: number } {
    const b = p.bounds;
    const k = (2 * SIZE) / Math.max(b.w, b.h * 1.4);
    return { x: (x - (b.x + b.w / 2)) * k, z: (y - (b.y + b.h / 2)) * k };
  }

  private world(i: number, x: number, y: number): Vec {
    const l = this.local(this.planes[i]!, x, y);
    const c = this.centres[i]!;
    return { x: c.x + l.x, y: c.y, z: c.z + l.z };
  }

  private project(v: Vec): Projected {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const x1 = v.x * cy - v.z * sy;
    const z1 = v.x * sy + v.z * cy;
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const y2 = v.y * cp - z1 * sp;
    const z2 = v.y * sp + z1 * cp;
    const persp = 7 / (7 + z2);
    return { sx: x1 * persp, sy: -y2 * persp, depth: z2 };
  }

  draw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame((t) => this.render(t));
  }

  private render(now: number): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.planes.length) return;
    const col = this.resolve;
    const text = col('var(--text)');
    const text3 = col('var(--text-3)');
    const primary = col('var(--primary)');
    const accent = col('var(--accent)');
    const surface = col('var(--surface)');
    const border = col('var(--border)');

    // Project every plane's corners and nodes.
    const corners = this.planes.map((p, i) => {
      const b = p.bounds;
      return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => this.project(this.world(i, x!, y!)));
    });
    // Fit everything into the canvas; glide from the previous fit when the planes change.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const cs of corners) for (const c of cs) {
      minX = Math.min(minX, c.sx);
      maxX = Math.max(maxX, c.sx);
      minY = Math.min(minY, c.sy);
      maxY = Math.max(maxY, c.sy);
    }
    const margin = this.full ? 60 : 14;
    const target = {
      scale: Math.min((W - margin * 2) / Math.max(0.01, maxX - minX), (H - margin * 2 - (this.full ? 0 : 14)) / Math.max(0.01, maxY - minY)),
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };
    const glide = this.fitFrom ? Math.min(1, (now - this.fitStart) / 650) : 1;
    const e = glide < 0.5 ? 4 * glide ** 3 : 1 - (-2 * glide + 2) ** 3 / 2;
    if (this.fitFrom && glide < 1) {
      this.fit = {
        scale: this.fitFrom.scale + (target.scale - this.fitFrom.scale) * e,
        cx: this.fitFrom.cx + (target.cx - this.fitFrom.cx) * e,
        cy: this.fitFrom.cy + (target.cy - this.fitFrom.cy) * e,
      };
      this.frame = requestAnimationFrame((t) => this.render(t));
    } else {
      this.fit = target;
      this.fitFrom = null;
    }
    const scale = this.fit.scale * this.zoom;
    const toScreen = (p: Projected): [number, number] => [W / 2 + (p.sx - this.fit.cx) * scale + this.pan.x, H / 2 + (p.sy - this.fit.cy) * scale + this.pan.y + (this.full ? 0 : 7)];

    // Far planes first.
    const order = this.planes.map((_, i) => i).sort((a, b) => {
      const da = corners[a]!.reduce((s, c) => s + c.depth, 0);
      const db = corners[b]!.reduce((s, c) => s + c.depth, 0);
      return db - da;
    });
    this.hit = [];
    const nodeQuad = (i: number, n: PlaneNode): [number, number][] =>
      [[n.x, n.y], [n.x + n.w, n.y], [n.x + n.w, n.y + n.h], [n.x, n.y + n.h]].map(([x, y]) => toScreen(this.project(this.world(i, x!, y!))));
    const poly = (pts: [number, number][]): void => {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    for (const i of order) {
      const p = this.planes[i]!;
      const isCurrent = i === this.current;
      const quad = corners[i]!.map(toScreen);
      poly(quad);
      ctx.fillStyle = withAlpha(surface, isCurrent ? 0.92 : 0.6);
      ctx.fill();
      ctx.lineWidth = isCurrent ? 1.6 : 1;
      ctx.strokeStyle = isCurrent ? primary : border;
      ctx.stroke();
      // Links.
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      ctx.lineWidth = isCurrent ? 1 : 0.6;
      ctx.strokeStyle = withAlpha(isCurrent ? primary : text3, isCurrent ? 0.35 : 0.22);
      ctx.beginPath();
      for (const [a, b] of p.edges) {
        const na = byId.get(a);
        const nb = byId.get(b);
        if (!na || !nb) continue;
        const [x1, y1] = toScreen(this.project(this.world(i, na.x + na.w / 2, na.y + na.h / 2)));
        const [x2, y2] = toScreen(this.project(this.world(i, nb.x + nb.w / 2, nb.y + nb.h / 2)));
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      // Boxes.
      for (const n of p.nodes) {
        const q = nodeQuad(i, n);
        poly(q);
        const focus = n.id === p.focus;
        const hovered = this.hover?.plane === i && this.hover.node.id === n.id;
        ctx.fillStyle = withAlpha(col(n.color), n.muted ? 0.3 : focus ? 1 : isCurrent ? 0.85 : 0.55);
        ctx.fill();
        if (focus || hovered) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = focus ? accent : primary;
          ctx.stroke();
        }
        const cx = q.reduce((s, v) => s + v[0], 0) / 4;
        const cy = q.reduce((s, v) => s + v[1], 0) / 4;
        const r = Math.max(5, Math.hypot(q[2]![0] - q[0]![0], q[2]![1] - q[0]![1]) / 2);
        this.hit.push({ plane: i, node: n, sx: cx, sy: cy, r });
      }
      // The plane's name, just left of its leftmost corner, so it never sits on another plane's boxes.
      const left = quad.reduce((best, c) => (c[0] < best[0] ? c : best), quad[0]!);
      ctx.font = `${isCurrent ? 600 : 400} ${this.full ? 12 : 10}px system-ui, sans-serif`;
      ctx.fillStyle = isCurrent ? text : text3;
      ctx.textAlign = 'right';
      if (this.full || isCurrent || i === 0) ctx.fillText(p.title, Math.max(left[0] - 6, ctx.measureText(p.title).width + 2), left[1] + 4);
    }
    // From each focus box down to the plane it opened.
    for (let i = 0; i < this.planes.length - 1; i++) {
      const p = this.planes[i]!;
      const f = p.nodes.find((n) => n.id === p.focus);
      if (!f) continue;
      const from = nodeQuad(i, f);
      const to = corners[i + 1]!.map(toScreen);
      ctx.strokeStyle = withAlpha(accent, 0.55);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        ctx.moveTo(from[k]![0], from[k]![1]);
        ctx.lineTo(to[k]![0], to[k]![1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Labels: in the full view, every box on the current plane and the focus boxes; in the mini map, the focus boxes.
    ctx.font = `11px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const h of this.hit) {
      const p = this.planes[h.plane]!;
      const show = h.node.id === p.focus || (this.full && h.plane === this.current && !h.node.muted);
      if (!show) continue;
      ctx.fillStyle = h.node.id === p.focus ? accent : text;
      ctx.fillText(h.node.label, h.sx, h.sy - h.r * 0.4 - 3);
    }
    if (this.hover) {
      const h = this.hit.find((x) => x.plane === this.hover!.plane && x.node.id === this.hover!.node.id);
      if (h) {
        const label = `${h.node.label} · ${this.planes[h.plane]!.title}`;
        ctx.font = '600 12px system-ui, sans-serif';
        const w = ctx.measureText(label).width + 12;
        const x = Math.min(Math.max(h.sx - w / 2, 2), W - w - 2);
        const y = Math.max(h.sy - h.r - 26, 2);
        ctx.fillStyle = surface;
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, w, 20, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = text;
        ctx.textAlign = 'left';
        ctx.fillText(label, x + 6, y + 14);
      }
    }
  }

  private pick(ev: PointerEvent | MouseEvent): { plane: number; node: PlaneNode } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best: Hit | null = null;
    let bestD = Infinity;
    for (const h of this.hit) {
      const d = Math.hypot(h.sx - x, h.sy - y);
      if (d < Math.max(8, h.r) && d < bestD) {
        best = h;
        bestD = d;
      }
    }
    return best ? { plane: best.plane, node: best.node } : null;
  }

  private interact(): void {
    const c = this.canvas;
    let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean; pan: boolean; px: number; py: number } | null = null;
    c.addEventListener('pointerdown', (ev) => {
      drag = { x: ev.clientX, y: ev.clientY, yaw: this.yaw, pitch: this.pitch, moved: false, pan: ev.shiftKey || ev.button === 2, px: this.pan.x, py: this.pan.y };
    });
    c.addEventListener('pointermove', (ev) => {
      if (drag) {
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
          drag.moved = true;
          c.setPointerCapture(ev.pointerId);
        }
        if (drag.moved) {
          if (drag.pan) this.pan = { x: drag.px + dx, y: drag.py + dy };
          else {
            this.yaw = drag.yaw + dx * 0.008;
            this.pitch = Math.min(1.45, Math.max(0.08, drag.pitch + dy * 0.006));
          }
          this.draw();
        }
        return;
      }
      const h = this.pick(ev);
      if (h?.node.id !== this.hover?.node.id || h?.plane !== this.hover?.plane) {
        this.hover = h;
        c.style.cursor = h ? 'pointer' : 'grab';
        this.draw();
      }
    });
    const end = (ev: PointerEvent): void => {
      const wasDrag = drag?.moved;
      drag = null;
      if (c.hasPointerCapture(ev.pointerId)) c.releasePointerCapture(ev.pointerId);
      if (wasDrag) return;
      const h = this.pick(ev);
      if (h) this.onPick(h.node.id);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => (drag = null));
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.draw();
      }
    });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('wheel', (ev) => {
      if (!this.full) return;
      ev.preventDefault();
      this.zoom = Math.min(8, Math.max(0.3, this.zoom * Math.exp(-ev.deltaY * 0.0015)));
      this.draw();
    }, { passive: false });
  }

  zoomBy(k: number): void {
    this.zoom = Math.min(8, Math.max(0.3, this.zoom / k));
    this.draw();
  }

  /** Back to the default angle. */
  reset(): void {
    this.yaw = -0.55;
    this.pitch = 0.62;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.draw();
  }
}
