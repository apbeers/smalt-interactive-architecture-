import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, fileDoc, importsByPattern, vueScript } from '../src/analyze/extract.js';
import { smaltty } from './helpers.js';

const SOURCE = `// What this file is for.
// Second line.
import { a, type B } from './a.js';
import type { C } from './c.js';
import D, * as NS from 'pkg';
export * from './all.js';
export { x as y } from './x.js';
export type { T } from './t.js';

/** Opens it. */
export async function open(name: string, options: Options = {}): Promise<Db> {
  return new Db();
}
export function open(name: number): void;

export class Db extends Base implements I {
  #secret = 1;
  private hidden = 2;
  /** Rows. */
  readonly rows: number = 0;
  static make(a: A): Db { return new Db(); }
  get size(): number { return 1; }
}

export interface Options {
  /** Where. */
  readonly path?: string;
  run(sql: string): void;
}
export type Mode = 'a' | 'b';
export const helper = (n: number): number => n + 1;
const local = 3;
export { local as renamed };
export default Db;

const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const lazy = await import('./lazy.js');
`;

test('imports, with names and kinds', async () => {
  const x = extract(await smaltty(), SOURCE, 'a.ts');
  const by = Object.fromEntries(x.imports.map((i) => [i.spec, i]));
  assert.equal(by['./a.js']!.kind, 'import');
  assert.equal(by['./c.js']!.kind, 'type-import');
  assert.deepEqual(by['pkg']!.names, [{ imported: 'default', local: 'D' }, { imported: '*', local: 'NS' }]);
  assert.equal(by['./all.js']!.kind, 'reexport');
  assert.equal(by['./t.js']!.kind, 'type-import');
  assert.equal(by['./worker.js']!.kind, 'worker');
  assert.equal(by['./lazy.js']!.kind, 'dynamic-import');
});

test('exports, local and re-exported', async () => {
  const x = extract(await smaltty(), SOURCE, 'a.ts');
  const names = x.exports.map((e) => e.name);
  for (const n of ['*', 'y', 'T', 'open', 'Db', 'Options', 'Mode', 'helper', 'renamed', 'default']) assert.ok(names.includes(n), n);
  assert.deepEqual(x.exports.find((e) => e.name === 'y'), { name: 'y', from: './x.js', imported: 'x', typeOnly: false });
  assert.equal(x.exports.find((e) => e.name === 'renamed')!.local, 'local');
  assert.equal(x.exports.find((e) => e.name === 'default')!.local, 'Db');
});

test('declarations: signatures without bodies, docs, public members', async () => {
  const x = extract(await smaltty(), SOURCE, 'a.ts');
  const s = Object.fromEntries(x.symbols.map((d) => [d.name, d]));
  assert.equal(s.open!.signature, 'async function open(name: string, options: Options = {}): Promise<Db>');
  assert.equal(s.open!.doc, 'Opens it.');
  assert.equal(x.symbols.filter((d) => d.name === 'open').length, 1, 'overloads are one symbol');
  assert.equal(s.Db!.signature, 'class Db extends Base implements I');
  assert.deepEqual(s.Db!.members!.map((m) => m.name), ['rows', 'make', 'size']);
  assert.equal(s.Options!.signature, "interface Options { readonly path?: string; run(sql: string): void; }");
  assert.equal(s.helper!.signature, 'const helper = (n: number): number => …');
  assert.equal(s.local!.exported, false);
  assert.equal(x.doc, 'What this file is for.\nSecond line.');
});

test('a file smaltty cannot parse falls back to patterns', async () => {
  const x = extract(await smaltty(), "import a from './a.js';\nconst el = <div>{a}</div>;\n", 'x.tsx');
  assert.ok(x.parseError);
  assert.deepEqual(x.imports.map((i) => i.spec), ['./a.js']);
  assert.deepEqual(importsByPattern("export * from './b.js'; import('./c.js')").map((i) => [i.spec, i.kind]), [['./b.js', 'reexport'], ['./c.js', 'dynamic-import']]);
});

test('Vue script blocks keep their line numbers', () => {
  const v = vueScript('<template>\n<p/>\n</template>\n<script setup lang="ts">\nimport x from "./x.js";\n</script>\n');
  assert.equal(v.split('\n')[4], 'import x from "./x.js";');
  assert.equal(fileDoc('#!/usr/bin/env node\n/** Block doc. */\ncode();'), 'Block doc.');
});
