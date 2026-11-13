// The pages: the platform, a repository, a directory, a file, a symbol, an entry point, an outside package.
import type { DirNode, Edge, EntryNode, ExternalNode, FileNode, IndexData, Issue, RepoNode, SymbolNode } from '../model.js';
import { edgeKinds, find, issuesFor, loadRepo, type RepoView } from './data.js';
import { code, h, link, nodeHref, plural } from './dom.js';
import { graphView, type GEdge, type GNode } from './graphview.js';
import { rankNodes } from './layout.js';

type El = HTMLElement;

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces

export const layerColor = (idx: IndexData, layer: string): string => `var(${idx.layers.find((l) => l.id === layer)?.color ?? '--text-3'})`;
const layerName = (idx: IndexData, layer: string): string => idx.layers.find((l) => l.id === layer)?.name ?? layer;

export function repoNode(idx: IndexData, name: string): RepoNode | undefined {
  return idx.repos.find((r) => r.name === name);
}

/** A GitHub link to a file (and line) at the analysed commit. */
export function sourceUrl(idx: IndexData, fileId: string, line?: number): string | undefined {
  const name = fileId.split('/')[0]!;
  const repo = repoNode(idx, name);
  if (!repo || fileId === name) return repo?.url;
  const path = fileId.slice(name.length + 1).split('#')[0]!;
  return `${repo.url}/blob/${repo.commit}/${path}${line ? `#L${line}` : ''}`;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, text.lastIndexOf(' ', max - 1) > 0 ? text.lastIndexOf(' ', max - 1) : max - 1) + '…');
const chip = (text: string, cls = '', style?: string): El => h('span', { class: `chip ${cls}`, style }, text);
const sevChip = (sev: string): El => chip(sev, `sev sev-${sev}`);

export function breadcrumbs(id: string, idx: IndexData): El {
  const parts: [string, string][] = [['#/', 'Platform']];
  if (id.startsWith('entry:')) {
    const e = idx.entries.find((x) => x.id === id);
    if (e) parts.push([nodeHref(e.repo), e.repo]);
  } else if (!id.startsWith('ext:') && !id.startsWith('node:')) {
    const [path, symbol] = id.split('#') as [string, string | undefined];
    const segs = path.split('/').filter(Boolean);
    let acc = '';
    segs.forEach((seg, i) => {
      acc = i === 0 ? seg : `${acc}/${seg}`;
      const isLast = i === segs.length - 1;
      const target = i === 0 ? seg : isLast && !path.endsWith('/') ? acc : `${acc}/`;
      parts.push([nodeHref(target), i === 0 ? seg : seg + (isLast && !path.endsWith('/') ? '' : '/')]);
    });
    if (symbol) parts.push([nodeHref(id), symbol]);
  }
  return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumbs' }, parts.map(([href, text], i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null, i === parts.length - 1 ? h('span', { 'aria-current': 'page' }, text) : h('a', { href }, text)]));
}

export function issueList(idx: IndexData, issues: Issue[], options: { showNode?: boolean; limit?: number } = {}): El {
  if (!issues.length) return h('p', { class: 'muted' }, 'No issues.');
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule));
  const limit = options.limit ?? 200;
  const list = h('ul', { class: 'issues' }, sorted.slice(0, limit).map((i) => issueItem(idx, i, options.showNode ?? true)));
  return h('div', null, list, sorted.length > limit ? h('p', { class: 'muted' }, `${sorted.length - limit} more: see `, h('a', { href: '#/issues' }, 'all issues'), '.') : null);
}

