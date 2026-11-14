// The explorer: one stage you zoom through. Clicking a box zooms into it and its contents appear inside it; the
// breadcrumbs (or Escape) zoom back out. A side panel describes where you are; a 3D map in the corner shows the
// levels you came through, and can take over the stage.
import type { IndexData, SymbolNode } from '../model.js';
import { find, issuesFor, repoOf } from './data.js';
import { code, h, link, plural, s } from './dom.js';
import { arrowDefs, drawLevel, fitRect, layoutGraph, panZoom, toolButton, type DrawnLevel, type Rect } from './graphview.js';
import { layerColor, layerName, levelFor, pathOf, PLATFORM, savedKinds, type Level } from './levels.js';
import { Scene3D, type Plane } from './scene3d.js';
import { edgeToggles, issueItem, sourceUrl } from './views.js';

type El = HTMLElement;

const DURATION = 700;
const exploreHref = (id: string, view3d = false): string => `#/e/${encodeURIComponent(id)}${view3d ? '?view=3d' : ''}`;
const ease = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const between = (t: number, a: number, b: number): number => Math.min(1, Math.max(0, (t - a) / (b - a)));
const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Explorer {
  readonly el: El;
  private readonly idx: IndexData;
  private readonly svg: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly stage: El;
  private readonly panel: El;
  private readonly crumbs: El;
  private readonly mini: El;
  private readonly full3d: El;
  private readonly scene: Scene3D;
  private readonly modeButton: HTMLButtonElement;
  private readonly flowButton: HTMLButtonElement;
  private kinds = savedKinds();
  private path: string[] = [];
  private levels: Level[] = [];
  private drawn: DrawnLevel | null = null;
  private vb: Rect = { x: 0, y: 0, w: 100, h: 100 };
  private selected: string | undefined;
  private busy = false;
  private queued: { id: string; view3d: boolean } | null = null;
  private view3d = false;
  private userMoved = false;

  constructor(idx: IndexData) {
    this.idx = idx;
    this.svg = s('svg', { class: 'ex-svg', role: 'img', 'aria-label': 'Architecture graph: click a box to zoom into it' }) as SVGSVGElement;
    this.viewport = s('g', { class: 'ex-viewport' }) as SVGGElement;
    this.svg.append(arrowDefs(), this.viewport);
    this.crumbs = h('nav', { class: 'crumbs ex-crumbs', 'aria-label': 'Where you are' });
    this.panel = h('aside', { class: 'ex-panel', 'aria-live': 'polite' });
    this.mini = h('div', { class: 'ex-mini' });
    this.full3d = h('div', { class: 'ex-full3d', hidden: true });
    this.scene = new Scene3D(this.mini, (id) => this.pick3d(id));
    this.modeButton = toolButton('3D', 'Show the 3D map full size', () => this.toggle3d());
    this.flowButton = toolButton('Flow', 'Animate the links: dots run from importer to imported', () => this.setFlow(!this.svg.classList.contains('flowing')));
    const expand = toolButton('⤢', 'Show the 3D map full size', () => this.toggle3d());
    expand.classList.add('ex-mini-expand');
    this.mini.append(expand, h('span', { class: 'ex-mini-label' }, 'Depth map'));
    const tools = h('div', { class: 'graph-tools' },
      toolButton('↑', 'Up one level (Escape)', () => this.up()),
      toolButton('+', 'Zoom in', () => this.zoomBy(0.8)),
      toolButton('−', 'Zoom out', () => this.zoomBy(1.25)),
      toolButton('⌂', 'Fit (in 3D: back to the default angle)', () => this.fit()),
      this.flowButton,
      this.modeButton,
    );
    this.stage = h('div', { class: 'ex-stage' }, this.svg, this.full3d, tools, this.mini);
    this.el = h('div', { class: 'explorer' },
      h('div', { class: 'ex-bar' }, this.crumbs, h('p', { class: 'ex-hint muted' }, 'Click a box to zoom in · Escape to go up · drag to pan')),
      h('div', { class: 'ex-body' }, this.stage, this.panel),
    );

    let flow = false;
    try {
      flow = localStorage.getItem('arch.flow') === '1';
    } catch {
      // not remembered
    }
    this.setFlow(flow && !reducedMotion());
    panZoom(this.svg, () => this.vb, (r) => {
      if (this.busy) return;
      this.userMoved = true;
      this.setVb(r);
    }, true);
    this.svg.addEventListener('click', (ev) => this.onClick(ev));
    new ResizeObserver(() => {
      if (this.drawn && !this.busy && !this.userMoved) this.setVb(fitRect(this.drawn.bounds, this.aspect()));
    }).observe(this.svg);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.el.isConnected && document.activeElement?.tagName !== 'INPUT') this.up();
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Navigation

  /** Shows the level for `id` (a symbol selects itself on its file's level), animating from where we are. */
  async go(id: string, view3d: boolean): Promise<void> {
    if (this.busy) {
      this.queued = { id, view3d };
      return;
    }
    this.busy = true;
    try {
      await this.goNow(id, view3d);
    } finally {
      this.busy = false;
    }
    const next = this.queued;
    this.queued = null;
    if (next) await this.go(next.id, next.view3d);
  }

  private async goNow(id: string, view3d: boolean): Promise<void> {
    const idx = this.idx;
    let target = pathOf(idx, id);
    let selected: string | undefined = id.includes('#') ? id : undefined;
    // Load the levels; a node with no level of its own (a file without declarations) is selected on its parent's.
    let levels: Level[] = [];
    for (const lid of target) {
      const level = await levelFor(idx, lid, this.kinds);
      if (!level) {
        selected = lid;
        target = target.slice(0, levels.length);
        break;
      }
      levels.push(level);
    }
    if (!levels.length) {
      levels = [(await levelFor(idx, PLATFORM, this.kinds))!];
      target = [PLATFORM];
    }
    const old = this.path;
    const next = levels[levels.length - 1]!;
    const sameLevel = old.length === target.length && old.every((p, i) => p === target[i]);
    const deeper = target.length === old.length + 1 && old.every((p, i) => p === target[i]);
    const shallower = target.length < old.length && target.every((p, i) => p === old[i]);
    this.path = target;
    this.levels = levels;
    this.selected = selected;
    if (!sameLevel || !this.drawn) {
      this.userMoved = false;
      const animate = !!this.drawn && !reducedMotion() && !this.view3d;
      if (animate && deeper && this.drawn!.nodeEls.has(target[target.length - 1]!)) await this.zoomIn(target[target.length - 1]!, next);
      else if (animate && shallower) await this.zoomOut(next, old[target.length]!);
      else await this.crossfade(next, animate);
    }
    this.markSelected();
    if (view3d !== this.view3d) this.set3d(view3d);
    this.renderCrumbs();
    this.renderPanel();
    this.renderScene();
    document.title = `${this.levelTitle(next)} · ${idx.title}`;
  }

  private onClick(ev: MouseEvent): void {
    const a = (ev.target as Element).closest('a.node');
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    const id = a.getAttribute('data-id')!;
    const level = this.levels[this.levels.length - 1]!;
    const node = level.nodes.find((n) => n.id === id);
    if (level.zoomable.has(id)) location.hash = exploreHref(id, this.view3d);
    else if (node?.target) location.hash = exploreHref(node.target, this.view3d);
    else {
      this.selected = id;
      this.markSelected();
      this.renderCrumbs();
      this.renderPanel();
      this.renderScene();
    }
  }

  private pick3d(id: string): void {
    // A box on any plane: go to it (its own level, or selected on its parent's).
    for (const level of this.levels) {
      const node = level.nodes.find((n) => n.id === id);
      if (!node) continue;
      const target = node.target ?? id;
      if (level.zoomable.has(id) || node.target) location.hash = exploreHref(target, this.view3d);
      else location.hash = exploreHref(level.kind === 'file' ? id : target, this.view3d);
      return;
    }
  }

  private setFlow(on: boolean): void {
    this.svg.classList.toggle('flowing', on);
    this.flowButton.classList.toggle('on', on);
    this.flowButton.setAttribute('aria-pressed', String(on));
    try {
      localStorage.setItem('arch.flow', on ? '1' : '0');
    } catch {
      // not remembered
    }
  }

  up(): void {
    if (this.path.length > 1) location.hash = exploreHref(this.path[this.path.length - 2]!, this.view3d);
  }

  private toggle3d(): void {
    const current = this.selected ?? this.path[this.path.length - 1] ?? '';
    location.hash = exploreHref(current, !this.view3d);
  }

  private set3d(on: boolean): void {
    this.view3d = on;
    this.full3d.hidden = !on;
    this.svg.toggleAttribute('hidden', on);
    this.stage.classList.toggle('is-3d', on);
    (on ? this.full3d : this.mini).prepend(this.scene.canvas);
    this.scene.setFull(on);
    this.modeButton.textContent = on ? '2D' : '3D';
    this.modeButton.title = on ? 'Back to the 2D graph' : 'Show the 3D map full size';
    this.modeButton.setAttribute('aria-label', this.modeButton.title);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Drawing and animation

  private aspect(): number {
    const r = this.svg.getBoundingClientRect();
    return r.width && r.height ? r.width / r.height : 1.6;
  }

  private setVb(r: Rect): void {
    this.vb = r;
    this.svg.setAttribute('viewBox', `${r.x} ${r.y} ${r.w} ${r.h}`);
  }

  private fit(): void {
    if (this.view3d) return this.scene.reset();
    if (!this.drawn) return;
    this.userMoved = false;
    void this.animateVb(this.vb, fitRect(this.drawn.bounds, this.aspect()), 350, () => {});
  }

  private zoomBy(k: number): void {
    if (this.view3d) return this.scene.zoomBy(k);
    this.userMoved = true;
    const vb = this.vb;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    void this.animateVb(vb, { x: cx - (vb.w * k) / 2, y: cy - (vb.h * k) / 2, w: vb.w * k, h: vb.h * k }, 200, () => {});
  }

  /** Moves the viewBox from `a` to `b`: centre in a line, size by ratio, so zooming feels even. */
  private animateVb(a: Rect, b: Rect, duration: number, step: (t: number) => void): Promise<void> {
    return new Promise((done) => {
      const start = performance.now();
      const frame = (now: number): void => {
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        const w = a.w * (b.w / a.w) ** e;
        const hgt = a.h * (b.h / a.h) ** e;
        const cx = a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * e;
        const cy = a.y + a.h / 2 + (b.y + b.h / 2 - (a.y + a.h / 2)) * e;
        this.setVb({ x: cx - w / 2, y: cy - hgt / 2, w, h: hgt });
        step(e);
        if (t < 1) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
  }

  private draw(level: Level): DrawnLevel {
    return drawLevel(level.nodes, level.edges, level.options);
  }

  /** The transform that puts `inner` (a level's bounds) inside `box`, and where that lands. */
  private placeInside(inner: Rect, box: Rect): { transform: string; world: Rect } {
    const k = Math.min(box.w / inner.w, box.h / inner.h) * 0.96;
    const tx = box.x + box.w / 2 - k * (inner.x + inner.w / 2);
    const ty = box.y + box.h / 2 - k * (inner.y + inner.h / 2);
    return { transform: `translate(${tx},${ty}) scale(${k})`, world: { x: tx + k * inner.x, y: ty + k * inner.y, w: k * inner.w, h: k * inner.h } };
  }

  private nodeRect(drawn: DrawnLevel, id: string): Rect | undefined {
    const p = drawn.layout.nodes.get(id);
    return p ? { x: p.x, y: p.y, w: p.width, h: p.height } : undefined;
  }

  private async zoomIn(nodeId: string, level: Level): Promise<void> {
    const from = this.drawn!;
    const box = this.nodeRect(from, nodeId)!;
    const next = this.draw(level);
    const placed = this.placeInside(next.bounds, box);
    next.group.setAttribute('transform', placed.transform);
    next.group.style.opacity = '0';
    this.viewport.append(next.group);
    const target = from.nodeEls.get(nodeId)!;
    target.classList.add('zoom-target');
    const others = [...from.group.children].filter((c) => c.classList.contains('edges') || c.classList.contains('rank-label'));
    const otherNodes = [...from.nodeEls.values()].filter((n) => n !== target);
    await this.animateVb(this.vb, fitRect(placed.world, this.aspect()), DURATION, (e) => {
      const fade = String(1 - between(e, 0.05, 0.55));
      for (const o of others) (o as SVGElement).style.opacity = fade;
      for (const o of otherNodes) o.style.opacity = fade;
      target.style.opacity = String(1 - between(e, 0.55, 1));
      next.group.style.opacity = String(between(e, 0.35, 0.9));
    });
    from.group.remove();
    next.group.removeAttribute('transform');
    next.group.style.opacity = '';
    this.drawn = next;
    this.setVb(fitRect(next.bounds, this.aspect()));
  }

  private async zoomOut(level: Level, viaId: string): Promise<void> {
    const from = this.drawn!;
    const next = this.draw(level);
    const box = this.nodeRect(next, viaId);
    if (!box) return this.crossfade(level, true);
    const placed = this.placeInside(from.bounds, box);
    from.group.setAttribute('transform', placed.transform);
    this.setVb(fitRect(placed.world, this.aspect()));
    next.group.style.opacity = '0';
    this.viewport.prepend(next.group);
    const via = next.nodeEls.get(viaId);
    via?.classList.add('zoom-target');
    await this.animateVb(this.vb, fitRect(next.bounds, this.aspect()), DURATION, (e) => {
      from.group.style.opacity = String(1 - between(e, 0.1, 0.6));
      next.group.style.opacity = String(between(e, 0.2, 0.75));
    });
    via?.classList.remove('zoom-target');
    from.group.remove();
    next.group.style.opacity = '';
    this.drawn = next;
  }

  private async crossfade(level: Level, animate: boolean): Promise<void> {
    const old = this.drawn;
    const next = this.draw(level);
    this.viewport.append(next.group);
    this.drawn = next;
    const fitted = fitRect(next.bounds, this.aspect());
    if (!old || !animate) {
      old?.group.remove();
      this.setVb(fitted);
      return;
    }
    next.group.style.opacity = '0';
    const start = performance.now();
    await new Promise<void>((done) => {
      const frame = (now: number): void => {
        const t = Math.min(1, (now - start) / 300);
        old.group.style.opacity = String(1 - t);
        if (t >= 0.5) this.setVb(fitted);
        next.group.style.opacity = String(between(t, 0.5, 1));
        if (t < 1) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    old.group.remove();
    next.group.style.opacity = '';
  }

  private markSelected(): void {
    if (!this.drawn) return;
    for (const [id, el] of this.drawn.nodeEls) el.classList.toggle('selected', id === this.selected);
  }

  /** Re-draws the platform level when the kinds of links shown change. */
  private async redrawPlatform(): Promise<void> {
    if (this.path.length !== 1) return;
    const level = (await levelFor(this.idx, PLATFORM, this.kinds))!;
    this.levels = [level];
    this.drawn?.group.remove();
    this.drawn = this.draw(level);
    this.viewport.append(this.drawn.group);
    this.markSelected();
    this.renderScene();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Breadcrumbs, panel, 3D

  private levelTitle(level: Level): string {
    if (level.kind === 'platform') return 'Platform';
    if (level.kind === 'repo') return level.id;
    return level.id.slice(level.id.indexOf('/') + 1);
  }

  private renderCrumbs(): void {
    const parts = this.levels.map((l, i) => {
      const label = l.kind === 'platform' ? 'Platform' : l.kind === 'repo' ? l.id : l.id.replace(/\/$/, '').split('/').pop()! + (l.kind === 'dir' ? '/' : '');
      const last = i === this.levels.length - 1 && !this.selected?.includes('#');
      return [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null, last ? h('span', { 'aria-current': 'page' }, label) : h('a', { href: exploreHref(l.id, this.view3d) }, label)];
    });
    if (this.selected?.includes('#')) parts.push([h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { 'aria-current': 'page' }, this.selected.split('#')[1]!)]);
    this.crumbs.replaceChildren(...parts.flat().filter(Boolean) as Node[]);
  }

  private renderScene(): void {
    const planes: Plane[] = this.levels.map((level, i) => {
      const { layout, bounds } = layoutGraph(level.nodes, level.edges, level.options);
      const focus = i < this.path.length - 1 ? this.path[i + 1] : this.selected;
      return {
        id: level.id,
        title: this.levelTitle(level),
        bounds,
        focus,
        nodes: level.nodes.map((n) => {
          const p = layout.nodes.get(n.id)!;
          return { id: n.id, label: n.label, x: p.x, y: p.y, w: p.width, h: p.height, color: n.color ?? 'var(--text-3)', muted: !!n.muted };
        }),
        edges: level.edges.map((e) => [e.from, e.to] as [string, string]),
      };
    });
    this.scene.setPlanes(planes);
  }

  private renderPanel(): void {
    void this.panelFor(this.selected ?? this.path[this.path.length - 1] ?? PLATFORM).then((content) => {
      this.panel.replaceChildren(content);
    });
  }

  private async panelFor(id: string): Promise<El> {
    const idx = this.idx;
    const detail = (nid: string): El => h('a', { class: 'button', href: `#/n/${encodeURIComponent(nid)}` }, 'Details');
    const issues = (nid: string, deep: boolean): El | null => {
      const list = issuesFor(idx, nid, deep);
      if (!list.length) return null;
      const order = { error: 0, warning: 1, info: 2 };
      const sorted = [...list].sort((a, b) => order[a.severity] - order[b.severity]);
      return h('div', null, h('h3', null, `Issues (${list.length})`), h('ul', { class: 'issues compact' }, sorted.slice(0, 5).map((i) => issueItem(idx, i, deep))), list.length > 5 ? h('a', { href: `#/issues?repo=${encodeURIComponent(repoOf(idx, nid) ?? '')}` }, `All ${list.length}`) : null);
    };
    const traceFrom = ((): string | null => {
      try {
        return sessionStorage.getItem('arch.traceFrom');
      } catch {
        return null;
      }
    })();
    const tools = (nid: string): El => h('div', { class: 'actions tools' },
      h('a', { class: 'button', href: `#/impact/${encodeURIComponent(nid)}` }, 'What breaks?'),
      traceFrom && traceFrom !== nid
        ? h('a', { class: 'button', href: `#/trace?from=${encodeURIComponent(traceFrom)}&to=${encodeURIComponent(nid)}` }, 'Trace to here')
        : h('button', { type: 'button', class: 'button', onclick: (e: Event) => {
          try {
            sessionStorage.setItem('arch.traceFrom', nid);
          } catch {
            // not kept
          }
          (e.target as HTMLElement).textContent = 'Now pick where to trace to';
        } }, 'Trace from here'),
      nid.endsWith('/') || idx.repos.some((r) => r.id === nid) ? h('a', { class: 'button', href: `#/matrix?of=${encodeURIComponent(nid)}` }, 'Matrix') : null,
    );
    const level = this.levels[this.levels.length - 1]!;
    const zoomHint = level.zoomable.has(id) && id !== level.id ? h('a', { class: 'button primary', href: exploreHref(id, this.view3d) }, 'Zoom in') : null;

    if (id === PLATFORM) {
      const counts = { error: 0, warning: 0, info: 0 };
      for (const i of idx.issues) counts[i.severity]++;
      const withCode = idx.repos.filter((r) => r.stats.files > 0);
      return h('div', null,
        h('h2', null, 'The platform'),
        h('p', { class: 'muted' }, `${plural(withCode.length, 'repository', 'repositories')} with code, ${plural(withCode.reduce((n, r) => n + r.stats.files, 0), 'file')}, ${withCode.reduce((n, r) => n + r.stats.loc, 0).toLocaleString()} lines. Click a product to zoom in.`),
        h('div', { class: 'stats' },
          h('a', { class: 'stat sev-error', href: '#/issues?severity=error' }, h('strong', null, String(counts.error)), ' errors'),
          h('a', { class: 'stat sev-warning', href: '#/issues?severity=warning' }, h('strong', null, String(counts.warning)), ' warnings')),
        edgeToggles(idx, this.kinds, () => void this.redrawPlatform()),
        h('h3', null, 'Layers'),
        h('ul', { class: 'plain layers' }, idx.layers.filter((l) => withCode.some((r) => r.layer === l.id)).map((l) => h('li', null, h('span', { class: 'swatch-dot', style: `background:var(${l.color})` }), h('strong', null, l.name), ' ', h('span', { class: 'muted' }, l.about)))),
        h('p', null, h('a', { href: '#/overview' }, 'Overview page'), ' · ', h('a', { href: '#/agents' }, 'For agents')),
      );
    }
    if (id.startsWith('repo:')) id = id.slice(5);
    const found = await find(id);
    if (!found) return h('div', null, h('h2', null, id), h('p', { class: 'muted' }, 'Not in this build.'));
    switch (found.kind) {
      case 'repo': {
        const r = found.node;
        const entries = idx.entries.filter((e) => e.repo === r.name);
        const uses = [...new Set(idx.edges.filter((e) => e.from === r.name && e.kind === 'import').map((e) => e.to))];
        const usedBy = [...new Set(idx.edges.filter((e) => e.to === r.name && e.kind === 'import').map((e) => e.from))];
        return h('div', null,
          h('h2', null, r.name, ' ', h('span', { class: 'chip layer', style: `--chip:${layerColor(idx, r.layer)}` }, layerName(idx, r.layer))),
          h('p', null, r.intent?.summary ?? r.positioning ?? r.description ?? ''),
          h('p', { class: 'muted' }, `${plural(r.stats.files, 'file')} · ${r.stats.loc.toLocaleString()} lines · ${plural(r.stats.exported, 'export')}`),
          h('div', { class: 'actions' }, zoomHint, detail(r.id), h('a', { class: 'button', href: r.url, target: '_blank', rel: 'noopener' }, 'GitHub')),
          tools(r.id),
          entries.length ? h('div', null, h('h3', null, 'Entry points'), h('ul', { class: 'plain' }, entries.map((e) => h('li', null, link(e.id, e.name), ' ', h('span', { class: 'muted' }, String(e.api.length)))))) : null,
          uses.length ? h('div', null, h('h3', null, 'Its code imports'), h('p', null, uses.map((u, i) => [i ? ', ' : '', h('a', { href: exploreHref(u, this.view3d) }, u)]))) : null,
          usedBy.length ? h('div', null, h('h3', null, 'Imported by'), h('p', null, usedBy.map((u, i) => [i ? ', ' : '', h('a', { href: exploreHref(u, this.view3d) }, u)]))) : null,
          issues(r.id, true),
        );
      }
      case 'dir': {
        const d = found.node;
        return h('div', null,
          h('h2', null, d.path + '/'), h('p', { class: 'muted' }, `${d.repo} · ${plural(d.files, 'file')} · ${d.loc.toLocaleString()} lines`),
          h('div', { class: 'actions' }, zoomHint, detail(d.id)),
          tools(d.id),
          issues(d.id, true));
      }
      case 'file': {
        const f = found.node;
        const importers = [...found.repo.edges, ...found.repo.inbound].filter((e) => e.to === f.id).length;
        return h('div', null,
          h('h2', null, f.name), h('p', { class: 'muted' }, `${f.repo}/${f.path}`),
          f.doc ? h('div', { class: 'doc' }, f.doc) : null,
          h('p', { class: 'muted' }, `${f.role} · ${f.loc.toLocaleString()} lines · ${plural(f.symbols.length, 'declaration')} · imports ${f.imports.length} · imported by ${importers}${f.tested === false ? ' · no test reaches it' : ''}`),
          f.churn ? h('p', { class: 'muted' }, `${plural(f.churn.commits, 'commit')}, ${f.churn.lines.toLocaleString()} lines changed, last ${f.churn.last.slice(0, 10)}${f.hotspot ? ` · hot spot ${f.hotspot}` : ''}`) : null,
          h('div', { class: 'actions' }, zoomHint, detail(f.id), h('a', { class: 'button', href: sourceUrl(idx, f.id), target: '_blank', rel: 'noopener' }, 'Source')),
          tools(f.id),
          issues(f.id, false));
      }
      case 'symbol': {
        const sym: SymbolNode = found.node;
        const byRepo = new Map<string, string[]>();
        for (const u of sym.usedBy) byRepo.set(u.split('/')[0]!, [...(byRepo.get(u.split('/')[0]!) ?? []), u]);
        return h('div', null,
          h('h2', null, h('span', { class: 'chip kind' }, sym.symbolKind), ' ', sym.name),
          h('p', { class: 'muted' }, `${sym.file} · line ${sym.line}`),
          h('pre', { class: 'sig' }, h('code', null, sym.signature)),
          sym.doc ? h('div', { class: 'doc' }, sym.doc) : null,
          h('div', { class: 'actions' }, detail(sym.id), h('a', { class: 'button', href: sourceUrl(idx, sym.file, sym.line), target: '_blank', rel: 'noopener' }, 'Source')),
          tools(sym.id),
          sym.calls?.length ? h('div', null, h('h3', null, `Uses (${sym.calls.length})`), h('ul', { class: 'plain' }, sym.calls.map((c) => h('li', null, h('a', { href: exploreHref(c, this.view3d) }, c.startsWith(sym.file + '#') ? c.split('#')[1]! : c))))) : null,
          ((): El | null => {
            const callers = found.repo.symbols.filter((x) => x.calls?.includes(sym.id));
            return callers.length ? h('div', null, h('h3', null, `Used in this repository by (${callers.length})`), h('ul', { class: 'plain' }, callers.map((c) => h('li', null, h('a', { href: exploreHref(c.id, this.view3d) }, c.file === sym.file ? c.name : c.id))))) : null;
          })(),
          sym.members?.length ? h('details', null, h('summary', null, plural(sym.members.length, 'member')), h('ul', { class: 'members' }, sym.members.map((m) => h('li', null, code(m.signature))))) : null,
          h('h3', null, `Used by (${sym.usedBy.length})`),
          sym.usedBy.length ? [...byRepo].map(([name, files]) => h('div', null, h('strong', null, name), h('ul', { class: 'plain' }, files.map((f) => h('li', null, h('a', { href: exploreHref(f, this.view3d) }, f.slice(name.length + 1))))))) : h('p', { class: 'muted' }, sym.exported ? 'Nothing in the family imports it.' : 'Not exported.'),
        );
      }
      default:
        return h('div', null, h('h2', null, found.node.name), h('div', { class: 'actions' }, detail(found.node.id)));
    }
  }
}
