// The checks: rules run over the model. Each issue names the node it is about, says what is wrong in the family's
// words, and carries the evidence (file and line) so a person or an agent can go straight to it.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { BoundaryRule } from '../config.js';
import { splitSpecifier, type Model } from '../analyze/graph.js';
import { ids, type Evidence, type FileNode, type Issue, type RuleInfo, type Severity } from '../model.js';

const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);

/** `src/**` → a RegExp over repository-relative paths; `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A module pattern (`@smaltdb/*`, `node:*`) against an import specifier: `*` matches anything. */
export function moduleMatches(pattern: string, spec: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(spec) || re.test(splitSpecifier(spec)[0]);
}

export const BUILT_IN_RULES: RuleInfo[] = [
  { id: 'pin-behind-main', severity: 'warning', repos: '*', about: 'A commit pin (package.json or packed.json) that is not the head of the pinned repository\'s main branch.' },
  { id: 'pins-disagree', severity: 'warning', repos: '*', about: 'Consumers pin the same repository at different commits, so they build against different code.' },
  { id: 'missing-export', severity: 'error', repos: '*', about: 'An import of a family package by a path that the package\'s main does not export and that does not exist there.' },
  { id: 'deep-import', severity: 'warning', repos: '*', about: 'An import that reaches into another repository\'s files instead of an entry point in its exports map.' },
  { id: 'outside-code', severity: 'warning', repos: '*', about: 'Code from outside the family that ships: a runtime dependency, or a package imported by source files. Allowed in plugins; elsewhere the owner approves it (CLAUDE.md, "Ask before adding outside code").' },
  { id: 'file-cycle', severity: 'warning', repos: '*', about: 'Source files that import each other in a cycle (type-only and dynamic imports left out).' },
  { id: 'repo-cycle', severity: 'warning', repos: '*', about: 'Repositories whose source code depends on each other in a cycle.' },
  { id: 'unresolved-import', severity: 'warning', repos: '*', about: 'A relative import whose file does not exist.' },
  { id: 'broken-doc-link', severity: 'warning', repos: '*', about: 'A relative link in Markdown to a file that does not exist.' },
  { id: 'unused-export', severity: 'info', repos: '*', about: 'Exported from a source file, but nothing in the family imports it and no entry point offers it.' },
  { id: 'untested', severity: 'info', repos: '*', about: 'Source files that no test reaches through imports.' },
  { id: 'no-agent-file', severity: 'info', repos: '*', about: 'A repository with code and no CLAUDE.md or AGENTS.md for agents.' },
  { id: 'not-parsed', severity: 'info', repos: '*', about: 'A file smaltty did not parse (too big, generated, or a syntax it does not read yet); its imports were read by pattern.' },
  { id: 'stale-intent', severity: 'warning', repos: '*', about: 'intent/<repo>.json names a node that no longer exists.' },
  { id: 'api-removed', severity: 'warning', repos: '*', about: 'An export of an entry point that the previous build had and this one does not: a breaking change for its consumers.' },
  { id: 'api-changed', severity: 'info', repos: '*', about: 'An export of an entry point whose signature changed since the previous build.' },
];

export function ruleInfos(model: Model): RuleInfo[] {
  return [
    ...BUILT_IN_RULES,
    ...model.config.rules.map((r) => ({ id: r.id, severity: r.severity, repos: r.repo, about: r.why, source: r.source })),
  ];
}

class Issues {
  readonly list: Issue[] = [];
  readonly counts = new Map<string, number>();
  add(rule: string, severity: Severity, node: string, message: string, extra: { related?: string[]; evidence?: Evidence[]; fix?: string } = {}): void {
    const n = (this.counts.get(rule) ?? 0) + 1;
    this.counts.set(rule, n);
    this.list.push({ id: `${rule}:${node}:${n}`, rule, severity, node, message, ...extra });
  }
}

