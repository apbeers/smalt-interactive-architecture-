// The query tool: the architecture from a terminal, for people and agents. Reads a build's data/ (default _site/data)
// or the live site (--site <url>).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from '../config.js';
import type { Edge, IndexData, Issue, RepoData } from '../model.js';

const HELP = `node bin/arch.mjs <command> [args] [--data <dir> | --site <url>] [--json]

  summary                      repositories, sizes and issue counts
  find <text>                  nodes whose name contains the text
  show <id>                    a node: what it is, its links, its issues
  who-uses <id>                direct users of a repository, entry point, file or declaration
  impact <id> [--all]          everything that depends on it, directly or not (--all: through
                               dev dependencies, packed.json pins and test imports too)
  issues [--repo r] [--severity s] [--rule id]
  rules [repo]                 the rules (and for a repository, those that apply)

Ids: smaltdb · entry:smaltdb/language · smaltdb/src/engine/ · smaltdb/src/client/index.ts · …/index.ts#open
`;

interface Source {
  index(): Promise<IndexData>;
  repo(name: string): Promise<RepoData>;
  search(): Promise<string[][]>;
}

function source(args: string[]): Source {
  const flag = (f: string): string | undefined => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const site = flag('--site');
  const dir = flag('--data') ?? join(ROOT, '_site/data');
  const cache = new Map<string, Promise<unknown>>();
  const get = <T>(name: string): Promise<T> => {
    let p = cache.get(name);
    if (!p) {
      p = site
        ? fetch(new URL(`data/${name}`, site.endsWith('/') ? site : site + '/')).then((r) => {
          if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
          return r.json();
        })
        : Promise.resolve().then(() => {
          const path = join(dir, name);
          if (!existsSync(path)) throw new Error(`${path} not found: build first (node bin/run.mjs build) or pass --site ${loadConfig().siteUrl}`);
          return JSON.parse(readFileSync(path, 'utf8'));
        });
      cache.set(name, p);
    }
    return p as Promise<T>;
  };
  return { index: () => get('index.json'), repo: (n) => get(`repo/${n}.json`), search: () => get('search.json') };
}

