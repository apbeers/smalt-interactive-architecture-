// Builds the model: every repository's entry points, directories, files and symbols, with imports resolved across
// repositories, and the edges between them.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { builtinModules } from 'node:module';
import type { Config } from '../config.js';
import {
  ids, importPath, type ApiItem, type Dependency, type DirNode, type Edge, type EdgeKind, type EntryNode, type Evidence,
  type ExternalNode, type FileNode, type ImportRef, type Intent, type Issue, type RepoNode, type SymbolNode,
} from '../model.js';
import { extract, vueScript, type Smaltty } from './extract.js';
import { fileRole, fileSize, lineOfText, MAX_PARSE_BYTES, readFamilyTable, readRepo, type RepoOnDisk } from './repo.js';

const BUILTINS = new Set(builtinModules);
const MAX_EVIDENCE = 25;

export interface PackageInfo {
  readonly name: string;
  readonly repo: string;
  /** exports key (`.`, `./language`) → built target and source file id. */
  readonly exports: Map<string, { target: string; file?: string }>;
}

export interface Model {
  readonly config: Config;
  readonly disk: Map<string, RepoOnDisk>;
  readonly repos: RepoNode[];
  readonly entries: Map<string, EntryNode>;
  readonly dirs: Map<string, DirNode>;
  readonly files: Map<string, FileNode>;
  readonly symbols: Map<string, SymbolNode>;
  readonly externals: Map<string, ExternalNode>;
  /** Package name (and aliases used in pins) → package. */
  readonly packages: Map<string, PackageInfo>;
  readonly fileEdges: Edge[];
  readonly repoEdges: Edge[];
  readonly issues: Issue[];
  /** Imports the analyzer could not resolve, by file: for the checks. */
  readonly unresolved: { file: string; ref: ImportRef }[];
  /** Imports of a family package by a path its exports map does not offer. */
  readonly deepImports: { file: string; ref: ImportRef; pkg: string }[];
}

/** `@scope/name/sub` → [`@scope/name`, `./sub`]. */
export function splitSpecifier(spec: string): [string, string] {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/');
  const rest = parts.slice(n).join('/');
  return [name, rest ? `./${rest}` : '.'];
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Prefer the source-like conditions: types point at declarations, which map back to src/ most often.
    const order = ['types', 'source', 'development', 'import', 'browser', 'module', 'default', 'node', 'require'];
    const keys = [...order.filter((k) => k in o), ...Object.keys(o).filter((k) => !order.includes(k))];
    return keys.flatMap((k) => exportTargets(o[k]));
  }
  return [];
}

/** The exports map as `subpath → targets`. */
function exportsMap(pkg: RepoOnDisk['pkg']): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!pkg) return out;
  const e = pkg.exports;
  if (e === undefined) {
    const main = pkg.types ?? pkg.module ?? pkg.main;
    if (main) out.set('.', [main]);
    return out;
  }
  if (typeof e === 'string' || Array.isArray(e)) {
    out.set('.', exportTargets(e));
    return out;
  }
  const o = e as Record<string, unknown>;
  if (Object.keys(o).some((k) => !k.startsWith('.'))) {
    out.set('.', exportTargets(o));
    return out;
  }
  for (const [k, v] of Object.entries(o)) if (k !== './package.json') out.set(k, exportTargets(v));
  return out;
}

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.vue'];

/** A repository-relative file for a path written without (or with a built) extension. */
function findFile(files: Set<string>, path: string): string | undefined {
  const clean = posix.normalize(path).replace(/^\.\//, '');
  if (clean.startsWith('..')) return undefined;
  const base = clean.replace(/\.d\.ts$/, '').replace(/\.(js|mjs|cjs|jsx|ts|mts|tsx)$/, '');
  const candidates = [clean, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => `${clean}/index${e}`)];
  if (clean.endsWith('.d.ts')) candidates.push(base + '.d.ts');
  return candidates.find((c) => files.has(c) && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/.test(c));
}