export function runChecks(model: Model): Issue[] {
  const out = new Issues();
  const files = [...model.files.values()];
  const repoByName = new Map(model.repos.map((r) => [r.name, r]));
  const fileRepoOfTarget = (id: string | undefined): string | undefined => (id ? model.files.get(id)?.repo ?? model.entries.get(id)?.repo : undefined);
  const isSrc = (f: FileNode | undefined): boolean => f?.role === 'src';

  // Pins.
  const pinsByTarget = new Map<string, { from: string; ref: string; name: string; source: string }[]>();
  for (const repo of model.repos) {
    for (const dep of repo.dependencies) {
      if (!dep.repo || !dep.ref || dep.repo === repo.name) continue;
      const target = repoByName.get(dep.repo);
      if (!target) continue;
      const list = pinsByTarget.get(dep.repo) ?? [];
      list.push({ from: repo.name, ref: dep.ref, name: dep.name, source: dep.source });
      pinsByTarget.set(dep.repo, list);
      if (!target.commit.startsWith(dep.ref) && !dep.ref.startsWith(target.commit)) {
        out.add('pin-behind-main', 'warning', repo.id, `${dep.source} pins ${dep.name} at ${short(dep.ref)}; ${dep.repo}'s main is at ${short(target.commit)}.`, {
          related: [target.id],
          evidence: [{ at: repo.id, text: `${dep.source}: ${dep.name} → ${dep.spec}` }],
          fix: `Bump the pin to ${target.commit} after checking that ${repo.name} still builds and passes against it.`,
        });
      }
    }
  }
  for (const [target, pins] of pinsByTarget) {
    const byRef = new Map<string, string[]>();
    for (const p of pins) byRef.set(short(p.ref), [...(byRef.get(short(p.ref)) ?? []), p.from]);
    if (byRef.size < 2) continue;
    const head = short(repoByName.get(target)?.commit);
    const groups = [...byRef].map(([ref, from]) => `${ref}${ref === head ? ' (main)' : ''}: ${[...new Set(from)].join(', ')}`);
    out.add('pins-disagree', 'warning', ids.repo(target), `${byRef.size} different commits of ${target} are pinned. ${groups.join('; ')}.`, {
      related: [...new Set(pins.map((p) => ids.repo(p.from)))],
      evidence: pins.map((p) => ({ at: ids.repo(p.from), text: `${p.source}: ${p.name}#${short(p.ref)}` })),
      fix: `Move every consumer to one commit of ${target} (its main is at ${short(repoByName.get(target)?.commit)}).`,
    });
  }

  // Imports of family packages outside their exports map. Missing modules are reported once per repository and
  // import path, with every importing file as evidence.
  const missing = new Map<string, { files: FileNode[]; evidence: Evidence[]; spec: string; target: string; repo: string }>();
  for (const { file: fileId, ref, pkg } of model.deepImports) {
    const file = model.files.get(fileId)!;
    const target = model.packages.get(pkg)!;
    if (target.repo === file.repo || ref.target) continue;
    const key = `${file.repo}|${ref.spec}`;
    const m = missing.get(key) ?? { files: [], evidence: [], spec: ref.spec, target: target.repo, repo: file.repo };
    if (!m.files.includes(file)) m.files.push(file);
    if (m.evidence.length < 25) m.evidence.push({ at: fileId, line: ref.line, text: ref.spec });
    missing.set(key, m);
  }
  for (const m of missing.values()) {
    const pin = repoByName.get(m.repo)?.dependencies.find((d) => d.repo === m.target && d.ref);
    const inSrc = m.files.some(isSrc);
    const where = m.files.length === 1 ? m.files[0]!.id : ids.repo(m.repo);
    out.add('missing-export', inSrc ? 'error' : 'warning', where, `${m.files.length === 1 ? 'Imports' : `${m.files.length} files import`} ${m.spec}, which ${m.target}'s main does not export and does not have.${pin ? ` ${m.repo} pins ${m.target} at ${short(pin.ref)}, which may have it: moving the pin to main breaks ${m.files.length === 1 ? 'this import' : 'these imports'}.` : ''}`, {
      related: [ids.repo(m.target), ...m.files.map((f) => f.id)], evidence: m.evidence,
      fix: `Land the module in ${m.target}'s main (with an exports entry), or stop importing it.`,
    });
  }
  for (const { file: fileId, ref, pkg } of model.deepImports) {
    const file = model.files.get(fileId)!;
    const target = model.packages.get(pkg)!;
    if (target.repo === file.repo || !ref.target) continue;
    out.add('deep-import', isSrc(file) ? 'warning' : 'info', fileId, `Imports ${ref.spec}, a file inside ${target.repo} that its exports map does not offer.`, {
      related: [ref.target], evidence: [{ at: fileId, line: ref.line, text: ref.spec }],
      fix: isSrc(file) ? `Export what is needed from an entry point of ${target.repo}.` : 'Tests may reach internals on purpose; keep it to tests.',
    });
  }


  // Outside code.
  for (const repo of model.repos) {
    for (const dep of repo.dependencies) {
      if (dep.family || dep.dev) continue;
      out.add('outside-code', repo.plugin ? 'info' : 'warning', repo.id, `Runtime dependency on ${dep.name} (${dep.spec}), from outside the family${repo.plugin ? ': allowed, as this is a plugin' : ''}.`, {
        related: [ids.external(dep.name)],
        evidence: [{ at: repo.id, line: undefined, text: `package.json dependencies: "${dep.name}": "${dep.spec}"` }],
        fix: repo.plugin ? undefined : 'Move the feature that needs it into a plugin, or get the owner\'s approval.',
      });
    }
  }
  const outsideImports = new Map<string, Evidence[]>();
  for (const file of files) {
    if (!isSrc(file)) continue;
    for (const ref of file.imports) {
      if (!ref.target?.startsWith('ext:') || ref.kind === 'type-import') continue;
      const key = `${file.repo}|${ref.target}`;
      const list = outsideImports.get(key) ?? [];
      list.push({ at: file.id, line: ref.line, text: ref.spec });
      outsideImports.set(key, list);
    }
  }
  for (const [key, evidence] of outsideImports) {
    const [repoName, ext] = key.split('|') as [string, string];
    const repo = repoByName.get(repoName)!;
    const name = ext.slice(4);
    const dep = repo.dependencies.find((d) => d.name === name);
    if (dep && !dep.dev) continue; // reported above
    out.add('outside-code', repo.plugin ? 'info' : 'warning', repo.id, `Source files import ${name}, ${dep ? 'a devDependency, so a bundle carries it' : 'which package.json does not declare'}.`, {
      related: [ext], evidence: evidence.slice(0, 25),
      fix: repo.plugin ? 'Declare it as a dependency of the plugin.' : 'Move it behind a plugin, or get the owner\'s approval and declare it.',
    });
  }

  // Boundary rules from arch.config.json.
  for (const rule of model.config.rules) runBoundary(model, rule, out);

  // Unresolved relative imports.
  for (const { file: fileId, ref } of model.unresolved) {
    if (!ref.spec.startsWith('.')) continue;
    const file = model.files.get(fileId)!;
    out.add('unresolved-import', isSrc(file) ? 'warning' : 'info', fileId, `Imports ${ref.spec}, which does not exist${file.role === 'src' ? '' : ` (in ${file.role} code)`}.`, { evidence: [{ at: fileId, line: ref.line, text: ref.spec }] });
  }

  // Cycles between source files of one repository.
  const valueEdges = new Map<string, string[]>();
  for (const e of model.fileEdges) {
    if (e.kind !== 'import' && e.kind !== 'reexport') continue;
    const a = model.files.get(e.from);
    const b = model.files.get(e.to);
    if (!a || !b || a.repo !== b.repo || !isSrc(a) || !isSrc(b)) continue;
    (valueEdges.get(e.from) ?? valueEdges.set(e.from, []).get(e.from)!).push(e.to);
  }
  for (const scc of stronglyConnected([...valueEdges.keys()], (n) => valueEdges.get(n) ?? [])) {
    if (scc.length < 2) continue;
    scc.sort();
    out.add('file-cycle', 'warning', scc[0]!, `${scc.length} files import each other in a cycle: ${scc.map((f) => model.files.get(f)!.path).slice(0, 8).join(', ')}${scc.length > 8 ? ', …' : ''}.`, {
      related: scc.slice(1),
      fix: 'Move what both sides need into a module of its own, or make one side depend on an interface.',
    });
  }

  // Cycles between repositories, through source code and runtime dependencies.
  const repoGraph = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a !== b) (repoGraph.get(a) ?? repoGraph.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of model.fileEdges) {
    const a = model.files.get(e.from);
    const toRepo = fileRepoOfTarget(e.to);
    if (a && toRepo && isSrc(a) && e.kind !== 'type-import') link(a.repo, toRepo);
  }
  for (const repo of model.repos) for (const d of repo.dependencies) if (d.repo && !d.dev) link(repo.name, d.repo);
  for (const scc of stronglyConnected([...repoGraph.keys()], (n) => [...(repoGraph.get(n) ?? [])])) {
    if (scc.length < 2) continue;
    const evidence: Evidence[] = [];
    for (const e of model.fileEdges) {
      const a = model.files.get(e.from);
      const toRepo = fileRepoOfTarget(e.to);
      if (a && toRepo && isSrc(a) && a.repo !== toRepo && scc.includes(a.repo) && scc.includes(toRepo) && e.kind !== 'type-import' && evidence.length < 25) evidence.push(...e.evidence.slice(0, 1));
    }
    out.add('repo-cycle', 'warning', ids.repo(scc.sort()[0]!), `Repositories depend on each other in a cycle: ${scc.join(' ↔ ')}.`, {
      related: scc.slice(1).map(ids.repo), evidence,
      fix: 'Release order and pins can no longer be one direction: break the cycle with a plugin interface or by moving shared code down a layer.',
    });
  }

  // Unused exports, per file.
  const offered = new Set<string>();
  for (const entry of model.entries.values()) for (const item of entry.api) if (item.symbol) offered.add(item.symbol);
  const entryFiles = new Set([...model.entries.values()].map((e) => e.file).filter(Boolean));
  for (const file of files) {
    if (!isSrc(file) || entryFiles.has(file.id) || file.path.endsWith('.d.ts')) continue;
    const unused = file.symbols.map((s) => model.symbols.get(s)!).filter((s) => s.exported && s.usedBy.length === 0 && !offered.has(s.id));
    if (!unused.length) continue;
    out.add('unused-export', 'info', file.id, `${unused.length} export${unused.length > 1 ? 's' : ''} nothing imports: ${unused.map((s) => s.name).slice(0, 12).join(', ')}${unused.length > 12 ? ', …' : ''}.`, {
      related: unused.map((s) => s.id),
      fix: 'Remove the export (or the code), unless it is used from HTML, a worker or a test by another path.',
    });
  }

  // Source files no test reaches.
  const reached = new Set<string>();
  const stack = files.filter((f) => f.role === 'test').map((f) => f.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const ref of model.files.get(id)?.imports ?? []) if (ref.targetFile && !reached.has(ref.targetFile)) stack.push(ref.targetFile);
  }
  for (const repo of model.repos) {
    const src = files.filter((f) => f.repo === repo.name && isSrc(f) && !f.path.endsWith('.d.ts') && f.symbols.length > 0);
    const hasTests = files.some((f) => f.repo === repo.name && f.role === 'test');
    for (const f of src) (f as { tested?: boolean }).tested = reached.has(f.id);
    const untested = src.filter((f) => !reached.has(f.id));
    if (!src.length || !untested.length) continue;
    out.add('untested', 'info', repo.id, hasTests ? `${untested.length} of ${src.length} source files are not reached by any test through imports.` : `No tests: none of ${src.length} source files is reached by a test.`, {
      related: untested.map((f) => f.id),
      evidence: untested.slice(0, 25).map((f) => ({ at: f.id, text: f.path })),
    });
  }

  // Markdown links.
  for (const [name, d] of model.disk) {
    for (const path of d.allFiles) {
      if (!path.endsWith('.md') || /(^|\/)(CHANGELOG|node_modules)/.test(path)) continue;
      for (const bad of brokenLinks(d.dir, path, d.allFiles)) {
        out.add('broken-doc-link', 'warning', ids.file(name, path), `Links to ${bad.link}, which does not exist.`, { evidence: [{ at: ids.file(name, path), line: bad.line, text: bad.link }] });
      }
    }
  }

  // Agents, parsing, intent.
  for (const repo of model.repos) {
    if (repo.stats.files > 0 && repo.agentFiles.length === 0) out.add('no-agent-file', 'info', repo.id, 'No CLAUDE.md or AGENTS.md: agents working here start without the family\'s rules.', { fix: 'Copy the working rules from smaltdb\'s CLAUDE.md and add what is particular to this repository.' });
    for (const l of repo.intent?.runtime ?? []) {
      for (const node of [l.from, l.to]) {
        if (!nodeExists(model, node)) out.add('stale-intent', 'warning', repo.id, `intent/${repo.name}.json names ${node}, which no longer exists.`, { fix: 'Update the intent file to the code\'s current names.' });
      }
    }
  }
  for (const file of files) {
    if (file.parseError) out.add('not-parsed', 'info', file.id, `Not parsed by smaltty: ${file.parseError}.`);
  }

  return out.list;
}