export function issueItem(idx: IndexData, i: Issue, showNode: boolean): El {
  return h('li', { class: `issue sev-${i.severity}` },
    h('div', { class: 'issue-head' }, sevChip(i.severity), h('a', { class: 'rule', href: `#/issues?rule=${encodeURIComponent(i.rule)}` }, i.rule), showNode ? link(i.node, i.node, { class: 'issue-node' }) : null),
    h('p', null, i.message),
    i.evidence?.length ? h('details', null, h('summary', null, plural(i.evidence.length, 'place')), h('ul', { class: 'evidence' }, i.evidence.map((ev) => {
      const url = sourceUrl(idx, ev.at, ev.line);
      return h('li', null, link(ev.at, `${ev.at}${ev.line ? `:${ev.line}` : ''}`), ' ', code(ev.text), url && ev.at.includes('/') ? h('a', { href: url, class: 'ext', target: '_blank', rel: 'noopener' }, 'source') : null);
    }))) : null,
    i.fix ? h('p', { class: 'fix' }, h('strong', null, 'Fix: '), i.fix) : null,
  );
}

function section(title: string, ...children: (El | El[] | null | false | undefined | string)[]): El {
  return h('section', { class: 'section' }, h('h2', null, title), ...children);
}

function issueBadge(idx: IndexData, id: string, deep: boolean): GNode['badge'] {
  const list = issuesFor(idx, id, deep);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warnings = list.filter((i) => i.severity === 'warning').length;
  if (errors) return { count: errors, severity: 'error' };
  if (warnings) return { count: warnings, severity: 'warning' };
  return undefined;
}

function edgeTitle(e: { kind: string; weight: number; evidence: Edge['evidence'] }, from: string, to: string): string {
  const ev = e.evidence.slice(0, 6).map((x) => `  ${x.at}${x.line ? `:${x.line}` : ''}  ${x.text}`).join('\n');
  return `${from} → ${to}\n${edgeKinds[e.kind]?.label ?? e.kind}${e.weight > 1 ? ` ×${e.weight}` : ''}\n${ev}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Platform

const LAYER_ORDER = ['tool', 'kit', 'language', 'family', 'plugin', 'engine', 'brand', 'other'];
const DEFAULT_KINDS = new Set(['import', 'npm', 'pin', 'runtime', 'worker']);

function savedKinds(): Set<string> {
  try {
    const raw = localStorage.getItem('arch.kinds');
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // storage unavailable: use the defaults
  }
  return new Set(DEFAULT_KINDS);
}

export function platformView(idx: IndexData): El {
  const kinds = savedKinds();
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of idx.issues) counts[i.severity]++;
  const withCode = idx.repos.filter((r) => r.stats.files > 0);
  const empty = idx.repos.filter((r) => r.stats.files === 0);
  const totalLoc = withCode.reduce((s, r) => s + r.stats.loc, 0);
  const totalFiles = withCode.reduce((s, r) => s + r.stats.files, 0);

  const graphHolder = h('div');
  const draw = (): void => {
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
    const merged = new Map<string, GEdge>();
    for (const e of idx.edges) {
      if (!kinds.has(e.kind)) continue;
      const key = `${e.from}|${e.to}|${e.kind}`;
      merged.set(key, { from: e.from, to: e.to, kind: e.kind, weight: e.weight, title: edgeTitle(e, e.from, e.to) });
    }
    const rankLabels = new Map<number, string>();
    for (const r of withCode) rankLabels.set(rankOf(r.layer), layerName(idx, r.layer));
    graphHolder.replaceChildren(graphView(nodes, [...merged.values()], { rankLabels, maxPerRow: 7 }));
  };
  draw();

  const kindsPresent = [...new Set(idx.edges.map((e) => e.kind))];
  const toggles = h('fieldset', { class: 'toggles' }, h('legend', null, 'Show links'), kindsPresent.map((k) => {
    const input = h('input', { type: 'checkbox', checked: kinds.has(k), onchange: () => {
      if (input.checked) kinds.add(k);
      else kinds.delete(k);
      try {
        localStorage.setItem('arch.kinds', JSON.stringify([...kinds]));
      } catch {
        // not remembered: fine
      }
      draw();
    } });
    return h('label', { class: `toggle edge-key edge-${k}`, title: edgeKinds[k]?.about ?? k }, input, h('span', { class: 'swatch', 'aria-hidden': 'true' }), edgeKinds[k]?.label ?? k);
  }));

  const layers = idx.layers.filter((l) => idx.repos.some((r) => r.layer === l.id)).sort((a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id));
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('h1', null, 'The platform'),
      h('p', { class: 'lede' }, `${plural(idx.repos.length, 'repository', 'repositories')} from ${new URL(idx.repos[0]?.url ?? 'https://github.com/').pathname.split('/')[1]}'s main branches: ${plural(totalFiles, 'file')}, ${plural(totalLoc, 'line')} of code, ${plural(idx.entries.length, 'entry point')}. Click a product to drill in; hover to trace its links.`),
      h('div', { class: 'stats' },
        h('a', { class: 'stat sev-error', href: '#/issues?severity=error' }, h('strong', null, String(counts.error)), ' errors'),
        h('a', { class: 'stat sev-warning', href: '#/issues?severity=warning' }, h('strong', null, String(counts.warning)), ' warnings'),
        h('a', { class: 'stat sev-info', href: '#/issues?severity=info' }, h('strong', null, String(counts.info)), ' info'),
        h('span', { class: 'stat muted' }, `Generated ${new Date(idx.generatedAt).toLocaleString()}`),
      ),
    ),
    toggles,
    graphHolder,
    section('Layers', h('div', { class: 'cards' }, layers.map((l) => h('div', { class: 'card', style: `--accent-bar:var(${l.color})` },
      h('h3', null, l.name), h('p', { class: 'muted' }, l.about),
      h('ul', { class: 'plain' }, idx.repos.filter((r) => r.layer === l.id).map((r) => h('li', null, link(r.id, r.name), ' ', h('span', { class: 'muted' }, r.whatItIs ?? r.description ?? (r.stats.files ? '' : 'no code yet')))))),
    ))),
    empty.length ? section('No code yet', h('p', { class: 'muted' }, empty.map((r, i) => [i ? ', ' : '', h('a', { href: r.url }, r.name)]))) : null,
    section('Errors', issueList(idx, idx.issues.filter((i) => i.severity === 'error'), { limit: 20 })),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Repository and directory: the children of a directory, and how they depend on each other and on the outside.

