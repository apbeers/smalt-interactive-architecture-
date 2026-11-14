// One file's imports, exports and top-level declarations, read from smaltty's syntax tree.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Member, SymbolKind } from '../model.js';

/** The part of smaltty's tree the analyzer reads (smaltty/src/tree.ts). */
export interface Tree {
  readonly text: string;
  readonly count: number;
  readonly root: number;
  readonly kind: Uint8Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly first: Int32Array;
  readonly next: Int32Array;
  readonly flags: Int32Array;
}

export interface Smaltty {
  parse(text: string, options?: { fileName?: string }): Tree;
  /** Which declaration each name means (smaltty/src/binder.ts). */
  bind?(tree: Tree): { readonly symbolOf: Int32Array; readonly top?: { readonly file: ReadonlyMap<string, number> } };
  /** TypeScript to JavaScript: types become spaces, so lines and columns stay put. */
  strip(text: string, options?: { fileName?: string }): string;
  readonly KIND_NAMES: readonly string[];
  readonly F: Readonly<Record<string, number>>;
}

/** Loads smaltty from its source checkout (Node strips the types; see scripts/ts-hook.mjs). */
export async function loadSmaltty(dir: string): Promise<Smaltty> {
  return (await import(pathToFileURL(join(dir, 'src/index.ts')).href)) as Smaltty;
}

export interface RawImport {
  readonly spec: string;
  readonly line: number;
  readonly kind: 'import' | 'type-import' | 'dynamic-import' | 'reexport' | 'worker';
  readonly names: { imported: string; local: string }[];
}

export interface RawExport {
  /** The exported name; `*` for `export * from`. */
  readonly name: string;
  /** The local declaration it names (`export { a as b }`, `export function a`). */
  readonly local?: string;
  /** For a re-export: the module and the name there (`*` for a namespace). */
  readonly from?: string;
  readonly imported?: string;
  readonly typeOnly: boolean;
}

export interface RawSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly line: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc?: string;
  readonly members?: Member[];
  /** Other top-level names of this file (its declarations and imports) that this declaration's body uses. */
  readonly refs?: string[];
}

export interface Extracted {
  readonly imports: RawImport[];
  readonly exports: RawExport[];
  readonly symbols: RawSymbol[];
  readonly doc?: string;
  readonly parseError?: string;
}

const SIGNATURE_MAX = 400;
const DOC_MAX = 700;

/** Lines of `text` start at these offsets. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Declaration text without comments or the export and declare keywords. */
const bare = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1').replace(/^\s*export\s+(default\s+)?/, '').replace(/^declare\s+/, '');

const squash = (s: string, max = SIGNATURE_MAX): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/** The JSDoc comment right before `offset`, as text without the stars. */
function docBefore(text: string, offset: number): string | undefined {
  let i = offset - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  if (i < 1 || text[i] !== '/' || text[i - 1] !== '*') return undefined;
  const open = text.lastIndexOf('/**', i - 1);
  if (open < 0) return undefined;
  const body = text.slice(open + 3, i - 1);
  if (body.includes('*/')) return undefined;
  return cleanComment(body);
}

function cleanComment(body: string): string | undefined {
  const lines = body.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd());
  const out = lines.join('\n').trim();
  if (!out) return undefined;
  return out.length > DOC_MAX ? out.slice(0, DOC_MAX - 1) + '…' : out;
}

/** The comment that opens a file: a block of `//` lines or one `/* … *\/`, before any code. */
export function fileDoc(text: string): string | undefined {
  let rest = text.replace(/^#![^\n]*\n/, '').replace(/^\s+/, '');
  if (rest.startsWith('/*')) {
    const end = rest.indexOf('*/');
    if (end < 0) return undefined;
    return cleanComment(rest.slice(2, end).replace(/^\*/, ''));
  }
  const lines: string[] = [];
  while (rest.startsWith('//')) {
    const nl = rest.indexOf('\n');
    const line = rest.slice(2, nl < 0 ? undefined : nl);
    if (line.startsWith('/') || line.startsWith(' @ts-') || line.startsWith(' eslint')) break;
    lines.push(line.replace(/^ /, ''));
    if (nl < 0) break;
    rest = rest.slice(nl + 1).replace(/^[ \t]+/, '');
  }
  return lines.length ? cleanComment(lines.join('\n')) : undefined;
}

/** The `<script>` blocks of a Vue file, with other lines blanked so line numbers stay the same. */
export function vueScript(text: string): string {
  const out = text.split('\n').map(() => '');
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const startLine = text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    m[1]!.split('\n').forEach((line, i) => {
      out[startLine + i] = (i === 0 ? ' '.repeat(0) : '') + line;
    });
  }
  return out.join('\n');
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]|import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Imports by pattern, for a file smaltty could not parse (JSX, or a syntax error). */
export function importsByPattern(text: string): RawImport[] {
  const starts = lineStarts(text);
  const out: RawImport[] = [];
  for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
    const spec = m[2] ?? m[3]!;
    const kind = m[3] ? 'dynamic-import' : m[1] ? 'type-import' : m[0].includes('export') ? 'reexport' : 'import';
    out.push({ spec, line: lineOf(starts, m.index), kind, names: [] });
  }
  IMPORT_RE.lastIndex = 0;
  return out;
}

