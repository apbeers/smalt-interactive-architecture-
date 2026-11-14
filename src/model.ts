// The architecture model: what the analyzer writes and the site, the query tool and agents read. A change that
// removes or renames a field raises SCHEMA_VERSION; adding a field does not.

export const SCHEMA_VERSION = 1;

export type Severity = 'error' | 'warning' | 'info';

/** Where a file sits in its repository, from its path. */
export type FileRole = 'src' | 'test' | 'bench' | 'script' | 'docs' | 'example';

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'namespace' | 'enum' | 'default';

/**
 * How one thing depends on another.
 * - npm: a runtime dependency in package.json; dev: a devDependency.
 * - pin: a dependency on a commit (`github:owner/repo#sha`) in package.json.
 * - packed: a commit pin in packed.json (installed by scripts/fetch-packed.mjs, for docs, tests and benchmarks).
 * - import, type-import, dynamic-import, reexport: what the code says. Between repositories, `import` is source code
 *   only; imports from tests, docs, benchmarks and scripts are `dev-import`.
 * - worker: `new Worker(new URL('./x.js', import.meta.url))`.
 * - runtime: wiring written down by hand in intent/<repo>.json, which code alone does not show.
 */
export type EdgeKind = 'npm' | 'dev' | 'pin' | 'packed' | 'import' | 'dev-import' | 'type-import' | 'dynamic-import' | 'reexport' | 'worker' | 'runtime';

export interface Evidence {
  /** Node id of the file (or repo) the evidence is in. */
  readonly at: string;
  readonly line?: number;
  readonly text: string;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** How many imports (or pins) the edge stands for. */
  weight: number;
  evidence: Evidence[];
}

export interface Issue {
  readonly id: string;
  readonly rule: string;
  readonly severity: Severity;
  /** The node the issue is about. */
  readonly node: string;
  readonly related?: string[];
  readonly message: string;
  readonly evidence?: Evidence[];
  /** What to do about it, when that is known. */
  readonly fix?: string;
}

export interface Layer {
  readonly id: string;
  readonly name: string;
  /** A brand token (`--layer-tool`), resolved by the site against smalt-brand's tokens.css. */
  readonly color: string;
  readonly about: string;
}

export interface Dependency {
  readonly name: string;
  readonly spec: string;
  readonly dev: boolean;
  /** A package of the family (one of the repositories mapped here). */
  readonly family: boolean;
  /** The repository it resolves to, when family. */
  readonly repo?: string;
  /** For a commit pin: the commit. */
  readonly ref?: string;
  /** Where it was found: package.json or packed.json. */
  readonly source: 'package.json' | 'packed.json';
  /** For a commit pin, from the pinned repository's history: when the commit was made. */
  refDate?: string;
  /** Commits on the pinned repository's main since the pinned commit. */
  behind?: number;
  /** Whether the pinned commit is on main's history (false: a branch commit). */
  onMain?: boolean;
}

export interface Adr {
  readonly number: string;
  readonly title: string;
  readonly path: string;
  readonly status?: string;
}

export interface RuntimeLink {
  readonly from: string;
  readonly to: string;
  readonly note: string;
}

/** A path through the code, step by step, for the trace view: written in intent files or found by the site. */
export interface Trace {
  readonly name: string;
  readonly about?: string;
  readonly steps: { node: string; note?: string }[];
  /** The repository whose intent file holds it. */
  repo?: string;
}

export interface Intent {
  readonly summary?: string;
  readonly traces?: Trace[];
  readonly responsibilities?: string[];
  readonly runtime?: RuntimeLink[];
  readonly notes?: string[];
}

export interface RepoNode {
  readonly id: string;
  readonly kind: 'repo';
  readonly name: string;
  readonly layer: string;
  readonly plugin: boolean;
  readonly url: string;
  readonly commit: string;
  readonly date: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly description?: string;
  /** From smalt-brand's family table, where the product has a column. */
  readonly whatItIs?: string;
  readonly positioning?: string;
  /** The README's first paragraph of prose. */
  readonly readme?: string;
  readonly docsUrl?: string;
  readonly dependencies: Dependency[];
  readonly adrs: Adr[];
  /** Instruction files for agents in the repository (CLAUDE.md, AGENTS.md). */
  readonly agentFiles: string[];
  readonly intent?: Intent;
  /** From git: commits on main, and the first and latest commit dates. */
  history?: { commits: number; first: string; last: string };
  readonly stats: { files: number; loc: number; byRole: Partial<Record<FileRole, { files: number; loc: number }>>; symbols: number; exported: number };
}

export interface ApiItem {
  readonly name: string;
  readonly symbolKind: SymbolKind | 'reexport' | 'unknown';
  /** The symbol's node id, when the analyzer followed the export to its declaration. */
  readonly symbol?: string;
  readonly signature: string;
  readonly typeOnly: boolean;
}

export interface EntryNode {
  readonly id: string;
  readonly kind: 'entry';
  readonly repo: string;
  /** The import path: `smaltdb/language`. */
  readonly name: string;
  /** The package.json exports key: `./language`. */
  readonly subpath: string;
  /** What package.json points at (built output). */
  readonly target: string;
  /** The source file it is built from, when found. */
  readonly file?: string;
  readonly api: ApiItem[];
}

