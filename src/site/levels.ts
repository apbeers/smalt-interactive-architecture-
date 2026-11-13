// The levels you drill through: the platform, a repository, a folder, a file. Each is a graph (nodes and edges) the
// explorer draws and the 3D map stacks. A node that has a level of its own can be zoomed into.
import type { DirNode, Edge, FileNode, IndexData, SymbolNode } from '../model.js';
import { edgeKinds, issuesFor, loadRepo, repoOf, type RepoView } from './data.js';
import { nodeHref, plural } from './dom.js';
import type { GEdge, GNode, GraphOptions } from './graphview.js';
import { rankNodes } from './layout.js';

export type LevelKind = 'platform' | 'repo' | 'dir' | 'file';

export interface Level {
  /** '' for the platform; otherwise a repository, directory or file id. */
  readonly id: string;
  readonly kind: LevelKind;
  readonly title: string;
  readonly nodes: GNode[];
  readonly edges: GEdge[];
  readonly options: GraphOptions;
  /** Node ids on this level that have a level of their own. */
  readonly zoomable: Set<string>;
}

export const PLATFORM = '';
export const LAYER_ORDER = ['tool', 'kit', 'language', 'family', 'plugin', 'engine', 'brand', 'other'];
export const DEFAULT_KINDS = ['import', 'npm', 'pin', 'runtime', 'worker'];

export const layerColor = (idx: IndexData, layer: string): string => `var(${idx.layers.find((l) => l.id === layer)?.color ?? '--text-3'})`;
export const layerName = (idx: IndexData, layer: string): string => idx.layers.find((l) => l.id === layer)?.name ?? layer;
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, text.lastIndexOf(' ', max - 1) > 0 ? text.lastIndexOf(' ', max - 1) : max - 1) + '…';

export function savedKinds(): Set<string> {
  try {
    const raw = localStorage.getItem('arch.kinds');
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // storage unavailable: use the defaults
  }
  return new Set(DEFAULT_KINDS);
}

export function saveKinds(kinds: Set<string>): void {
  try {
    localStorage.setItem('arch.kinds', JSON.stringify([...kinds]));
  } catch {
    // not remembered: fine
  }
}

export function issueBadge(idx: IndexData, id: string, deep: boolean): GNode['badge'] {
  const list = issuesFor(idx, id, deep);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warnings = list.filter((i) => i.severity === 'warning').length;
  if (errors) return { count: errors, severity: 'error' };
  if (warnings) return { count: warnings, severity: 'warning' };
  return undefined;
}

export function edgeTitle(e: { kind: string; weight: number; evidence: Edge['evidence'] }, from: string, to: string): string {
  const ev = e.evidence.slice(0, 6).map((x) => `  ${x.at}${x.line ? `:${x.line}` : ''}  ${x.text}`).join('\n');
  return `${from} → ${to}\n${edgeKinds[e.kind]?.label ?? e.kind}${e.weight > 1 ? ` ×${e.weight}` : ''}\n${ev}`;
}

// ---------------------------------------------------------------------------------------------------------------

export function platformLevel(idx: IndexData, kinds: Set<string>): Level {
  const withCode = idx.repos.filter((r) => r.stats.files > 0);
  const rankOf = (layer: string): number => {
    const i = LAYER_ORDER.indexOf(layer);
    return i < 0 ? LAYER_ORDER.length : i;
  };
  const nodes: GNode[] = withCode.map((r) => ({
    id: r.id,
    label: r.name,
    sub: r.whatItIs ?? (r.packageName && r.packageName !== r.name ? r.packageName : clip(r.description ?? '', 36)),
    color: layerColor(idx, r.layer),
    rank: rankOf(r.layer),
    badge: issueBadge(idx, r.id, true),
  }));
  const edges: GEdge[] = idx.edges.filter((e) => kinds.has(e.kind)).map((e) => ({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, title: edgeTitle(e, e.from, e.to) }));
  const rankLabels = new Map<number, string>();
  for (const r of withCode) rankLabels.set(rankOf(r.layer), layerName(idx, r.layer));
  return { id: PLATFORM, kind: 'platform', title: 'Platform', nodes, edges, options: { rankLabels, maxPerRow: 7 }, zoomable: new Set(withCode.map((r) => r.id)) };
}

const KIND_RANK: Record<string, number> = { import: 0, reexport: 1, worker: 2, 'dynamic-import': 3, 'type-import': 4 };