/** The source file a package.json export is built from. */
function entrySource(repo: RepoOnDisk, importName: string, targets: string[]): string | undefined {
  const fromPaths = repo.tsPaths.get(importName);
  if (fromPaths) {
    const f = findFile(repo.allFiles, fromPaths);
    if (f) return f;
  }
  for (const target of targets) {
    const t = target.replace(/^\.\//, '');
    const tries = [t, t.replace(/^dist\/types\//, 'src/'), t.replace(/^dist\//, 'src/'), t.replace(/^dist\/(types\/)?/, ''), t.replace(/^lib\//, 'src/')];
    for (const p of tries) {
      const f = findFile(repo.allFiles, p);
      if (f && !f.startsWith('dist/')) return f;
    }
  }
  // A bundle named after a source file (dist/smaltdb-worker.js → src/**/worker.ts).
  for (const target of targets) {
    const stem = posix.basename(target).replace(/\.(d\.ts|js|mjs|cjs)$/, '');
    const short = stem.replace(new RegExp(`^${posix.basename(importName.split('/')[0]!)}-?`), '') || 'index';
    const hits = [...repo.allFiles].filter((f) => f.startsWith('src/') && /\.(ts|js)$/.test(f) && posix.basename(f).replace(/\.(ts|js)$/, '') === short);
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

function countLoc(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n++;
  return n;
}

export function readIntent(dir: string, repo: string): Intent | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, `${repo}.json`), 'utf8')) as Intent;
  } catch {
    return undefined;
  }
}

export interface BuildOptions {
  readonly reposDir: string;
  readonly intentDir: string;
  readonly log?: (line: string) => void;
}