export function extract(s: Smaltty, text: string, fileName: string): Extracted {
  const doc = fileDoc(text);
  let t: Tree;
  try {
    t = s.parse(text, { fileName: fileName.replace(/\.(vue|mjs|js|cjs|jsx)$/, '.ts') });
  } catch (e) {
    return { imports: importsByPattern(text), exports: [], symbols: [], doc, parseError: String((e as Error).message ?? e) };
  }
  return new Reader(s, t).read(doc);
}

class Reader {
  readonly s: Smaltty;
  readonly t: Tree;
  readonly text: string;
  readonly starts: number[];
  readonly imports: RawImport[] = [];
  readonly exports: RawExport[] = [];
  readonly symbols: RawSymbol[] = [];
  readonly F: Readonly<Record<string, number>>;
  /** Where each top-level declaration's text is, to find which one a reference sits in. */
  readonly ranges: { name: string; start: number; end: number }[] = [];

  constructor(s: Smaltty, t: Tree) {
    this.s = s;
    this.t = t;
    this.text = t.text;
    this.starts = lineStarts(t.text);
    this.F = s.F;
  }

  kind(n: number): string {
    return this.s.KIND_NAMES[this.t.kind[n]!] ?? '';
  }

  kids(n: number): number[] {
    const out: number[] = [];
    for (let c = this.t.first[n]!; c; c = this.t.next[c]!) out.push(c);
    return out;
  }

  src(n: number): string {
    return this.text.slice(this.t.start[n]!, this.t.end[n]!);
  }

  line(n: number): number {
    return lineOf(this.starts, this.t.start[n]!);
  }

  has(n: number, flag: string): boolean {
    return (this.t.flags[n]! & this.F[flag]!) !== 0;
  }

  str(n: number): string {
    return this.src(n).slice(1, -1);
  }

  read(doc: string | undefined): Extracted {
    for (const n of this.kids(this.t.root)) this.statement(n);
    this.scanCalls();
    const refs = this.references();
    const symbols = refs.size ? this.symbols.map((sym) => (refs.has(sym.name) ? { ...sym, refs: [...refs.get(sym.name)!] } : sym)) : this.symbols;
    return { imports: this.imports, exports: this.exports, symbols, doc };
  }