const KIND_RANK: Record<string, number> = { import: 0, reexport: 1, worker: 2, 'dynamic-import': 3, 'type-import': 4 };

export function childGraph(idx: IndexData, repo: RepoView, dirId: string): El {
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
  const outsideOf = (target: string): { id: string; label: string; href: string } | undefined => {
    const name = target.split(/[/#:]/)[0]!;
    if (target.startsWith('entry:')) {
      const e = idx.entries.find((x) => x.id === target);
      return e ? { id: `repo:${e.repo}`, label: e.repo, href: nodeHref(e.repo) } : undefined;
    }
    if (target.startsWith('ext:') || target.startsWith('node:')) return undefined;
    if (name !== repo.repo) return { id: `repo:${name}`, label: name, href: nodeHref(name) };
    const path = target.slice(name.length + 1);
    const top = path.includes('/') ? path.split('/')[0] + '/' : path;
    return { id: `${repo.repo}/${top}`, label: `${top} (outside)`, href: nodeHref(`${repo.repo}/${top}`) };
  };
  const nodes = new Map<string, GNode>();
  for (const d of childDirs) nodes.set(d.id, { id: d.id, label: d.name + '/', sub: `${plural(d.files, 'file')}, ${d.loc.toLocaleString()} lines`, color: 'var(--primary)', badge: issueBadge(idx, d.id, true) });
  for (const f of childFiles) nodes.set(f.id, { id: f.id, label: f.name, sub: `${f.role}, ${f.loc.toLocaleString()} lines`, color: f.role === 'src' ? 'var(--layer-kit)' : 'var(--text-3)', badge: issueBadge(idx, f.id, false) });
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
  const outside = (o: { id: string; label: string; href: string }): string => {
    if (!nodes.has(o.id)) nodes.set(o.id, { id: o.id, label: o.label, href: o.href, muted: true, color: o.id.startsWith('repo:') ? layerColor(idx, repoNode(idx, o.label)?.layer ?? '') : 'var(--text-3)' });
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
  if (!childDirs.length && !childFiles.length) return h('p', { class: 'muted' }, 'Empty.');
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
  return graphView(ranked, gEdges, { maxPerRow: 8 });
}

function fileTable(idx: IndexData, files: FileNode[]): El {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'files' },
    h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Role'), h('th', { class: 'num' }, 'Lines'), h('th', null, 'What it is'))),
    h('tbody', null, files.map((f) => {
      const issues = issuesFor(idx, f.id);
      return h('tr', null,
        h('td', null, link(f.id, f.path), f.tested === false ? h('span', { class: 'chip quiet', title: 'No test reaches this file through imports' }, 'untested') : null, issues.length ? chip(String(issues.length), `sev sev-${issues.some((i) => i.severity === 'error') ? 'error' : issues.some((i) => i.severity === 'warning') ? 'warning' : 'info'}`) : null),
        h('td', null, f.role), h('td', { class: 'num' }, f.loc.toLocaleString()), h('td', { class: 'muted' }, (f.doc ?? '').split('\n')[0]));
    })),
  ));
}

