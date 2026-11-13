// Writes the model as the site's data files, and compares it with the previous build.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Model } from '../analyze/graph.js';
import { SCHEMA_VERSION, type Edge, type IndexData, type Issue, type RepoData, type RuleInfo } from '../model.js';

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

export function indexData(model: Model, issues: Issue[], rules: RuleInfo[], generatedAt: string): IndexData {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: model.config.title,
    generatedAt,
    siteUrl: model.config.siteUrl,
    parser: model.config.parser,
    layers: model.config.layers,
    repos: model.repos,
    entries: [...model.entries.values()],
    externals: [...model.externals.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: model.repoEdges,
    issues,
    rules,
  };
}

export function repoData(model: Model, repo: string): RepoData {
  const inRepo = (id: string): boolean => model.files.get(id)?.repo === repo;
  const edges: Edge[] = [];
  const inbound: Edge[] = [];
  for (const e of model.fileEdges) {
    if (inRepo(e.from)) edges.push(e);
    else {
      const toRepo = model.files.get(e.to)?.repo ?? model.entries.get(e.to)?.repo;
      if (toRepo === repo) inbound.push(e);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repo,
    dirs: [...model.dirs.values()].filter((d) => d.repo === repo),
    files: [...model.files.values()].filter((f) => f.repo === repo),
    symbols: [...model.symbols.values()].filter((s) => s.repo === repo),
    edges,
    inbound,
  };
}

/** Compact search rows: [id, name, kind, repo, detail]. */
export function searchRows(model: Model): string[][] {
  const rows: string[][] = [];
  for (const r of model.repos) rows.push([r.id, r.name, 'repo', r.name, r.whatItIs ?? r.description ?? '']);
  for (const e of model.entries.values()) rows.push([e.id, e.name, 'entry', e.repo, `${e.api.length} exports`]);
  for (const d of model.dirs.values()) if (d.path) rows.push([d.id, d.path + '/', 'dir', d.repo, `${d.files} files`]);
  for (const f of model.files.values()) rows.push([f.id, f.path, 'file', f.repo, f.role]);
  for (const s of model.symbols.values()) {
    if (!s.exported) continue;
    rows.push([s.id, s.name, 'symbol', s.repo, `${s.symbolKind} in ${model.files.get(s.file)!.path}`]);
  }
  return rows;
}

/** The public API per entry point: name → signature. What the next build compares with. */
export type ApiSnapshot = Record<string, Record<string, string>>;

export function apiSnapshot(model: Model): ApiSnapshot {
  const out: ApiSnapshot = {};
  for (const e of model.entries.values()) {
    const items: Record<string, string> = {};
    for (const item of e.api) items[item.name] = item.signature;
    out[e.id] = items;
  }
  return out;
}

export interface Changes {
  readonly from?: string;
  readonly to: string;
  readonly commits: { repo: string; before?: string; after: string }[];
  readonly api: { entry: string; added: string[]; removed: string[]; changed: { name: string; before: string; after: string }[] }[];
  readonly edges: { added: string[]; removed: string[] };
  readonly issues: { before: Record<string, number>; after: Record<string, number> };
}

export interface Previous {
  readonly index?: IndexData;
  readonly api?: ApiSnapshot;
  readonly history?: Changes[];
}

const edgeKey = (e: Edge): string => `${e.from} → ${e.to} (${e.kind})`;
const countBySeverity = (issues: Issue[]): Record<string, number> => {
  const out: Record<string, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity] = (out[i.severity] ?? 0) + 1;
  return out;
};

/** What changed since the previous build, and the issues that follow from API changes. */
export function compare(model: Model, issues: Issue[], api: ApiSnapshot, previous: Previous, generatedAt: string): { changes: Changes; apiIssues: Issue[] } {
  const apiIssues: Issue[] = [];
  const changesApi: Changes['api'] = [];
  if (previous.api) {
    for (const [entry, now] of Object.entries(api)) {
      const before = previous.api[entry];
      if (!before) continue;
      const added = Object.keys(now).filter((n) => !(n in before));
      const removed = Object.keys(before).filter((n) => !(n in now));
      const changed = Object.keys(now).filter((n) => n in before && before[n] !== now[n]).map((name) => ({ name, before: before[name]!, after: now[name]! }));
      if (!added.length && !removed.length && !changed.length) continue;
      changesApi.push({ entry, added, removed, changed });
      const e = model.entries.get(entry)!;
      const consumers = new Set<string>();
      for (const fe of model.fileEdges) if (fe.to === entry || (e.file && fe.to === e.file)) consumers.add(model.files.get(fe.from)?.repo ?? '');
      consumers.delete(e.repo);
      consumers.delete('');
      const who = consumers.size ? ` Used by ${[...consumers].join(', ')}.` : '';
      if (removed.length) {
        apiIssues.push({ id: `api-removed:${entry}`, rule: 'api-removed', severity: 'warning', node: entry, related: [...consumers], message: `${e.name} no longer exports ${removed.join(', ')}.${who}`, fix: 'Check each consumer before it moves its pin; say in the PR what consumers must change.' });
      }
      if (changed.length) {
        apiIssues.push({ id: `api-changed:${entry}`, rule: 'api-changed', severity: 'info', node: entry, related: [...consumers], message: `${changed.length} export${changed.length > 1 ? 's' : ''} of ${e.name} changed: ${changed.map((c) => c.name).slice(0, 10).join(', ')}.${who}`, evidence: changed.slice(0, 10).map((c) => ({ at: entry, text: `${c.name}: ${c.before} ⟶ ${c.after}` })) });
      }
    }
  }
  const nowEdges = new Set(model.repoEdges.map(edgeKey));
  const beforeEdges = new Set((previous.index?.edges ?? []).map(edgeKey));
  const beforeCommits = new Map((previous.index?.repos ?? []).map((r) => [r.name, r.commit]));
  const changes: Changes = {
    from: previous.index?.generatedAt,
    to: generatedAt,
    commits: model.repos.filter((r) => beforeCommits.get(r.name) !== r.commit).map((r) => ({ repo: r.name, before: beforeCommits.get(r.name), after: r.commit })),
    api: changesApi,
    edges: previous.index ? { added: [...nowEdges].filter((k) => !beforeEdges.has(k)), removed: [...beforeEdges].filter((k) => !nowEdges.has(k)) } : { added: [], removed: [] },
    issues: { before: countBySeverity(previous.index?.issues ?? []), after: countBySeverity([...issues, ...apiIssues]) },
  };
  return { changes, apiIssues };
}

/** The previous build's data, from a directory (data/ of a built site) or the live site's URL. */
export async function loadPrevious(where: string | undefined): Promise<Previous> {
  if (!where) return {};
  const read = async <T>(name: string): Promise<T | undefined> => {
    try {
      if (/^https?:/.test(where)) {
        const res = await fetch(new URL(`data/${name}`, where.endsWith('/') ? where : where + '/'));
        return res.ok ? ((await res.json()) as T) : undefined;
      }
      const { readFileSync } = await import('node:fs');
      return JSON.parse(readFileSync(join(where, name), 'utf8')) as T;
    } catch {
      return undefined;
    }
  };
  const [index, api, history] = await Promise.all([read<IndexData>('index.json'), read<ApiSnapshot>('api.json'), read<Changes[]>('history.json')]);
  if (index && index.schemaVersion !== SCHEMA_VERSION) return { history };
  return { index, api, history };
}