  /**
   * Per top-level declaration, the other top-level names its body uses, as smaltty's binder resolves them: a local that
   * shadows a top-level name is not a use of it.
   */
  references(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!this.s.bind || !this.ranges.length) return out;
    let b;
    try {
      b = this.s.bind(this.t);
    } catch {
      return out;
    }
    const top = b.top?.file;
    if (!top) return out;
    const ranges = [...this.ranges].sort((x, y) => x.start - y.start);
    const t = this.t;
    const ident = this.s.KIND_NAMES.indexOf('Identifier');
    for (let n = 1; n < t.count; n++) {
      if (t.kind[n] !== ident) continue;
      const sym = b.symbolOf[n]!;
      if (!sym) continue;
      const name = this.text.slice(t.start[n]!, t.end[n]!);
      if (top.get(name) !== sym) continue;
      const at = t.start[n]!;
      let lo = 0;
      let hi = ranges.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ranges[mid]!.start <= at) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const r = hit >= 0 ? ranges[hit] : undefined;
      if (!r || at >= r.end || r.name === name) continue;
      (out.get(r.name) ?? out.set(r.name, new Set()).get(r.name)!).add(name);
    }
    return out;
  }

  statement(n: number): void {
    const k = this.kind(n);
    if (k === 'ImportDeclaration') return this.importDeclaration(n);
    if (k === 'ExportDeclaration') return this.exportDeclaration(n);
    if (k === 'ExportAssignment') {
      const [value] = this.kids(n);
      const local = value && this.kind(value) === 'Identifier' ? this.src(value) : undefined;
      this.exports.push({ name: 'default', local: local ?? 'default', typeOnly: false });
      if (!local) {
        this.ranges.push({ name: 'default', start: this.t.start[n]!, end: this.t.end[n]! });
        this.symbols.push({ name: 'default', kind: 'default', exported: true, line: this.line(n), endLine: lineOf(this.starts, this.t.end[n]!), signature: squash(this.src(n), 160), doc: docBefore(this.text, this.t.start[n]!) });
      }
      return;
    }
    this.declaration(n, k);
  }

  importDeclaration(n: number): void {
    const kids = this.kids(n);
    const specNode = kids[kids.length - 1]!;
    const clause = kids.find((c) => this.kind(c) === 'ImportClause');
    const typeOnly = clause !== undefined && this.has(clause, 'TypeOnly');
    const names: { imported: string; local: string }[] = [];
    let allTypes = typeOnly;
    if (clause) {
      let anyValue = false;
      for (const c of this.kids(clause)) {
        const ck = this.kind(c);
        if (ck === 'Identifier') {
          names.push({ imported: 'default', local: this.src(c) });
          anyValue = true;
        } else if (ck === 'NamespaceImport') {
          names.push({ imported: '*', local: this.src(this.kids(c)[0]!) });
          anyValue = true;
        } else if (ck === 'NamedImports') {
          for (const spec of this.kids(c)) {
            const ids = this.kids(spec);
            names.push({ imported: this.src(ids[0]!), local: this.src(ids[ids.length - 1]!) });
            if (!this.has(spec, 'TypeOnly')) anyValue = true;
          }
        }
      }
      if (!anyValue && names.length) allTypes = true;
    }
    this.imports.push({ spec: this.str(specNode), line: this.line(n), kind: allTypes ? 'type-import' : 'import', names });
  }

  exportDeclaration(n: number): void {
    const typeOnly = this.has(n, 'TypeOnly');
    const kids = this.kids(n);
    const last = kids[kids.length - 1];
    const from = last && this.kind(last) === 'StringLiteral' ? this.str(last) : undefined;
    const named = kids.find((c) => this.kind(c) === 'NamedExports');
    const ns = kids.find((c) => this.kind(c) === 'NamespaceExport');
    const names: { imported: string; local: string }[] = [];
    if (named) {
      for (const spec of this.kids(named)) {
        const ids = this.kids(spec);
        const inner = this.src(ids[0]!);
        const outer = this.src(ids[ids.length - 1]!);
        const specType = typeOnly || this.has(spec, 'TypeOnly');
        if (from) {
          this.exports.push({ name: outer, from, imported: inner, typeOnly: specType });
          names.push({ imported: inner, local: outer });
        } else {
          this.exports.push({ name: outer, local: inner, typeOnly: specType });
        }
      }
    } else if (ns && from) {
      const name = this.src(this.kids(ns)[0]!);
      this.exports.push({ name, from, imported: '*', typeOnly });
      names.push({ imported: '*', local: name });
    } else if (from) {
      this.exports.push({ name: '*', from, imported: '*', typeOnly });
      names.push({ imported: '*', local: '*' });
    }
    if (from) this.imports.push({ spec: from, line: this.line(n), kind: typeOnly ? 'type-import' : 'reexport', names });
  }

  declaration(n: number, k: string): void {
    const exported = this.has(n, 'Export');
    const isDefault = this.has(n, 'Default');
    const doc = docBefore(this.text, this.t.start[n]!);
    const push = (name: string, kind: SymbolKind, signature: string, members?: Member[]): void => {
      this.symbols.push({ name, kind, exported, line: this.line(n), endLine: lineOf(this.starts, this.t.end[n]!), signature, doc, members });
      this.ranges.push({ name, start: this.t.start[n]!, end: this.t.end[n]! });
      if (exported) this.exports.push({ name: isDefault ? 'default' : name, local: name, typeOnly: kind === 'interface' || kind === 'type' });
    };
    const nameOf = (): string | undefined => {
      const id = this.kids(n).find((c) => this.kind(c) === 'Identifier');
      return id ? this.src(id) : undefined;
    };
    switch (k) {
      case 'FunctionDeclaration': {
        const name = nameOf() ?? 'default';
        // Overloads repeat the name: keep the first, which documents the call.
        if (this.symbols.some((s) => s.name === name && s.kind === 'function')) return;
        push(name, 'function', this.header(n));
        return;
      }
      case 'ClassDeclaration':
        push(nameOf() ?? 'default', 'class', this.classHeader(n), this.members(n));
        return;
      case 'InterfaceDeclaration':
        push(nameOf()!, 'interface', squash(bare(this.src(n))), this.members(n));
        return;
      case 'TypeAliasDeclaration':
        push(nameOf()!, 'type', squash(bare(this.src(n))));
        return;
      case 'EnumDeclaration':
        push(nameOf()!, 'enum', squash(bare(this.src(n))));
        return;
      case 'ModuleDeclaration':
        push(nameOf() ?? this.src(this.kids(n)[0]!), 'namespace', squash(bare(this.src(n).split('{')[0]!)));
        return;
      case 'VariableStatement': {
        const list = this.kids(n).find((c) => this.kind(c) === 'VariableDeclarationList');
        if (!list) return;
        const kind: SymbolKind = this.has(list, 'Const') ? 'const' : this.has(list, 'Let') ? 'let' : 'var';
        for (const decl of this.kids(list)) {
          const [id, ...rest] = this.kids(decl);
          if (!id || this.kind(id) !== 'Identifier') continue;
          const name = this.src(id);
          const init = rest[rest.length - 1];
          let signature: string;
          if (init && (this.kind(init) === 'ArrowFunction' || this.kind(init) === 'FunctionExpression')) {
            signature = `${kind} ${name} = ${this.header(init)}`;
          } else {
            const text = this.src(decl);
            const eq = topLevelEquals(text);
            signature = `${kind} ${eq < 0 ? text : text.slice(0, eq).trim() + ' = ' + text.slice(eq + 1).trim()}`;
            signature = squash(signature, 200);
          }
          push(name, kind, squash(signature));
        }
        return;
      }
    }
  }

  /** A function's text up to its body. */
  header(n: number): string {
    const kids = this.kids(n);
    const body = kids[kids.length - 1];
    let text = this.src(n);
    if (body && (this.kind(body) === 'Block' || this.kind(n) === 'ArrowFunction')) {
      text = this.text.slice(this.t.start[n]!, this.t.start[body]!).replace(/\s*(=>)?\s*$/, (m, arrow) => (arrow ? ' => …' : ''));
    }
    return squash(text.replace(/^export\s+(default\s+)?/, '').replace(/^declare\s+/, ''));
  }

  classHeader(n: number): string {
    const text = this.src(n);
    const brace = text.indexOf('{');
    return squash(bare(brace < 0 ? text : text.slice(0, brace)));
  }

  members(n: number): Member[] {
    const out: Member[] = [];
    let body = n;
    for (const c of this.kids(n)) {
      const ck = this.kind(c);
      if (ck === 'TypeLiteral' || ck === 'InterfaceBody') body = c;
    }
    for (const c of this.kids(body)) {
      const ck = this.kind(c);
      if (!/Declaration$|Signature$|Accessor$|^Constructor$/.test(ck) || ck === 'HeritageClause') continue;
      if (this.has(c, 'Private') || this.has(c, 'Protected')) continue;
      const nameNode = this.kids(c).find((x) => /Identifier$|Literal$|ComputedPropertyName/.test(this.kind(x)));
      const name = ck === 'Constructor' ? 'constructor' : nameNode ? this.src(nameNode) : '';
      if (!name || name.startsWith('#')) continue;
      const kids = this.kids(c);
      const last = kids[kids.length - 1];
      const end = last && this.kind(last) === 'Block' ? this.t.start[last]! : this.t.end[c]!;
      let signature = this.text.slice(this.t.start[c]!, end);
      if (ck === 'PropertyDeclaration') signature = signature.split(/\s=\s/)[0]!;
      out.push({ name, kind: ck.replace(/Declaration$|Signature$/, '').toLowerCase(), signature: squash(bare(signature).replace(/;\s*$/, ''), 240), line: this.line(c), static: this.has(c, 'Static') });
    }
    return out;
  }

  /** Dynamic imports and workers, anywhere in the file: one pass over the flat tree. */
  scanCalls(): void {
    const t = this.t;
    const names = this.s.KIND_NAMES;
    for (let n = 1; n < t.count; n++) {
      const k = names[t.kind[n]!];
      if (k === 'CallExpression') {
        const callee = t.first[n]!;
        if (!callee || names[t.kind[callee]!] !== 'ImportKeyword') continue;
        const arg = t.next[callee]!;
        if (arg && names[t.kind[arg]!] === 'StringLiteral') {
          this.imports.push({ spec: this.str(arg), line: this.line(n), kind: 'dynamic-import', names: [] });
        }
      } else if (k === 'NewExpression') {
        const callee = t.first[n]!;
        if (!callee || !/^(Shared)?Worker$/.test(this.src(callee))) continue;
        const arg = t.next[callee]!;
        if (!arg || names[t.kind[arg]!] !== 'NewExpression' || this.src(t.first[arg]!) !== 'URL') continue;
        const url = t.next[t.first[arg]!]!;
        if (url && names[t.kind[url]!] === 'StringLiteral') {
          this.imports.push({ spec: this.str(url), line: this.line(n), kind: 'worker', names: [] });
        }
      }
    }
  }
}

/** The `=` of `name: Type = value`, outside brackets. */
function topLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '<' || c === '{' || c === '[') depth++;
    else if (c === ')' || (c === '>' && text[i - 1] !== '=') || c === '}' || c === ']') depth--;
    else if (c === '=' && depth === 0 && text[i + 1] !== '>' && text[i + 1] !== '=') return i;
  }
  return -1;
}
