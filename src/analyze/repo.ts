// What a repository says about itself on disk: package.json, packed.json, tsconfig paths, ADRs, README, the files.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Adr, FileRole } from '../model.js';

export const CODE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'cache', '.git', '.work', '_site', 'out']);
/** Files bigger than this are listed but not parsed (generated tables, bundles). */
export const MAX_PARSE_BYTES = 600_000;

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  imports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface PackedEntry {
  readonly path?: string;
  readonly repo?: string;
  readonly ref?: string;
}

export interface RepoOnDisk {
  readonly name: string;
  readonly dir: string;
  readonly commit: string;
  readonly date: string;
  readonly pkg?: PackageJson;
  readonly pkgText?: string;
  readonly packed?: Record<string, PackedEntry>;
  readonly packedText?: string;
  /** tsconfig.json `paths`: import path → repository-relative file. */
  readonly tsPaths: Map<string, string>;
  /** tsconfig.json `paths` with one `*`: prefix, suffix → replacement with `*`. */
  readonly tsPathPatterns: { prefix: string; suffix: string; target: string }[];
  /** Every file in the repository (not only code), repository-relative. */
  readonly allFiles: Set<string>;
  readonly codeFiles: string[];
  readonly adrs: Adr[];
  readonly readme?: string;
  readonly docsUrl?: string;
  readonly agentFiles: string[];
}

function git(dir: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function readJson<T>(path: string): { value?: T; text?: string } {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  try {
    return { value: JSON.parse(stripJsonComments(text)) as T, text };
  } catch {
    return { text };
  }
}

/** JSON with comments and trailing commas (tsconfig), as plain JSON. */
export function stripJsonComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function walk(root: string, rel = '', out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.vitepress' && e.name !== '.github')) continue;
      walk(root, path, out);
    } else if (e.isFile()) out.push(path);
  }
  return out;
}

export function fileRole(path: string): FileRole {
  const top = path.split('/')[0]!;
  if (/(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 'test';
  if (top === 'bench' || top === 'benchmarks') return 'bench';
  if (top === 'scripts' || top === 'tools' || top === '.github' || /^[^/]+\.config\.[cm]?[jt]s$/.test(path)) return 'script';
  if (top === 'docs' || /(^|\/)\.?vitepress\//.test(path)) return 'docs';
  if (top === 'examples' || top === 'example' || top === 'fixtures' || top === 'exploration' || top === 'corpus') return 'example';
  return 'src';
}

function readAdrs(dir: string, files: Set<string>): Adr[] {
  const out: Adr[] = [];
  for (const path of [...files].sort()) {
    const m = /(?:^|\/)adr\/(\d{3,4})-[^/]+\.md$/.exec(path);
    if (!m) continue;
    const text = readFileSync(join(dir, path), 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/^ADR\s*\d+[:.\s-]*/i, '').trim() ?? path;
    const status = /^(?:\*\*)?Status(?:\*\*)?:?\s*(?:\*\*)?\s*([A-Za-z][\w ]*)/im.exec(text)?.[1] ?? /^##\s*Status\s*\n+\s*([A-Za-z][\w ]*)/im.exec(text)?.[1];
    out.push({ number: m[1]!, title, path, status: status?.trim() });
  }
  return out;
}

/** The README's first paragraph of prose: no headings, pictures, badges or HTML. */
export function readmeSummary(text: string): string | undefined {
  const paragraphs = text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/);
  for (const p of paragraphs) {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.some((l) => /^(#|<|!\[|\[!\[|\||>|-{3})/.test(l))) continue;
    // The family's tagline line ("Small. Alternative. Fast.") opens many READMEs: keep what follows it.
    let s = lines.join(' ').replace(/^\**Small\. Alternative\. [^.]+\.\**\s*/, '');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (s.length < 40 && /^(\*\*)?Small\. Alternative/.test(lines[0]!)) continue;
    if (s.length < 25) continue;
    return s.length > 600 ? s.slice(0, 599) + '…' : s;
  }
  return undefined;
}

function readTsPaths(dir: string): { exact: Map<string, string>; patterns: RepoOnDisk['tsPathPatterns'] } {
  const out = new Map<string, string>();
  const patterns: RepoOnDisk['tsPathPatterns'] = [];
  for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
    const { value } = readJson<{ compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } }>(join(dir, name));
    const paths = value?.compilerOptions?.paths;
    if (!paths) continue;
    for (const [key, targets] of Object.entries(paths)) {
      const target = targets[0];
      if (!target) continue;
      const clean = target.replace(/^\.\//, '');
      if (!key.includes('*')) {
        if (!out.has(key)) out.set(key, clean);
      } else if (!patterns.some((p) => p.prefix + '*' + p.suffix === key)) {
        const [prefix, suffix] = key.split('*') as [string, string];
        patterns.push({ prefix, suffix, target: clean });
      }
    }
  }
  return { exact: out, patterns };
}

export function readRepo(name: string, dir: string): RepoOnDisk {
  const all = walk(dir);
  const allFiles = new Set(all);
  const codeFiles = all.filter((f) => CODE_EXTENSIONS.test(f)).sort();
  const pkg = readJson<PackageJson>(join(dir, 'package.json'));
  const packed = readJson<Record<string, PackedEntry>>(join(dir, 'packed.json'));
  const readmeText = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const tsPaths = readTsPaths(dir);
  const docsUrl = pkg.value?.homepage ?? /\[Documentation\]\((https?:[^)]+)\)/.exec(readmeText)?.[1];
  return {
    name,
    dir,
    commit: git(dir, 'rev-parse', 'HEAD'),
    date: git(dir, 'log', '-1', '--format=%cI'),
    pkg: pkg.value,
    pkgText: pkg.text,
    packed: packed.value,
    packedText: packed.text,
    tsPaths: tsPaths.exact,
    tsPathPatterns: tsPaths.patterns,
    allFiles,
    codeFiles,
    adrs: readAdrs(dir, allFiles),
    readme: readmeSummary(readmeText),
    docsUrl,
    agentFiles: ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'].filter((f) => allFiles.has(f)),
  };
}

export function fileSize(dir: string, path: string): number {
  return statSync(join(dir, path)).size;
}

/** smalt-brand's family table: per product, a row value ("What it is", "Positioning"). */
export function readFamilyTable(brandDir: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const path = join(brandDir, 'BRAND.md');
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    if (!/^\|\s*\|\s*smaltdb\s*\|/.test(header)) continue;
    const products = header.split('|').slice(2, -1).map((c) => c.trim());
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith('|'); j++) {
      const cells = lines[j]!.split('|').slice(1, -1).map((c) => c.trim());
      const row = cells[0]!;
      products.forEach((p, k) => {
        const rec = out.get(p) ?? {};
        rec[row] = (cells[k + 1] ?? '').replace(/`/g, '');
        out.set(p, rec);
      });
    }
    break;
  }
  return out;
}

/** The line of `needle` in `text`, 1-based, or undefined. */
export function lineOfText(text: string | undefined, needle: string): number | undefined {
  if (!text) return undefined;
  const i = text.indexOf(needle);
  return i < 0 ? undefined : text.slice(0, i).split('\n').length;
}