function runBoundary(model: Model, rule: BoundaryRule, out: Issues): void {
  const repoRe = globToRegExp(rule.repo);
  const fromRes = rule.from.map(globToRegExp);
  for (const file of model.files.values()) {
    if (!repoRe.test(file.repo) || !fromRes.some((r) => r.test(file.path))) continue;
    for (const ref of file.imports) {
      if (ref.spec.startsWith('.')) continue;
      if (!rule.forbid.some((p) => moduleMatches(p, ref.spec))) continue;
      const targetRepo = ref.targetFile ? model.files.get(ref.targetFile)?.repo : model.entries.get(ref.target ?? '')?.repo;
      if (rule.allowSameRepo && targetRepo === file.repo) continue;
      out.add(rule.id, rule.severity, file.id, `Imports ${ref.spec}${ref.kind === 'type-import' ? ' (types only)' : ''}. ${rule.why}`, {
        related: ref.target ? [ref.target] : undefined,
        evidence: [{ at: file.id, line: ref.line, text: ref.spec }],
        fix: rule.source ? `See ${rule.source}.` : undefined,
      });
    }
  }
}

function nodeExists(model: Model, id: string): boolean {
  return model.repos.some((r) => r.id === id) || model.entries.has(id) || model.files.has(id) || model.symbols.has(id) || model.dirs.has(id);
}