export interface DirNode {
  readonly id: string;
  readonly kind: 'dir';
  readonly repo: string;
  readonly path: string;
  readonly name: string;
  readonly parent: string;
  files: number;
  loc: number;
}

export interface ImportRef {
  readonly spec: string;
  readonly line: number;
  readonly kind: 'import' | 'type-import' | 'dynamic-import' | 'reexport' | 'worker';
  /** Names brought in: `imported` as named in the target, `local` as named here (`*` for a namespace). */
  readonly names: { imported: string; local: string }[];
  /** A file id, an entry id, or an external id (`ext:hyparquet`, `node:fs`). Absent when unresolved. */
  target?: string;
  /** The file the import lands on, for an import of a family package's entry point. */
  targetFile?: string;
}

export interface FileNode {
  readonly id: string;
  readonly kind: 'file';
  readonly repo: string;
  readonly path: string;
  readonly name: string;
  readonly parent: string;
  readonly role: FileRole;
  readonly lang: string;
  readonly loc: number;
  /** The comment that opens the file, which in this family says what the file is for. */
  readonly doc?: string;
  readonly imports: ImportRef[];
  readonly symbols: string[];
  /** Names this file exports and where each comes from (a symbol id, or a re-export). */
  readonly exports: { name: string; symbol?: string; from?: string; typeOnly: boolean }[];
  /** From git: commits that changed the file, and lines added plus removed, over its history. */
  churn?: { commits: number; lines: number; last: string };
  /** Files (in any repository) that import this one. */
  dependents?: number;
  /** Change times reach: churn weighted by dependents. Where bugs tend to come from. */
  hotspot?: number;
  /** For a source file with declarations: whether a test reaches it through imports. */
  tested?: boolean;
  /** Set when smaltty could not parse the file. */
  readonly parseError?: string;
}

export interface Member {
  readonly name: string;
  readonly kind: string;
  readonly signature: string;
  readonly line: number;
  readonly static: boolean;
}

export interface SymbolNode {
  readonly id: string;
  readonly kind: 'symbol';
  readonly repo: string;
  readonly file: string;
  readonly name: string;
  readonly symbolKind: SymbolKind;
  readonly exported: boolean;
  readonly line: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc?: string;
  readonly members?: Member[];
  /** Files that import this symbol, directly or through re-exports and entry points. */
  usedBy: string[];
  /** Declarations (this file's or imported) that its body uses, as smaltty's binder resolves names. */
  calls?: string[];
}

export interface ExternalNode {
  readonly id: string;
  readonly kind: 'external';
  readonly name: string;
  readonly builtin: boolean;
  /** Repositories that use it. */
  usedBy: string[];
}

export interface Source {
  readonly repo: string;
  readonly commit: string;
  readonly date: string;
}

/** data/index.json: the platform level, small enough to load first. */
export interface IndexData {
  readonly schemaVersion: number;
  readonly title: string;
  readonly generatedAt: string;
  readonly siteUrl: string;
  readonly parser: { repo: string; ref: string };
  readonly layers: Layer[];
  readonly repos: RepoNode[];
  readonly entries: EntryNode[];
  readonly externals: ExternalNode[];
  /** Repo-to-repo edges: package.json, packed.json, and code imports summed per repository pair. */
  readonly edges: Edge[];
  readonly issues: Issue[];
  readonly rules: RuleInfo[];
  /** Named paths through the code, from intent files. */
  readonly traces: Trace[];
}

/** data/repo/<name>.json: one repository's directories, files, symbols and file-level edges. */
export interface RepoData {
  readonly schemaVersion: number;
  readonly repo: string;
  readonly dirs: DirNode[];
  readonly files: FileNode[];
  readonly symbols: SymbolNode[];
  /** File-to-file edges that start in this repository (including to other repositories' files). */
  readonly edges: Edge[];
  /** File-to-file edges from other repositories into this one. */
  readonly inbound: Edge[];
}

export interface RuleInfo {
  readonly id: string;
  readonly severity: Severity;
  readonly about: string;
  readonly source?: string;
  /** Repositories the rule applies to (`*` for all). */
  readonly repos: string;
}

/** `smaltdb` and `./language` → `smaltdb/language`. */
export const importPath = (packageName: string, subpath: string): string =>
  subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\//, '')}`;

export type AnyNode = RepoNode | EntryNode | DirNode | FileNode | SymbolNode | ExternalNode;

/** Node ids. Paths are repository-relative, with `/`. */
export const ids = {
  repo: (repo: string): string => repo,
  /** By import path: `entry:smaltdb/language`, `entry:@smaltdb/io`. */
  entry: (packageName: string, subpath: string): string => `entry:${importPath(packageName, subpath)}`,
  dir: (repo: string, path: string): string => (path ? `${repo}/${path}/` : `${repo}/`),
  file: (repo: string, path: string): string => `${repo}/${path}`,
  symbol: (file: string, name: string): string => `${file}#${name}`,
  external: (name: string): string => (name.startsWith('node:') ? name : `ext:${name}`),
};
