// The analyzer end to end over two small repositories: a kit and an app that uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildModel } from '../src/analyze/graph.js';
import { brokenLinks, globToRegExp, moduleMatches, runChecks, stronglyConnected } from '../src/checks/index.js';
import type { Config } from '../src/config.js';
import { smaltty, tree } from './helpers.js';

const root = tree({
  'kit/package.json': JSON.stringify({ name: '@fam/kit', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './extra': './dist/extra.js' }, dependencies: { leftpad: '1.0.0' } }),
  'kit/src/index.ts': "export { greet } from './greet.js';\nexport * from './types.js';\n",
  'kit/src/greet.ts': "/** Says hello. */\nexport function greet(name: string): string { return 'hi ' + name; }\nexport function unused(): void {}\n",
  'kit/src/types.ts': 'export interface Person { name: string }\n',
  'kit/src/extra.ts': "import { greet } from './greet.js';\nexport const loud = (n: string): string => greet(n).toUpperCase();\n",
  'kit/README.md': '# kit\n\nA kit that greets people, for the tests of the analyzer.\n\nSee [missing](./nope.md) and [here](./src/greet.ts).\n',
  'app/package.json': JSON.stringify({ name: 'app', dependencies: { '@fam/kit': 'github:fam/kit#0123456789abcdef' } }),
  'app/src/main.ts': "import { greet, type Person } from '@fam/kit';\nimport { gone } from '@fam/kit/gone';\nimport { b } from './b.js';\nimport { nothing } from './nothing.js';\nexport const run = (p: Person): string => greet(p.name) + b + gone + nothing;\n",
  'app/src/b.ts': "import { run } from './main.js';\nexport const b = typeof run;\n",
  'app/test/main.test.ts': "import { run } from '../src/main.js';\nrun({ name: 'x' });\n",
});

const config: Config = {
  title: 'test', siteUrl: 'https://example.invalid/', owner: 'fam', branch: 'main', parser: { repo: 'fam/smaltty', ref: 'x' },
  layers: [{ id: 'kit', name: 'Kits', color: '--layer-kit', about: '' }, { id: 'tool', name: 'Tools', color: '--layer-tool', about: '' }],
  repos: [{ name: 'kit', layer: 'kit' }, { name: 'app', layer: 'tool' }],
  rules: [{ id: 'app-no-kit-gone', repo: 'app', from: ['src/**'], forbid: ['@fam/kit/gone'], severity: 'error', why: 'Gone is gone.' }],
};

test('entry points, API, usage and edges', async () => {
  const model = buildModel(config, await smaltty(), { reposDir: root, intentDir: join(root, 'none') });
  const entry = model.entries.get('entry:@fam/kit')!;
  assert.equal(entry.file, 'kit/src/index.ts');
  assert.deepEqual(entry.api.map((a) => a.name), ['greet', 'Person']);
  assert.equal(entry.api[0]!.symbol, 'kit/src/greet.ts#greet');
  assert.equal(model.entries.get('entry:@fam/kit/extra')!.file, 'kit/src/extra.ts');
  const greet = model.symbols.get('kit/src/greet.ts#greet')!;
  assert.deepEqual(greet.usedBy.sort(), ['app/src/main.ts', 'kit/src/extra.ts']);
  assert.equal(greet.doc, 'Says hello.');
  const kinds = model.repoEdges.filter((e) => e.from === 'app' && e.to === 'kit').map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['import', 'pin']);
  assert.ok(model.externals.has('ext:leftpad') === false, 'declared but never imported');
});

test('checks find what is wrong, with evidence', async () => {
  const model = buildModel(config, await smaltty(), { reposDir: root, intentDir: join(root, 'none') });
  const issues = runChecks(model);
  const rules = (id: string) => issues.filter((i) => i.rule === id);
  assert.equal(rules('missing-export')[0]!.node, 'app/src/main.ts');
  assert.equal(rules('missing-export')[0]!.severity, 'error');
  assert.equal(rules('unresolved-import')[0]!.evidence![0]!.line, 4);
  assert.deepEqual(rules('file-cycle')[0]!.related, ['app/src/main.ts']);
  assert.equal(rules('app-no-kit-gone').length, 1);
  assert.match(rules('outside-code')[0]!.message, /leftpad/);
  assert.match(rules('unused-export').find((i) => i.node === 'kit/src/greet.ts')!.message, /unused/);
  assert.deepEqual(rules('broken-doc-link').map((i) => i.evidence![0]!.text), ['./nope.md']);
  assert.ok(rules('no-agent-file').length === 2);
  assert.equal(model.files.get('app/src/main.ts')!.tested, true);
  assert.equal(model.files.get('kit/src/extra.ts')!.tested, false);
});

test('patterns, globs and cycles', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(!globToRegExp('src/*').test('src/a/b.ts'));
  assert.ok(globToRegExp('smaltdb-*').test('smaltdb-io'));
  assert.ok(moduleMatches('@smaltdb/*', '@smaltdb/io/client'));
  assert.ok(moduleMatches('node:*', 'node:fs'));
  assert.ok(!moduleMatches('smaltql', 'smaltql-extra'));
  const sccs = stronglyConnected(['a', 'b', 'c', 'd'], (n) => ({ a: ['b'], b: ['c'], c: ['a'], d: [] } as Record<string, string[]>)[n]!);
  assert.deepEqual(sccs.find((s) => s.length > 1)!.sort(), ['a', 'b', 'c']);
  assert.deepEqual(brokenLinks(root, 'kit/README.md', new Set(['kit/README.md', 'kit/src/greet.ts'])).map((l) => l.link), ['./nope.md']);
});