function edgeTable(idx: IndexData, edges: Edge[], side: 'from' | 'to'): El {
  if (!edges.length) return h('p', { class: 'muted' }, 'None.');
  return h('ul', { class: 'links' }, edges.map((e) => {
    const other = side === 'to' ? e.to : e.from;
    return h('li', null,
      h('span', { class: `edge-key edge-${e.kind}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' })),
      link(other, other), ' ', h('span', { class: 'muted' }, `${edgeKinds[e.kind]?.label ?? e.kind}${e.weight > 1 ? ` ×${e.weight}` : ''}`),
      h('details', null, h('summary', null, 'evidence'), h('ul', { class: 'evidence' }, e.evidence.map((ev) => {
        const url = ev.at.includes('/') ? sourceUrl(idx, ev.at, ev.line) : undefined;
        return h('li', null, ev.at.includes('/') ? link(ev.at, `${ev.at}${ev.line ? `:${ev.line}` : ''}`) : ev.at, ' ', code(ev.text), url ? h('a', { href: url, class: 'ext', target: '_blank', rel: 'noopener' }, 'source') : null);
      }))));
  }));
}

export async function repoView(idx: IndexData, r: RepoNode): Promise<El> {
  if (r.stats.files === 0) {
    return h('div', { class: 'page' }, breadcrumbs(r.id, idx), h('h1', null, r.name), h('p', null, 'No code yet. ', h('a', { href: r.url }, 'Repository')));
  }
  const repo = await loadRepo(r.name);
  const entries = idx.entries.filter((e) => e.repo === r.name);
  const out = idx.edges.filter((e) => e.from === r.name);
  const into = idx.edges.filter((e) => e.to === r.name);
  const roles = Object.entries(r.stats.byRole).map(([role, s]) => `${role} ${s!.files}`).join(' · ');
  return h('div', { class: 'page' },
    breadcrumbs(r.id, idx),
    h('header', { class: 'page-head' },
      h('h1', null, r.name, ' ', chip(layerName(idx, r.layer), 'layer', `--chip:${layerColor(idx, r.layer)}`), r.plugin ? chip('plugin', 'quiet') : null),
      h('p', { class: 'lede' }, r.intent?.summary ?? r.positioning ?? r.description ?? ''),
      r.readme && r.readme !== r.description && r.readme !== r.positioning && r.readme !== r.intent?.summary ? h('p', null, r.readme) : null,
      h('p', { class: 'meta' },
        r.packageName ? [code(`${r.packageName}${r.version ? '@' + r.version : ''}`), ' · '] : null,
        `${plural(r.stats.files, 'file')} (${roles}) · ${r.stats.loc.toLocaleString()} lines · ${plural(r.stats.exported, 'export')} · `,
        h('a', { href: `${r.url}/tree/${r.commit}`, target: '_blank', rel: 'noopener' }, `GitHub @ ${r.commit.slice(0, 7)}`),
        r.docsUrl ? [' · ', h('a', { href: r.docsUrl, target: '_blank', rel: 'noopener' }, 'Docs')] : null,
        ...r.agentFiles.map((f) => [' · ', h('a', { href: `${r.url}/blob/${r.commit}/${f}`, target: '_blank', rel: 'noopener' }, f)]),
        ' · ', h('a', { href: `md/${r.name}.md` }, 'as Markdown'),
      ),
    ),
    r.intent?.responsibilities?.length ? section('Responsibilities', h('ul', null, r.intent.responsibilities.map((x) => h('li', null, x)))) : null,
    r.intent?.runtime?.length ? section('Runtime wiring', h('ul', null, r.intent.runtime.map((x) => h('li', null, link(x.from), ' → ', link(x.to), ': ', x.note)))) : null,
    section('Structure', h('p', { class: 'muted' }, 'Top-level folders and files, how they import each other, and what they use outside (dimmed). Click to drill in.'), childGraph(idx, repo, `${r.name}/`)),
    entries.length ? section('Entry points', h('p', { class: 'muted' }, 'What other code may import (package.json exports).'), h('ul', { class: 'entries' }, entries.map((e) => h('li', null, link(e.id, e.name), ' ', h('span', { class: 'muted' }, `${plural(e.api.length, 'export')}${e.file ? ` · from ${e.file.slice(r.name.length + 1)}` : ' · source not found'}`))))) : null,
    h('div', { class: 'two' },
      section('Depends on', edgeTable(idx, out, 'to')),
      section('Used by', edgeTable(idx, into, 'from')),
    ),
    r.dependencies.length ? section('Declared dependencies', h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Package'), h('th', null, 'Version or pin'), h('th', null, 'Kind'), h('th', null, 'Family'))),
      h('tbody', null, r.dependencies.map((d) => h('tr', null,
        h('td', null, d.repo ? link(d.repo, d.name) : link(`ext:${d.name}`, d.name)), h('td', null, code(d.ref ? d.ref.slice(0, 7) : d.spec)),
        h('td', null, d.source === 'packed.json' ? 'packed.json' : d.dev ? 'dev' : 'runtime'), h('td', null, d.repo ?? (d.family ? 'yes' : '—')))))))) : null,
    r.adrs.length ? section('Decisions', h('ul', { class: 'plain' }, r.adrs.map((a) => h('li', null, h('a', { href: `${r.url}/blob/${r.commit}/${a.path}`, target: '_blank', rel: 'noopener' }, `ADR ${a.number}`), ' ', a.title, a.status ? [' ', chip(a.status, 'quiet')] : null)))) : null,
    section('Issues', issueList(idx, idx.issues.filter((i) => i.node === r.id || i.node.startsWith(r.name + '/') || idx.entries.find((e) => e.id === i.node)?.repo === r.name), { limit: 60 })),
  );
}

export function dirView(idx: IndexData, repo: RepoView, d: DirNode): El {
  const files = repo.files.filter((f) => f.path.startsWith(d.path + '/'));
  const direct = repo.files.filter((f) => f.parent === d.id);
  return h('div', { class: 'page' },
    breadcrumbs(d.id, idx),
    h('header', { class: 'page-head' }, h('h1', null, d.path + '/'), h('p', { class: 'meta' }, `${plural(d.files, 'file')} · ${d.loc.toLocaleString()} lines · `, h('a', { href: `${repoNode(idx, d.repo)!.url}/tree/${repoNode(idx, d.repo)!.commit}/${d.path}`, target: '_blank', rel: 'noopener' }, 'GitHub'))),
    section('Structure', childGraph(idx, repo, d.id)),
    direct.length ? section('Files here', fileTable(idx, direct)) : null,
    section('Issues', issueList(idx, idx.issues.filter((i) => i.node.startsWith(d.id)), { limit: 60 })),
    files.length > direct.length ? section('All files below', fileTable(idx, files)) : null,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// File, symbol, entry point, outside package

export function fileView(idx: IndexData, repo: RepoView, f: FileNode): El {
  const r = repoNode(idx, f.repo)!;
  const importers = [...repo.edges, ...repo.inbound].filter((e) => e.to === f.id);
  const imports = repo.edges.filter((e) => e.from === f.id);
  const label = (id: string): string => (id.startsWith('ext:') ? id.slice(4) : id.startsWith('entry:') ? id.slice(6) : id.split('/').pop() || id);
  const where = (id: string): string | undefined => {
    if (id.startsWith('ext:') || id.startsWith('node:') || id.startsWith('entry:')) return undefined;
    const dir = id.slice(0, id.lastIndexOf('/'));
    return dir.startsWith(f.repo + '/') || dir === f.repo ? dir.slice(f.repo.length + 1) || '/' : dir;
  };
  const colorOf = (id: string): string => {
    const name = id.split('/')[0]!;
    return id.startsWith('ext:') || id.startsWith('node:') ? 'var(--text-3)' : name === f.repo ? 'var(--layer-kit)' : layerColor(idx, repoNode(idx, name)?.layer ?? '');
  };
  const nodes: GNode[] = [{ id: f.id, label: f.name, sub: `${f.loc} lines`, color: 'var(--accent)', rank: 1 }];
  const gEdges: GEdge[] = [];
  const LIMIT = 24;
  for (const e of importers.slice(0, LIMIT)) {
    if (!nodes.some((n) => n.id === e.from)) nodes.push({ id: e.from, label: label(e.from), sub: where(e.from), rank: 0, color: colorOf(e.from) });
    gEdges.push({ from: e.from, to: f.id, kind: e.kind, weight: e.weight, title: edgeTitle(e, e.from, f.id) });
  }
  for (const e of imports.slice(0, LIMIT)) {
    if (!nodes.some((n) => n.id === e.to)) nodes.push({ id: e.to, label: label(e.to), sub: where(e.to), rank: 2, color: colorOf(e.to), muted: e.to.startsWith('ext:') || e.to.startsWith('node:') });
    gEdges.push({ from: f.id, to: e.to, kind: e.kind, weight: e.weight, title: edgeTitle(e, f.id, e.to) });
  }
  const symbols = f.symbols.map((id) => repo.byId.get(id) as SymbolNode);
  return h('div', { class: 'page' },
    breadcrumbs(f.id, idx),
    h('header', { class: 'page-head' },
      h('h1', null, f.path, ' ', chip(f.role, 'quiet'), f.tested === false ? chip('untested', 'quiet') : null),
      h('p', { class: 'meta' }, `${f.loc.toLocaleString()} lines · ${plural(symbols.length, 'declaration')} · `, h('a', { href: sourceUrl(idx, f.id), target: '_blank', rel: 'noopener' }, `GitHub @ ${r.commit.slice(0, 7)}`), ' · ', h('a', { href: `md/${f.repo}/${f.path}.md` }, 'as Markdown')),
      f.doc ? h('div', { class: 'doc' }, f.doc) : null,
      f.parseError ? h('p', { class: 'muted' }, f.parseError) : null,
    ),
    importers.length + imports.length ? section('Neighbours', h('p', { class: 'muted' }, `Imported by ${importers.length} (top), imports ${imports.length} (bottom)${importers.length > LIMIT || imports.length > LIMIT ? `; the first ${LIMIT} of each are drawn` : ''}.`), graphView(nodes, gEdges, { maxPerRow: 5 })) : null,
    symbols.length ? section('Declarations', symbols.map((s) => symbolCard(idx, s, true))) : null,
    f.exports.some((x) => !x.symbol) ? section('Re-exports', h('ul', { class: 'plain' }, f.exports.filter((x) => !x.symbol).map((x) => h('li', null, code(x.name), x.from ? [' from ', link(x.from)] : null, x.typeOnly ? ' (type)' : '')))) : null,
    section('Imports', f.imports.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Line'), h('th', null, 'Module'), h('th', null, 'Resolves to'), h('th', null, 'Names'))),
      h('tbody', null, f.imports.map((i) => h('tr', null,
        h('td', { class: 'num' }, h('a', { href: sourceUrl(idx, f.id, i.line), target: '_blank', rel: 'noopener' }, String(i.line))),
        h('td', null, code(i.spec), i.kind !== 'import' ? [' ', chip(i.kind, 'quiet')] : null),
        h('td', null, i.targetFile ? link(i.targetFile) : i.target ? link(i.target) : h('span', { class: 'muted' }, 'unresolved')),
        h('td', { class: 'muted' }, i.names.map((n) => (n.imported === n.local ? n.imported : `${n.imported} as ${n.local}`)).join(', '))))))) : h('p', { class: 'muted' }, 'None.')),
    section('Imported by', importers.length ? h('ul', { class: 'plain' }, importers.map((e) => h('li', null, link(e.from), ' ', h('span', { class: 'muted' }, `${edgeKinds[e.kind]?.label ?? e.kind}, line ${e.evidence[0]?.line ?? '?'}`)))) : h('p', { class: 'muted' }, 'Nothing imports this file.')),
    section('Issues', issueList(idx, issuesFor(idx, f.id), { showNode: false })),
  );
}

function symbolCard(idx: IndexData, s: SymbolNode, compact: boolean): El {
  return h('article', { class: 'symbol', id: `sym-${s.name}` },
    h('div', { class: 'symbol-head' }, chip(s.symbolKind, 'kind'), compact ? link(s.id, s.name, { class: 'symbol-name' }) : h('span', { class: 'symbol-name' }, s.name), s.exported ? chip('exported', 'quiet') : null,
      h('a', { class: 'ext', href: sourceUrl(idx, s.file, s.line), target: '_blank', rel: 'noopener' }, `line ${s.line}`),
      s.usedBy.length ? h('span', { class: 'muted' }, ` · used by ${plural(s.usedBy.length, 'file')}`) : null),
    h('pre', { class: 'sig' }, h('code', null, s.signature)),
    s.doc ? h('div', { class: 'doc' }, s.doc) : null,
    s.members?.length ? h('details', { open: !compact }, h('summary', null, plural(s.members.length, 'member')), h('ul', { class: 'members' }, s.members.map((m) => h('li', null, h('code', null, `${m.static ? 'static ' : ''}${m.signature}`))))) : null,
  );
}

export function symbolView(idx: IndexData, s: SymbolNode): El {
  const offered = idx.entries.filter((e) => e.api.some((a) => a.symbol === s.id));
  const byRepo = new Map<string, string[]>();
  for (const f of s.usedBy) {
    const name = f.split('/')[0]!;
    byRepo.set(name, [...(byRepo.get(name) ?? []), f]);
  }
  return h('div', { class: 'page' },
    breadcrumbs(s.id, idx),
    h('header', { class: 'page-head' }, h('h1', null, s.name), h('p', { class: 'meta' }, `${s.symbolKind} in `, link(s.file), ` · lines ${s.line}–${s.endLine}`)),
    symbolCard(idx, s, false),
    offered.length ? section('Offered by', h('ul', { class: 'plain' }, offered.map((e) => h('li', null, link(e.id, e.name))))) : null,
    section('Used by', s.usedBy.length ? [...byRepo].map(([name, files]) => h('div', null, h('h3', null, link(name, name), ' ', h('span', { class: 'muted' }, String(files.length))), h('ul', { class: 'plain' }, files.map((f) => h('li', null, link(f)))))) : h('p', { class: 'muted' }, s.exported ? 'Nothing in the family imports it.' : 'Not exported.')),
  );
}

export async function entryView(idx: IndexData, e: EntryNode): Promise<El> {
  const repo = await loadRepo(e.repo);
  const consumers = e.file ? [...repo.inbound, ...repo.edges].filter((x) => x.to === e.file) : [];
  const byRepo = new Map<string, Edge[]>();
  for (const c of consumers) {
    const name = c.from.split('/')[0]!;
    byRepo.set(name, [...(byRepo.get(name) ?? []), c]);
  }
  return h('div', { class: 'page' },
    breadcrumbs(e.id, idx),
    h('header', { class: 'page-head' }, h('h1', null, code(e.name)), h('p', { class: 'meta' }, 'Entry point of ', link(e.repo), ` · built to `, code(e.target), e.file ? [' from ', link(e.file)] : ' · source file not found')),
    section(`API (${e.api.length})`, h('div', { class: 'table-wrap' }, h('table', { class: 'api' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Kind'), h('th', null, 'Signature'))),
      h('tbody', null, e.api.map((a) => h('tr', null, h('td', null, a.symbol ? link(a.symbol, a.name) : a.name, a.typeOnly ? [' ', chip('type', 'quiet')] : null), h('td', null, a.symbolKind), h('td', null, h('code', { class: 'sig-inline' }, a.signature)))))))),
    section('Imported by', consumers.length ? [...byRepo].map(([name, list]) => h('div', null, h('h3', null, link(name, name), ' ', h('span', { class: 'muted' }, String(list.length))), h('ul', { class: 'plain' }, list.map((c) => h('li', null, link(c.from), ' ', h('span', { class: 'muted' }, c.evidence[0] ? `line ${c.evidence[0].line}: ${c.evidence[0].text}` : '')))))) : h('p', { class: 'muted' }, 'Nothing in the family imports it.')),
    section('Issues', issueList(idx, issuesFor(idx, e.id), { showNode: false })),
  );
}

export async function externalView(idx: IndexData, x: ExternalNode): Promise<El> {
  const rows: El[] = [];
  for (const name of x.usedBy) {
    const repo = await loadRepo(name);
    const files = repo.edges.filter((e) => e.to === x.id);
    rows.push(h('div', null, h('h3', null, link(name, name), ' ', h('span', { class: 'muted' }, plural(files.length, 'file'))), h('ul', { class: 'plain' }, files.map((e) => h('li', null, link(e.from), ' ', h('span', { class: 'muted' }, e.evidence.map((v) => v.text).join(', ')))))));
  }
  const declared = idx.repos.flatMap((r) => r.dependencies.filter((d) => d.name === x.name).map((d) => ({ repo: r.name, d })));
  return h('div', { class: 'page' },
    breadcrumbs(x.id, idx),
    h('header', { class: 'page-head' }, h('h1', null, x.name, ' ', chip(x.builtin ? 'Node built-in' : 'outside the family', 'quiet'))),
    declared.length ? section('Declared by', h('ul', { class: 'plain' }, declared.map(({ repo, d }) => h('li', null, link(repo), ' ', code(d.spec), ' ', h('span', { class: 'muted' }, d.dev ? 'dev' : 'runtime'))))) : null,
    section('Imported by', rows),
    section('Issues', issueList(idx, idx.issues.filter((i) => i.related?.includes(x.id)))),
  );
}

export async function nodeView(idx: IndexData, id: string): Promise<El> {
  const found = await find(id);
  if (!found) return h('div', { class: 'page' }, breadcrumbs(id, idx), h('h1', null, 'Not found'), h('p', null, code(id), ' is not in this build. It may have been renamed or removed; try the search.'));
  switch (found.kind) {
    case 'repo': return repoView(idx, found.node);
    case 'entry': return entryView(idx, found.node);
    case 'external': return externalView(idx, found.node);
    case 'dir': return found.node.path ? dirView(idx, found.repo, found.node) : repoView(idx, repoNode(idx, found.node.repo)!);
    case 'file': return fileView(idx, found.repo, found.node);
    case 'symbol': return symbolView(idx, found.node);
  }
}
