// The whole run: read the repositories, build the model, run the checks, compare with the previous build, and write
// the static site (data, Markdown for agents, the app). `node bin/run.mjs build --help`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parsePaths, ROOT } from './config.js';
import { loadSmaltty } from './analyze/extract.js';
import { buildModel } from './analyze/graph.js';
import { ruleInfos, runChecks } from './checks/index.js';
import { apiSnapshot, compare, indexData, loadPrevious, repoData, searchRows, writeJson, type Changes } from './emit/data.js';
import { writeMarkdown } from './emit/markdown.js';

const HELP = `node bin/run.mjs build [options]

  --repos <dir>       checkouts, one directory per repository (default .work/repos; see: node bin/run.mjs fetch)
  --parser <dir>      smaltty's checkout (default .work/smaltty)
  --out <dir>         the site (default _site)
  --previous <dir|url> the previous build's data/ or the live site, to report what changed
  --fail-on <level>   exit 1 if any issue is at this level or worse (error, warning)
`;

const HISTORY_MAX = 200;

export async function main(args: string[]): Promise<number> {
  if (args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const started = Date.now();
  const config = loadConfig();
  const paths = parsePaths(args);
  if (!existsSync(join(paths.parser, 'src/index.ts'))) {
    console.error(`smaltty not found at ${paths.parser}: run node bin/run.mjs fetch first, or pass --parser.`);
    return 2;
  }
  const smaltty = await loadSmaltty(paths.parser);
  const model = buildModel(config, smaltty, { reposDir: paths.repos, intentDir: join(ROOT, 'intent'), log: (l) => console.log(l) });
  const generatedAt = new Date().toISOString();
  const issues = runChecks(model);
  const api = apiSnapshot(model);
  const previous = await loadPrevious(paths.previous);
  const { changes, apiIssues } = compare(model, issues, api, previous, generatedAt);
  const allIssues = [...issues, ...apiIssues];

  const out = paths.out;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const data = join(out, 'data');
  writeJson(join(data, 'index.json'), indexData(model, allIssues, ruleInfos(model), generatedAt));
  for (const r of model.repos) writeJson(join(data, 'repo', `${r.name}.json`), repoData(model, r.name));
  writeJson(join(data, 'search.json'), searchRows(model));
  writeJson(join(data, 'api.json'), api);
  writeJson(join(data, 'changes.json'), changes);
  const history: Changes[] = [changes, ...(previous.history ?? [])].slice(0, HISTORY_MAX);
  writeJson(join(data, 'history.json'), history);
  writeMarkdown(model, allIssues, changes, out);
  copyFileSync(join(ROOT, 'docs/AGENTS.md'), join(out, 'md/AGENTS.md'));

  // The app: HTML and CSS as written, TypeScript stripped to JavaScript by smaltty, the brand's tokens copied.
  for (const name of readdirSync(join(ROOT, 'site'))) copyFileSync(join(ROOT, 'site', name), join(out, name));
  mkdirSync(join(out, 'assets'), { recursive: true });
  for (const name of readdirSync(join(ROOT, 'src/site'))) {
    if (!name.endsWith('.ts')) continue;
    const js = smaltty.strip(readFileSync(join(ROOT, 'src/site', name), 'utf8'), { fileName: name });
    writeFileSync(join(out, 'assets', name.replace(/\.ts$/, '.js')), js);
  }
  const brand = config.repos.find((r) => r.layer === 'brand');
  const brandDir = brand ? join(paths.repos, brand.name) : '';
  for (const [from, to] of [['tokens/tokens.css', 'assets/tokens.css'], ['logos/smaltworks/favicon-32.svg', 'favicon.svg'], ['logos/smaltworks/together-mark.svg', 'assets/mark.svg'], ['logos/smaltworks/together-mark-on-dark.svg', 'assets/mark-on-dark.svg']] as const) {
    if (existsSync(join(brandDir, from))) copyFileSync(join(brandDir, from), join(out, to));
  }
  writeFileSync(join(out, '.nojekyll'), '');

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of allIssues) counts[i.severity]++;
  console.log(`\n${model.files.size} files, ${model.symbols.size} declarations, ${model.entries.size} entry points, ${model.fileEdges.length} file edges, ${model.repoEdges.length} repository edges`);
  console.log(`issues: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info`);
  if (changes.from) console.log(`since ${changes.from}: ${changes.commits.length} repositories moved, ${changes.api.length} entry points changed, ${changes.edges.added.length} edges added, ${changes.edges.removed.length} removed`);
  console.log(`site: ${out} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  const failOn = args.includes('--fail-on') ? args[args.indexOf('--fail-on') + 1] : undefined;
  if (failOn === 'error' && counts.error) return 1;
  if (failOn === 'warning' && (counts.error || counts.warning)) return 1;
  return 0;
}
