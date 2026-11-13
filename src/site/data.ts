// Loads the model's data files, each once.
import type { Edge, EntryNode, FileNode, IndexData, Issue, RepoData, RepoNode, SymbolNode, DirNode, ExternalNode } from '../model.js';

let index: Promise<IndexData> | undefined;
const repos = new Map<string, Promise<RepoData>>();
let search: Promise<string[][]> | undefined;

async function json<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const loadIndex = (): Promise<IndexData> => (index ??= json<IndexData>('data/index.json'));
export const loadSearch = (): Promise<string[][]> => (search ??= json<string[][]>('data/search.json'));
export function loadRepo(name: string): Promise<RepoData> {
  let p = repos.get(name);
  if (!p) {
    p = json<RepoData>(`data/repo/${name}.json`).then(withIndexes);
    repos.set(name, p);
  }
  return p;
}
export const loadJson = json;

export interface RepoView extends RepoData {
  readonly byId: Map<string, DirNode | FileNode | SymbolNode>;
}

function withIndexes(data: RepoData): RepoView {
  const byId = new Map<string, DirNode | FileNode | SymbolNode>();
  for (const d of data.dirs) byId.set(d.id, d);
  for (const f of data.files) byId.set(f.id, f);
  for (const s of data.symbols) byId.set(s.id, s);
  return { ...data, byId };
}

/** The repository a node id belongs to, from its shape. */
export function repoOf(idx: IndexData, id: string): string | undefined {
  if (id.startsWith('entry:')) return idx.entries.find((e) => e.id === id)?.repo;
  if (id.startsWith('ext:') || id.startsWith('node:')) return undefined;
  const name = id.split(/[/#]/)[0]!;
  return idx.repos.some((r) => r.name === name) ? name : undefined;
}

export type Found =
  | { kind: 'repo'; node: RepoNode }
  | { kind: 'entry'; node: EntryNode }
  | { kind: 'external'; node: ExternalNode }
  | { kind: 'dir'; node: DirNode; repo: RepoView }
  | { kind: 'file'; node: FileNode; repo: RepoView }
  | { kind: 'symbol'; node: SymbolNode; repo: RepoView };

export async function find(id: string): Promise<Found | undefined> {
  const idx = await loadIndex();
  const repoNode = idx.repos.find((r) => r.id === id);
  if (repoNode) return { kind: 'repo', node: repoNode };
  const entry = idx.entries.find((e) => e.id === id);
  if (entry) return { kind: 'entry', node: entry };
  const ext = idx.externals.find((e) => e.id === id);
  if (ext) return { kind: 'external', node: ext };
  const name = repoOf(idx, id);
  if (!name) return undefined;
  const repo = (await loadRepo(name)) as RepoView;
  const node = repo.byId.get(id);
  if (!node) return undefined;
  return { kind: node.kind, node, repo } as Found;
}

export function issuesFor(idx: IndexData, id: string, deep = false): Issue[] {
  return idx.issues.filter((i) => i.node === id || (deep && (i.node.startsWith(id) || i.node.startsWith(id + '/'))));
}

export const edgeKinds: Record<string, { label: string; about: string }> = {
  import: { label: 'Code import', about: 'Source code imports it' },
  'dev-import': { label: 'Test or docs import', about: 'Tests, docs, benchmarks or scripts import it' },
  'type-import': { label: 'Type import', about: 'Imports types only (gone at run time)' },
  'dynamic-import': { label: 'Dynamic import', about: 'import() at run time' },
  reexport: { label: 'Re-export', about: 'Re-exports from it' },
  worker: { label: 'Worker', about: 'Starts it as a Web Worker' },
  npm: { label: 'Runtime dependency', about: 'package.json dependencies' },
  dev: { label: 'Dev dependency', about: 'package.json devDependencies' },
  pin: { label: 'Commit pin', about: 'package.json github:owner/repo#commit' },
  packed: { label: 'packed.json pin', about: 'Pinned for docs, tests and benchmarks' },
  runtime: { label: 'Runtime wiring', about: 'Written down in intent/<repo>.json' },
};

export type { Edge };