/** A directory's children (folders and files), how they import each other, and what they use or are used by outside (dimmed). */
export function dirLevel(idx: IndexData, repo: RepoView, dirId: string): Level {
  const dir = repo.byId.get(dirId) as DirNode;
  const prefix = dir.path ? dir.path + '/' : '';
  const childDirs = repo.dirs.filter((d) => d.parent === dirId);
  const childFiles = repo.files.filter((f) => f.parent === dirId);
  const childOf = (fileId: string): string | undefined => {
    const f = repo.byId.get(fileId) as FileNode | undefined;
    if (!f || !f.path.startsWith(prefix)) return undefined;
    const rest = f.path.slice(prefix.length);
    return rest.includes('/') ? `${repo.repo}/${prefix}${rest.split('/')[0]}/` : f.id;
  };
  const outsideOf = (target: string): { id: string; label: string; target: string } | undefined => {
    const name = target.split(/[/#:]/)[0]!;
    if (target.startsWith('entry:')) {
      const e = idx.entries.find((x) => x.id === target);
      return e ? { id: `repo:${e.repo}`, label: e.repo, target: e.repo } : undefined;
    }
    if (target.startsWith('ext:') || target.startsWith('node:')) return undefined;
    if (name !== repo.repo) return { id: `repo:${name}`, label: name, target: name };
    const path = target.slice(name.length + 1);
    const top = path.includes('/') ? path.split('/')[0] + '/' : path;
    return { id: `${repo.repo}/${top}`, label: `${top} (outside)`, target: `${repo.repo}/${top}` };
  };
  const nodes = new Map<string, GNode>();
  const zoomable = new Set<string>();
  for (const d of childDirs) {
    nodes.set(d.id, { id: d.id, label: d.name + '/', sub: `${plural(d.files, 'file')}, ${d.loc.toLocaleString()} lines`, color: 'var(--primary)', badge: issueBadge(idx, d.id, true) });
    zoomable.add(d.id);
  }
  for (const f of childFiles) {
    nodes.set(f.id, { id: f.id, label: f.name, sub: `${f.role}, ${f.loc.toLocaleString()} lines`, color: f.role === 'src' ? 'var(--layer-kit)' : 'var(--text-3)', badge: issueBadge(idx, f.id, false) });
    if (f.symbols.length) zoomable.add(f.id);
  }
  const edges = new Map<string, { from: string; to: string; kind: string; weight: number; evidence: Edge['evidence'] }>();
  const add = (from: string, to: string, e: Edge): void => {
    if (from === to) return;
    const key = `${from}|${to}`;
    const cur = edges.get(key);
    if (!cur) edges.set(key, { from, to, kind: e.kind, weight: e.weight, evidence: [...e.evidence] });
    else {
      cur.weight += e.weight;
      if ((KIND_RANK[e.kind] ?? 9) < (KIND_RANK[cur.kind] ?? 9)) cur.kind = e.kind;
      if (cur.evidence.length < 12) cur.evidence.push(...e.evidence.slice(0, 2));
    }
  };
  const outside = (o: { id: string; label: string; target: string }): string => {
    if (!nodes.has(o.id)) {
      nodes.set(o.id, { id: o.id, label: o.label, href: nodeHref(o.target), target: o.target, muted: true, color: o.id.startsWith('repo:') ? layerColor(idx, idx.repos.find((r) => r.name === o.label)?.layer ?? '') : 'var(--text-3)' });
    }
    return o.id;
  };
  for (const e of [...repo.edges, ...repo.inbound]) {
    const from = childOf(e.from);
    const to = childOf(e.to);
    if (from && to) add(from, to, e);
    else if (from) {
      const o = outsideOf(e.to);
      if (o) add(from, outside(o), e);
    } else if (to) {
      const o = outsideOf(e.from);
      if (o) add(outside(o), to, e);
    }
  }
  const gEdges: GEdge[] = [...edges.values()].map((e) => ({ ...e, muted: !!nodes.get(e.from)?.muted || !!nodes.get(e.to)?.muted, title: edgeTitle(e, nodes.get(e.from)?.label ?? e.from, nodes.get(e.to)?.label ?? e.to) }));
  // Ranks: the children by their own imports, folded into at most five rows; what uses them from outside on a row
  // above, what they use outside on a row below.
  const inner = [...nodes.values()].filter((n) => !n.muted).map((n) => n.id);
  const innerSet = new Set(inner);
  const innerRanks = rankNodes(inner, gEdges.filter((e) => innerSet.has(e.from) && innerSet.has(e.to)));
  const deepest = Math.max(0, ...innerRanks.values());
  const ROWS = 5;
  const fold = (r: number): number => (deepest < ROWS ? r : Math.round((r * (ROWS - 1)) / deepest));
  const bottom = Math.min(deepest, ROWS - 1) + 2;
  const ranked = [...nodes.values()].map((n) => {
    if (!n.muted) return { ...n, rank: fold(innerRanks.get(n.id) ?? 0) + 1 };
    const usesUs = gEdges.some((e) => e.from === n.id);
    return { ...n, rank: usesUs ? 0 : bottom };
  });
  const isRoot = dir.path === '';
  return { id: isRoot ? repo.repo : dirId, kind: isRoot ? 'repo' : 'dir', title: isRoot ? repo.repo : dir.path + '/', nodes: ranked, edges: gEdges, options: { maxPerRow: 8 }, zoomable };
}

const SYMBOL_ORDER: Record<string, number> = { class: 0, function: 0, const: 1, let: 1, var: 1, default: 1, namespace: 1, interface: 2, type: 2, enum: 2 };
const MAX_USERS = 16;

/** A file's declarations, with the files that use each one above them. */
export function fileLevel(idx: IndexData, repo: RepoView, file: FileNode): Level {
  const symbols = file.symbols.map((id) => repo.byId.get(id) as SymbolNode).filter(Boolean);
  const nodes: GNode[] = symbols.map((s) => ({
    id: s.id,
    label: s.name,
    sub: `${s.exported ? 'export ' : ''}${s.symbolKind}${s.usedBy.length ? `, ${plural(s.usedBy.length, 'user')}` : ''}`,
    color: s.exported ? 'var(--syn-function)' : 'var(--text-3)',
    rank: 1 + (SYMBOL_ORDER[s.symbolKind] ?? 1),
  }));
  const users = new Map<string, number>();
  for (const s of symbols) for (const u of s.usedBy) users.set(u, (users.get(u) ?? 0) + 1);
  const top = [...users].sort((a, b) => b[1] - a[1]).slice(0, MAX_USERS).map(([u]) => u);
  const edges: GEdge[] = [];
  for (const u of top) {
    const name = u.split('/')[0]!;
    nodes.push({ id: u, label: u.split('/').pop()!, sub: name === file.repo ? u.slice(name.length + 1, u.lastIndexOf('/')) || '/' : name, muted: true, rank: 0, target: u, color: name === file.repo ? 'var(--layer-kit)' : layerColor(idx, idx.repos.find((r) => r.name === name)?.layer ?? '') });
    for (const s of symbols) if (s.usedBy.includes(u)) edges.push({ from: u, to: s.id, kind: 'import', weight: 1, title: `${u} imports ${s.name}`, muted: true });
  }
  return { id: file.id, kind: 'file', title: file.name, nodes, edges, options: { maxPerRow: 6 }, zoomable: new Set() };
}

// ---------------------------------------------------------------------------------------------------------------

/** The level ids from the platform down to the level that shows `id` (a symbol shows on its file's level). */
export function pathOf(idx: IndexData, id: string): string[] {
  if (!id || id.startsWith('entry:') || id.startsWith('ext:') || id.startsWith('node:')) return [PLATFORM];
  const repo = repoOf(idx, id);
  if (!repo) return [PLATFORM];
  const out = [PLATFORM, repo];
  const path = id.split('#')[0]!.slice(repo.length + 1);
  if (!path) return out;
  const segs = path.split('/');
  const isDir = path.endsWith('/');
  let acc = repo;
  segs.forEach((seg, i) => {
    if (!seg) return;
    acc = `${acc}/${seg}`;
    const last = i === segs.length - 1 || (isDir && i === segs.length - 2);
    out.push(last && !isDir ? acc : `${acc}/`);
  });
  return out;
}

const cache = new Map<string, Promise<Level | undefined>>();

/** The level with this id, or undefined when it has none (a symbol, an unknown id). Platform levels follow `kinds`. */
export function levelFor(idx: IndexData, id: string, kinds: Set<string>): Promise<Level | undefined> {
  if (id === PLATFORM) return Promise.resolve(platformLevel(idx, kinds));
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const name = repoOf(idx, id);
      if (!name || !idx.repos.find((r) => r.name === name)?.stats.files) return undefined;
      const repo = await loadRepo(name);
      if (id === name) return dirLevel(idx, repo, `${name}/`);
      const node = repo.byId.get(id);
      if (node?.kind === 'dir') return dirLevel(idx, repo, id);
      if (node?.kind === 'file') return node.symbols.length ? fileLevel(idx, repo, node) : undefined;
      return undefined;
    })();
    cache.set(id, p);
  }
  return p;
}