const repoOfId = (idx: IndexData, id: string): string | undefined =>
  id.startsWith('entry:') ? idx.entries.find((e) => e.id === id)?.repo : idx.repos.find((r) => r.name === id.split(/[/#]/)[0])?.name;

async function allEdges(src: Source, idx: IndexData): Promise<Edge[]> {
  const out: Edge[] = [];
  for (const r of idx.repos) if (r.stats.files) out.push(...(await src.repo(r.name)).edges);
  return out;
}

function printIssues(issues: Issue[]): void {
  for (const i of issues) {
    const ev = i.evidence?.[0];
    console.log(`${i.severity.padEnd(7)} ${i.rule}  ${i.node}${ev?.line ? `:${ev.line}` : ''}\n        ${i.message}${i.fix ? `\n        fix: ${i.fix}` : ''}`);
  }
}

/** Direct users of a node, as [user id, how]. */
async function usersOf(src: Source, idx: IndexData, id: string): Promise<[string, string][]> {
  if (idx.repos.some((r) => r.id === id)) return idx.edges.filter((e) => e.to === id).map((e) => [e.from, `${e.kind} ×${e.weight}`]);
  const entry = idx.entries.find((e) => e.id === id);
  const name = repoOfId(idx, id);
  if (!name) return [];
  const data = await src.repo(name);
  if (id.includes('#')) {
    const s = data.symbols.find((x) => x.id === id);
    return (s?.usedBy ?? []).map((f) => [f, 'imports it']);
  }
  const target = entry?.file ?? id;
  const edges = [...data.edges, ...data.inbound].filter((e) => (id.endsWith('/') ? e.to.startsWith(id) && !e.from.startsWith(id) : e.to === target));
  return edges.map((e) => [e.from, `${e.kind}, line ${e.evidence[0]?.line ?? '?'}`]);
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && rest[i - 1] !== '--json'));
  const flag = (f: string): string | undefined => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
  const asJson = rest.includes('--json');
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return 0;
  }
  const src = source(rest);
  const idx = await src.index();
  const out = (value: unknown, text: () => void): void => (asJson ? console.log(JSON.stringify(value, null, 2)) : text());

  switch (command) {
    case 'summary': {
      const rows = idx.repos.map((r) => ({ repo: r.name, layer: r.layer, files: r.stats.files, loc: r.stats.loc, entries: idx.entries.filter((e) => e.repo === r.name).length, issues: idx.issues.filter((i) => i.node === r.id || i.node.startsWith(r.name + '/')).length }));
      out(rows, () => {
        console.log(`${idx.title}, generated ${idx.generatedAt}`);
        for (const r of rows) console.log(`${r.repo.padEnd(18)} ${r.layer.padEnd(9)} ${String(r.files).padStart(5)} files ${String(r.loc).padStart(7)} lines ${String(r.entries).padStart(3)} entries ${String(r.issues).padStart(4)} issues`);
      });
      return 0;
    }
    case 'find': {
      const q = (positional[0] ?? '').toLowerCase();
      const hits = (await src.search()).filter((r) => r[1]!.toLowerCase().includes(q)).slice(0, 50);
      out(hits, () => hits.forEach((r) => console.log(`${r[2]!.padEnd(6)} ${r[0]}  ${r[4] ?? ''}`)));
      return hits.length ? 0 : 1;
    }
    case 'show': {
      const id = positional[0] ?? '';
      const repo = idx.repos.find((r) => r.id === id);
      const entry = idx.entries.find((e) => e.id === id);
      const issues = idx.issues.filter((i) => i.node === id);
      if (repo) {
        out({ repo, issues }, () => {
          console.log(`${repo.name} (${repo.layer}${repo.plugin ? ', plugin' : ''}) ${repo.packageName ?? ''} @ ${repo.commit.slice(0, 7)}\n${repo.intent?.summary ?? repo.whatItIs ?? repo.description ?? ''}`);
          console.log(`entry points: ${idx.entries.filter((e) => e.repo === repo.name).map((e) => e.name).join(', ') || 'none'}`);
          console.log(`depends on: ${[...new Set(idx.edges.filter((e) => e.from === id).map((e) => `${e.to} (${e.kind})`))].join(', ') || 'nothing'}`);
          console.log(`used by: ${[...new Set(idx.edges.filter((e) => e.to === id).map((e) => `${e.from} (${e.kind})`))].join(', ') || 'nothing'}`);
          printIssues(issues);
        });
        return 0;
      }
      if (entry) {
        out({ entry, issues }, () => {
          console.log(`${entry.name}: ${entry.api.length} exports, from ${entry.file ?? '?'}`);
          for (const a of entry.api) console.log(`  ${a.name}${a.typeOnly ? ' (type)' : ''}: ${a.signature}`);
          printIssues(issues);
        });
        return 0;
      }
      const name = repoOfId(idx, id);
      if (!name) {
        console.error(`unknown id: ${id} (try: node bin/arch.mjs find <name>)`);
        return 1;
      }
      const data = await src.repo(name);
      const node = [...data.files, ...data.symbols, ...data.dirs].find((n) => n.id === id);
      if (!node) {
        console.error(`unknown id: ${id}`);
        return 1;
      }
      const users = await usersOf(src, idx, id);
      out({ node, users, issues }, () => {
        if (node.kind === 'file') {
          console.log(`${node.id} (${node.role}, ${node.loc} lines)${node.doc ? `\n${node.doc}` : ''}`);
          console.log('imports:');
          for (const i of node.imports) console.log(`  ${i.line}: ${i.spec} → ${i.targetFile ?? i.target ?? 'unresolved'}`);
          console.log('declarations:');
          for (const sid of node.symbols) {
            const s = data.symbols.find((x) => x.id === sid)!;
            console.log(`  ${s.exported ? 'export ' : ''}${s.signature}${s.usedBy.length ? `  [${s.usedBy.length} users]` : ''}`);
          }
        } else if (node.kind === 'symbol') {
          console.log(`${node.signature}\n${node.doc ?? ''}`);
          for (const m of node.members ?? []) console.log(`  ${m.signature}`);
        } else console.log(`${node.id}: ${node.files} files, ${node.loc} lines`);
        console.log(`used by (${users.length}):`);
        for (const [u, how] of users) console.log(`  ${u}  ${how}`);
        printIssues(issues);
      });
      return 0;
    }
    case 'who-uses': {
      const users = await usersOf(src, idx, positional[0] ?? '');
      out(users, () => users.forEach(([u, how]) => console.log(`${u}  ${how}`)));
      return 0;
    }
    case 'impact': {
      const id = positional[0] ?? '';
      const result: { id: string; depth: number; via: string }[] = [];
      if (idx.repos.some((r) => r.id === id)) {
        const seen = new Set([id]);
        let frontier = [id];
        for (let depth = 1; frontier.length; depth++) {
          const next: string[] = [];
          for (const t of frontier) {
            for (const e of idx.edges) {
              if (e.to !== t || seen.has(e.from) || (!rest.includes('--all') && (e.kind === 'dev' || e.kind === 'packed' || e.kind === 'dev-import'))) continue;
              seen.add(e.from);
              next.push(e.from);
              result.push({ id: e.from, depth, via: `${e.kind} → ${t}` });
            }
          }
          frontier = next;
        }
      } else {
        const edges = await allEdges(src, idx);
        const entryFile = idx.entries.find((e) => e.id === id)?.file;
        const start = id.includes('#') ? (await usersOf(src, idx, id)).map(([u]) => u) : [entryFile ?? id];
        const reverse = new Map<string, Edge[]>();
        for (const e of edges) (reverse.get(e.to) ?? reverse.set(e.to, []).get(e.to)!).push(e);
        const seen = new Set<string>(start);
        let frontier = start;
        if (id.includes('#')) for (const s of start) result.push({ id: s, depth: 1, via: 'imports it' });
        for (let depth = id.includes('#') ? 2 : 1; frontier.length; depth++) {
          const next: string[] = [];
          for (const t of frontier) {
            for (const e of reverse.get(t) ?? []) {
              if (seen.has(e.from) || e.kind === 'type-import') continue;
              seen.add(e.from);
              next.push(e.from);
              result.push({ id: e.from, depth, via: `${e.kind} → ${t}` });
            }
          }
          frontier = next;
        }
      }
      out(result, () => {
        const repos = new Set(result.map((r) => r.id.split(/[/#]/)[0]));
        console.log(`${result.length} dependents in ${repos.size} repositories`);
        for (const r of result) console.log(`${'  '.repeat(Math.min(r.depth, 8))}${r.id}  (${r.via})`);
      });
      return 0;
    }
    case 'issues': {
      const repo = flag('--repo');
      const severity = flag('--severity');
      const rule = flag('--rule');
      const list = idx.issues.filter((i) => (!repo || i.node === repo || i.node.startsWith(repo + '/') || repoOfId(idx, i.node) === repo) && (!severity || i.severity === severity) && (!rule || i.rule === rule));
      out(list, () => printIssues(list));
      return 0;
    }
    case 'rules': {
      const repo = positional[0];
      const re = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      const list = idx.rules.filter((r) => !repo || re(r.repos).test(repo));
      out(list, () => list.forEach((r) => console.log(`${r.severity.padEnd(7)} ${r.id}  [${r.repos}]\n        ${r.about}${r.source ? ` (${r.source})` : ''}`)));
      return 0;
    }
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}