/** Tarjan's strongly connected components, iterative. */
export function stronglyConnected(nodes: string[], next: (n: string) => string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: string; i: number; succ: string[] }[] = [{ node: root, i: 0, succ: next(root) }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      if (top.i < top.succ.length) {
        const w = top.succ[top.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0, succ: next(w) });
        } else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!.node;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
        }
        if (low.get(top.node) === index.get(top.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== top.node);
          out.push(scc);
        }
      }
    }
  }
  return out;
}

/** Relative Markdown links (and VitePress site paths under docs/) that point at nothing. */
export function brokenLinks(dir: string, path: string, all: Set<string>): { link: string; line: number }[] {
  const out: { link: string; line: number }[] = [];
  let text: string;
  try {
    text = readFileSync(join(dir, path), 'utf8');
  } catch {
    return out;
  }
  const lines = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  const docsRoot = path.startsWith('docs/') ? 'docs' : undefined;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      let link = m[1]!;
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/|\{|\$)/i.test(link) || link.includes('{{')) continue;
      link = decodeURI(link.split('#')[0]!.split('?')[0]!);
      if (!link) continue;
      let base: string;
      if (link.startsWith('/')) {
        if (!docsRoot) continue;
        // A path the site does not serve from docs/ (an app beside the docs, such as /workbench/): not checked.
        const first = link.slice(1).split('/')[0]!;
        if (![...all].some((f) => f.startsWith(`${docsRoot}/${first}`) || f.startsWith(`${docsRoot}/public/${first}`))) continue;
        base = posix.join(docsRoot, link.slice(1));
        // VitePress serves docs/public at the root.
        if (all.has(posix.join(docsRoot, 'public', link.slice(1)))) continue;
      } else base = posix.join(posix.dirname(path), link);
      base = base.replace(/\/$/, '');
      const candidates = [base, `${base}.md`, `${base}/index.md`, base.replace(/\.html$/, '.md'), `${base}/README.md`];
      if (candidates.some((c) => all.has(c)) || existsSync(join(dir, base))) continue;
      out.push({ link: m[1]!, line: i + 1 });
    }
  });
  return out;
}