export function buildModel(config: Config, smaltty: Smaltty, options: BuildOptions): Model {
  const log = options.log ?? (() => {});
  const disk = new Map<string, RepoOnDisk>();
  for (const r of config.repos) disk.set(r.name, readRepo(r.name, join(options.reposDir, r.name)));
  const repoUrl = (name: string): string => `https://github.com/${config.owner}/${name}`;
  const familyRepoOf = new Map<string, string>(); // full "owner/repo" lowercased → repo name
  for (const r of config.repos) familyRepoOf.set(`${config.owner}/${r.name}`.toLowerCase(), r.name);

  // Packages: the name in package.json, plus any other name a pin uses for the same repository.
  const packages = new Map<string, PackageInfo>();
  for (const repo of disk.values()) {
    if (!repo.pkg?.name) continue;
    const exports = new Map<string, { target: string; file?: string }>();
    for (const [sub, targets] of exportsMap(repo.pkg)) {
      const file = entrySource(repo, importPath(repo.pkg.name, sub), targets);
      exports.set(sub, { target: targets[targets.length - 1] ?? '', file: file && ids.file(repo.name, file) });
    }
    packages.set(repo.pkg.name, { name: repo.pkg.name, repo: repo.name, exports });
  }
  const pinRepo = (spec: string): { repo: string; ref?: string } | undefined => {
    const m = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.+))?$/.exec(spec);
    if (!m || !spec.match(/github|^[\w.-]+\/[\w.-]+#/)) return undefined;
    const repo = familyRepoOf.get(m[1]!.toLowerCase());
    return repo ? { repo, ref: m[2] } : undefined;
  };
  for (const repo of disk.values()) {
    const deps = { ...repo.pkg?.dependencies, ...repo.pkg?.devDependencies, ...repo.pkg?.peerDependencies };
    for (const [name, spec] of Object.entries(deps)) {
      const pin = pinRepo(spec);
      if (pin && !packages.has(name)) {
        const real = [...packages.values()].find((p) => p.repo === pin.repo);
        if (real) packages.set(name, real);
      }
    }
    for (const [name, entry] of Object.entries(repo.packed ?? {})) {
      const target = entry.repo ? familyRepoOf.get(entry.repo.toLowerCase()) : undefined;
      if (target && !packages.has(name)) {
        const real = [...packages.values()].find((p) => p.repo === target);
        if (real) packages.set(name, real);
      }
    }
  }
  const familyRepoOfPackage = (name: string): string | undefined => packages.get(name)?.repo;

  // Repositories.
  const brandRepo = config.repos.find((r) => r.layer === 'brand');
  const family = brandRepo ? readFamilyTable(join(options.reposDir, brandRepo.name)) : new Map<string, Record<string, string>>();
  const repos: RepoNode[] = [];
  for (const rc of config.repos) {
    const d = disk.get(rc.name)!;
    const dependencies: Dependency[] = [];
    const addDeps = (deps: Record<string, string> | undefined, dev: boolean): void => {
      for (const [name, spec] of Object.entries(deps ?? {})) {
        const pin = pinRepo(spec);
        const repo = pin?.repo ?? familyRepoOfPackage(name);
        dependencies.push({ name, spec, dev, family: !!repo, repo, ref: pin?.ref, source: 'package.json' });
      }
    };
    addDeps(d.pkg?.dependencies, false);
    addDeps(d.pkg?.peerDependencies, false);
    addDeps(d.pkg?.devDependencies, true);
    for (const [name, entry] of Object.entries(d.packed ?? {})) {
      if (!entry.repo) continue;
      const repo = familyRepoOf.get(entry.repo.toLowerCase());
      dependencies.push({ name, spec: `${entry.repo}#${entry.ref ?? ''}`, dev: true, family: !!repo, repo, ref: entry.ref, source: 'packed.json' });
    }
    const brand = family.get(rc.name);
    repos.push({
      id: ids.repo(rc.name),
      kind: 'repo',
      name: rc.name,
      layer: rc.layer,
      plugin: !!rc.plugin,
      url: repoUrl(rc.name),
      commit: d.commit,
      date: d.date,
      packageName: d.pkg?.name,
      version: d.pkg?.version,
      description: d.pkg?.description,
      whatItIs: brand?.['What it is'],
      positioning: brand?.['Positioning'],
      readme: d.readme,
      docsUrl: d.docsUrl,
      dependencies,
      adrs: d.adrs,
      agentFiles: d.agentFiles,
      intent: readIntent(options.intentDir, rc.name),
      stats: { files: 0, loc: 0, byRole: {}, symbols: 0, exported: 0 },
    });
  }

  // Directories, files and symbols.
  const dirs = new Map<string, DirNode>();
  const files = new Map<string, FileNode>();
  const symbols = new Map<string, SymbolNode>();
  const ensureDir = (repo: string, path: string): DirNode => {
    const id = ids.dir(repo, path);
    let d = dirs.get(id);
    if (!d) {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const parent = path ? ensureDir(repo, parentPath).id : ids.repo(repo);
      d = { id, kind: 'dir', repo, path, name: path ? posix.basename(path) : repo, parent, files: 0, loc: 0 };
      dirs.set(id, d);
    }
    return d;
  };
  const rawExports = new Map<string, ReturnType<typeof extract>['exports']>();
  for (const repo of repos) {
    const d = disk.get(repo.name)!;
    ensureDir(repo.name, '');
    let parsed = 0;
    for (const path of d.codeFiles) {
      const id = ids.file(repo.name, path);
      const size = fileSize(d.dir, path);
      const raw = readFileSync(join(d.dir, path), 'utf8');
      const loc = countLoc(raw);
      const minified = raw.length > 2000 && raw.length / Math.max(1, raw.split('\n').length) > 300;
      const tooBig = size > MAX_PARSE_BYTES || minified;
      const text = path.endsWith('.vue') ? vueScript(raw) : raw;
      const x = tooBig
        ? { imports: [], exports: [], symbols: [], doc: undefined, parseError: minified ? 'not parsed: minified or generated' : `not parsed: ${Math.round(size / 1000)} kB` }
        : extract(smaltty, text, path);
      parsed++;
      const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const dir = ensureDir(repo.name, dirPath);
      const symbolIds: string[] = [];
      for (const s of x.symbols) {
        const sid = ids.symbol(id, s.name);
        if (symbols.has(sid)) continue;
        symbols.set(sid, { id: sid, kind: 'symbol', repo: repo.name, file: id, name: s.name, symbolKind: s.kind, exported: s.exported, line: s.line, endLine: s.endLine, signature: s.signature, doc: s.doc, members: s.members?.length ? s.members : undefined, usedBy: [] });
        symbolIds.push(sid);
      }
      rawExports.set(id, x.exports);
      files.set(id, {
        id, kind: 'file', repo: repo.name, path, name: posix.basename(path), parent: dir.id, role: fileRole(path),
        lang: posix.extname(path).slice(1), loc, doc: x.doc,
        imports: x.imports.map((i) => ({ spec: i.spec, line: i.line, kind: i.kind, names: i.names })),
        symbols: symbolIds, exports: [], parseError: x.parseError,
      });
      for (let p: DirNode | undefined = dir; p; p = dirs.get(p.parent)) {
        p.files++;
        p.loc += loc;
      }
      const role = fileRole(path);
      const byRole = (repo.stats.byRole[role] ??= { files: 0, loc: 0 });
      byRole.files++;
      byRole.loc += loc;
      repo.stats.files++;
      repo.stats.loc += loc;
      repo.stats.symbols += symbolIds.length;
      repo.stats.exported += x.symbols.filter((s) => s.exported).length;
    }
    log(`${repo.name.padEnd(20)} ${String(parsed).padStart(4)} files`);
  }

  const externals = new Map<string, ExternalNode>();
  const unresolved: Model['unresolved'] = [];
  const deepImports: Model['deepImports'] = [];

  /** Resolves an import in `file` to a file, an entry point or an external package. */
  const resolve = (file: FileNode, spec: string): { target?: string; targetFile?: string; deep?: string; asset?: boolean } => {
    const d = disk.get(file.repo)!;
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(file.path), spec);
      const clean = base.split('?')[0]!;
      const hit = findFile(d.allFiles, clean);
      if (hit) return { target: ids.file(file.repo, hit), targetFile: ids.file(file.repo, hit) };
      if (d.allFiles.has(posix.normalize(clean))) return { asset: true }; // css, json, wasm
      // A family package copied in at install time (`../vendor/smaltkit/engine.js`): its entry point.
      const vendored = /(?:^|\/)vendor\/((?:@[^/]+\/)?[^/]+)(?:\/(.+?))?(?:\.m?js)?$/.exec(clean);
      const vpkg = vendored ? packages.get(vendored[1]!) : undefined;
      if (vendored && vpkg) {
        const sub = vendored[2] && vendored[2] !== 'index' ? `./${vendored[2]}` : '.';
        const exp = vpkg.exports.get(sub);
        const entryId = ids.entry(vpkg.name, sub);
        if (exp) return { target: entries.has(entryId) ? entryId : exp.file, targetFile: exp.file };
        return { deep: vpkg.name };
      }
      // A built file next to the importer (`new Worker(new URL('./smaltdb-worker.js', …))`): the entry point built to it.
      const own = d.pkg?.name ? packages.get(d.pkg.name) : undefined;
      for (const [sub, exp] of own?.exports ?? []) {
        if (exp.file && posix.basename(exp.target) === posix.basename(clean)) {
          const entryId = ids.entry(own!.name, sub);
          return { target: entries.has(entryId) ? entryId : exp.file, targetFile: exp.file };
        }
      }
      return {};
    }
    if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]!)) return { target: ids.external(spec.startsWith('node:') ? spec.split('/')[0]! : `node:${spec.split('/')[0]}`) };
    if (spec.startsWith('#')) {
      const own = d.pkg?.imports?.[spec];
      const t = own ? exportTargets(own)[0] : undefined;
      const hit = t ? findFile(d.allFiles, t) : undefined;
      return hit ? { target: ids.file(file.repo, hit), targetFile: ids.file(file.repo, hit) } : {};
    }
    // tsconfig paths of the importing repository (`smaltdb/engine` → src/engine/index.ts in smaltdb itself;
    // `smaltdb-src/*` → node_modules/smaltdb/src/*, which is smaltdb's own src/).
    const own = d.tsPaths.get(spec);
    for (const p of d.tsPathPatterns) {
      if (!spec.startsWith(p.prefix) || !spec.endsWith(p.suffix) || spec.length < p.prefix.length + p.suffix.length) continue;
      const path = p.target.replace('*', spec.slice(p.prefix.length, spec.length - p.suffix.length));
      const nm = /^(?:\.\.\/)*node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(path);
      const repoName = nm ? packages.get(nm[1]!)?.repo : file.repo;
      const inRepo = nm ? nm[2]! : path;
      const hit = repoName ? findFile(disk.get(repoName)!.allFiles, inRepo) : undefined;
      if (hit) return { target: ids.file(repoName!, hit), targetFile: ids.file(repoName!, hit), deep: nm ? nm[1] : undefined };
    }
    const [name, sub] = splitSpecifier(spec);
    const pkg = packages.get(name);
    if (pkg) {
      const exp = pkg.exports.get(sub) ?? [...pkg.exports].find(([k]) => k.includes('*') && new RegExp(`^${k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)').replace('*', '(.*)')}$`).test(sub))?.[1];
      if (exp) {
        const entryId = ids.entry(pkg.name, sub);
        return { target: entries.has(entryId) ? entryId : exp.file, targetFile: exp.file };
      }
      // Not in the exports map: a deep import into the repository.
      const target = disk.get(pkg.repo)!;
      const hit = findFile(target.allFiles, sub.replace(/^\.\//, '')) ?? findFile(target.allFiles, sub.replace(/^\.\/dist\//, 'src/'));
      return { target: hit ? ids.file(pkg.repo, hit) : undefined, targetFile: hit ? ids.file(pkg.repo, hit) : undefined, deep: pkg.name };
    }
    if (own) {
      const hit = findFile(d.allFiles, own);
      if (hit) return { target: ids.file(file.repo, hit), targetFile: ids.file(file.repo, hit) };
    }
    if (/^(virtual:|~|@\/|@theme\/|\/@)/.test(spec)) return { asset: true };
    return { target: ids.external(name) };
  };

  // Entry points.
  const entries = new Map<string, EntryNode>();
  for (const pkg of new Set(packages.values())) {
    for (const [sub, exp] of pkg.exports) {
      const id = ids.entry(pkg.name, sub);
      entries.set(id, { id, kind: 'entry', repo: pkg.repo, name: importPath(pkg.name, sub), subpath: sub, target: exp.target, file: exp.file, api: [] });
    }
  }

  // Resolve every import.
  for (const file of files.values()) {
    for (const ref of file.imports) {
      const r = resolve(file, ref.spec);
      ref.target = r.target;
      ref.targetFile = r.targetFile;
      if (r.deep) deepImports.push({ file: file.id, ref, pkg: r.deep });
      if (!r.target && !r.asset && !r.deep && ref.spec.startsWith('.')) unresolved.push({ file: file.id, ref });
      if (r.target && (r.target.startsWith('ext:') || r.target.startsWith('node:'))) {
        let ext = externals.get(r.target);
        if (!ext) {
          ext = { id: r.target, kind: 'external', name: r.target.replace(/^ext:/, ''), builtin: r.target.startsWith('node:'), usedBy: [] };
          externals.set(r.target, ext);
        }
        if (!ext.usedBy.includes(file.repo)) ext.usedBy.push(file.repo);
      }
    }
  }

  // Exports, followed to their declarations.
  type Resolved = { symbol?: string; typeOnly: boolean; from?: string };
  const exportCache = new Map<string, Map<string, Resolved>>();
  const exportsOf = (fileId: string, seen = new Set<string>()): Map<string, Resolved> => {
    const cached = exportCache.get(fileId);
    if (cached) return cached;
    const out = new Map<string, Resolved>();
    const file = files.get(fileId);
    if (!file || seen.has(fileId)) return out;
    seen.add(fileId);
    const refFor = (spec: string): ImportRef | undefined => file.imports.find((i) => i.spec === spec && i.kind !== 'dynamic-import' && i.kind !== 'worker');
    const viaImport = (local: string): Resolved | undefined => {
      for (const ref of file.imports) {
        const n = ref.names.find((x) => x.local === local && ref.kind !== 'reexport');
        if (!n || !ref.targetFile) continue;
        if (n.imported === '*') return { typeOnly: ref.kind === 'type-import', from: ref.targetFile };
        const r = exportsOf(ref.targetFile, seen).get(n.imported);
        return r ? { ...r, typeOnly: r.typeOnly || ref.kind === 'type-import' } : { typeOnly: ref.kind === 'type-import', from: ref.targetFile };
      }
      return undefined;
    };
    for (const e of rawExports.get(fileId) ?? []) {
      if (e.from !== undefined) {
        const ref = refFor(e.from);
        const target = ref?.targetFile;
        if (e.name === '*') {
          if (!target) continue;
          for (const [name, r] of exportsOf(target, seen)) if (name !== 'default' && !out.has(name)) out.set(name, { ...r, typeOnly: r.typeOnly || e.typeOnly });
        } else if (e.imported === '*') {
          out.set(e.name, { typeOnly: e.typeOnly, from: target });
        } else {
          const r = target ? exportsOf(target, seen).get(e.imported!) : undefined;
          out.set(e.name, r ? { ...r, typeOnly: r.typeOnly || e.typeOnly } : { typeOnly: e.typeOnly, from: target });
        }
      } else {
        const local = e.local ?? e.name;
        const sid = ids.symbol(fileId, local);
        if (symbols.has(sid)) out.set(e.name, { symbol: sid, typeOnly: e.typeOnly });
        else out.set(e.name, viaImport(local) ?? { typeOnly: e.typeOnly });
      }
    }
    exportCache.set(fileId, out);
    return out;
  };
  for (const file of files.values()) {
    for (const [name, r] of exportsOf(file.id)) file.exports.push({ name, symbol: r.symbol, from: r.from, typeOnly: r.typeOnly });
  }
  for (const entry of entries.values()) {
    if (!entry.file) continue;
    for (const [name, r] of exportsOf(entry.file)) {
      const s = r.symbol ? symbols.get(r.symbol) : undefined;
      const item: ApiItem = { name, symbolKind: s ? s.symbolKind : r.from ? 'reexport' : 'unknown', symbol: r.symbol, signature: s?.signature ?? (r.from ? `* from ${r.from}` : ''), typeOnly: r.typeOnly };
      entry.api.push(item);
    }
    entry.api.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Who uses each symbol: imports followed through re-exports and entry points.
  for (const file of files.values()) {
    for (const ref of file.imports) {
      if (!ref.targetFile || ref.kind === 'reexport') continue;
      const table = exportsOf(ref.targetFile);
      for (const n of ref.names) {
        if (n.imported === '*') continue;
        const sid = table.get(n.imported)?.symbol;
        const s = sid ? symbols.get(sid) : undefined;
        if (s && s.file !== file.id && !s.usedBy.includes(file.id)) s.usedBy.push(file.id);
      }
    }
  }

  // File-level edges.
  const fileEdges: Edge[] = [];
  const edgeIndex = new Map<string, Edge>();
  const addEdge = (list: Edge[], index: Map<string, Edge>, from: string, to: string, kind: EdgeKind, evidence: Evidence): void => {
    const key = `${from}|${to}|${kind}`;
    let e = index.get(key);
    if (!e) {
      e = { from, to, kind, weight: 0, evidence: [] };
      index.set(key, e);
      list.push(e);
    }
    e.weight++;
    if (e.evidence.length < MAX_EVIDENCE) e.evidence.push(evidence);
  };
  for (const file of files.values()) {
    for (const ref of file.imports) {
      const to = ref.targetFile ?? ref.target;
      if (!to || to === file.id) continue;
      const kind: EdgeKind = ref.kind;
      addEdge(fileEdges, edgeIndex, file.id, to, kind, { at: file.id, line: ref.line, text: ref.spec });
    }
  }

  // Repository-level edges: declared dependencies, then code.
  const repoEdges: Edge[] = [];
  const repoIndex = new Map<string, Edge>();
  for (const repo of repos) {
    const d = disk.get(repo.name)!;
    for (const dep of repo.dependencies) {
      if (!dep.repo || dep.repo === repo.name) continue;
      const kind: EdgeKind = dep.source === 'packed.json' ? 'packed' : dep.ref ? 'pin' : dep.dev ? 'dev' : 'npm';
      const text = dep.source === 'packed.json' ? d.packedText : d.pkgText;
      addEdge(repoEdges, repoIndex, repo.id, dep.repo, kind, { at: repo.id, line: lineOfText(text, `"${dep.name}"`), text: `${dep.source}: "${dep.name}": "${dep.spec}"` });
    }
  }
  for (const e of fileEdges) {
    const from = files.get(e.from);
    const toRepo = files.get(e.to)?.repo ?? entries.get(e.to)?.repo;
    if (!from || !toRepo || toRepo === from.repo) continue;
    const kind: EdgeKind = from.role === 'src' ? 'import' : 'dev-import';
    for (const ev of e.evidence) addEdge(repoEdges, repoIndex, from.repo, toRepo, kind, ev);
    const added = repoIndex.get(`${from.repo}|${toRepo}|${kind}`)!;
    added.weight += e.weight - Math.min(e.weight, e.evidence.length);
  }
  for (const repo of repos) {
    for (const link of repo.intent?.runtime ?? []) {
      const toRepo = link.to.split(/[/:#]/)[0]!;
      const fromRepo = link.from.split(/[/:#]/)[0]!;
      if (fromRepo !== toRepo) addEdge(repoEdges, repoIndex, fromRepo, toRepo, 'runtime', { at: repo.id, text: link.note });
    }
  }

  return { config, disk, repos, entries, dirs, files, symbols, externals, packages, fileEdges, repoEdges, issues: [], unresolved, deepImports };
}
