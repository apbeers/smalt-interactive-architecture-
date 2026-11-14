// The time-lapse: the platform as it was at the end of each day, analysed from each repository's history. A frame is
// small (per repository: size and issues; between repositories: the links), and frames are cached by the commits they
// were made from, so a build only analyses days it has not seen.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Smaltty } from './analyze/extract.js';
import { buildModel, type Model } from './analyze/graph.js';
import { git } from './analyze/repo.js';
import { runChecks } from './checks/index.js';
import type { Issue } from './model.js';

export interface FrameRepo {
  readonly files: number;
  readonly loc: number;
  readonly symbols: number;
  readonly exported: number;
  readonly entries: number;
  /** Errors, warnings, info. */
  readonly issues: [number, number, number];
}

export interface Frame {
  /** The day (UTC) the frame shows the end of, or the build's own time for the latest frame. */
  readonly date: string;
  readonly commits: Record<string, string>;
  readonly repos: Record<string, FrameRepo>;
  /** Links between repositories: from, to, kind, weight. */
  readonly edges: [string, string, string, number][];
}

export interface Timeline {
  readonly frames: Frame[];
}

export function frameOf(model: Model, issues: Issue[], date: string): Frame {
  const repos: Record<string, FrameRepo> = {};
  const commits: Record<string, string> = {};
  for (const r of model.repos) {
    if (!r.commit) continue;
    commits[r.name] = r.commit;
    const counts: [number, number, number] = [0, 0, 0];
    for (const i of issues) {
      if (i.node !== r.id && !i.node.startsWith(r.name + '/') && model.entries.get(i.node)?.repo !== r.name) continue;
      counts[i.severity === 'error' ? 0 : i.severity === 'warning' ? 1 : 2]++;
    }
    repos[r.name] = { files: r.stats.files, loc: r.stats.loc, symbols: r.stats.symbols, exported: r.stats.exported, entries: [...model.entries.values()].filter((e) => e.repo === r.name).length, issues: counts };
  }
  return { date, commits, repos, edges: model.repoEdges.map((e) => [e.from, e.to, e.kind, e.weight]) };
}

const sameCommits = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export interface TimelineOptions {
  readonly reposDir: string;
  readonly workDir: string;
  readonly intentDir: string;
  readonly days: number;
  readonly previous?: Frame[];
  readonly log?: (line: string) => void;
}

/** Frames for each past day with history, oldest first, then `latest`. */
export function buildTimeline(config: Config, smaltty: Smaltty, latest: Frame, options: TimelineOptions): Timeline {
  const log = options.log ?? (() => {});
  const main = (repo: string): string => {
    const dir = join(options.reposDir, repo);
    return git(dir, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main') ? 'refs/remotes/origin/main' : 'HEAD';
  };
  // The first day any repository has a commit, and the days since (within the window).
  let first = '';
  for (const r of config.repos) {
    const dir = join(options.reposDir, r.name);
    if (git(dir, 'rev-parse', '--is-shallow-repository') === 'true') {
      log('timeline: shallow checkouts have no history; run fetch first');
      return { frames: [latest] };
    }
    const d = git(dir, 'log', '--max-parents=0', '--format=%cs', main(r.name)).split('\n').sort()[0] ?? '';
    if (d && (!first || d < first)) first = d;
  }
  const today = latest.date.slice(0, 10);
  const days: string[] = [];
  const start = new Date(Math.max(Date.parse(`${first}T00:00:00Z`), Date.parse(`${today}T00:00:00Z`) - options.days * 86400000));
  for (let t = start.getTime(); new Date(t).toISOString().slice(0, 10) < today; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));

  const cached = new Map((options.previous ?? []).map((f) => [f.date, f]));
  const frames: Frame[] = [];
  let analysed = 0;
  for (const day of days) {
    // Each repository's last commit on main by the end of the day.
    const commits: Record<string, string> = {};
    for (const r of config.repos) {
      const sha = git(join(options.reposDir, r.name), 'rev-list', '-1', `--before=${day}T23:59:59Z`, main(r.name));
      if (sha) commits[r.name] = sha;
    }
    const hit = cached.get(day);
    if (hit && sameCommits(hit.commits, commits)) {
      frames.push(hit);
      continue;
    }
    // Check each repository out at that commit, in a worktree beside the main checkout.
    for (const [name, sha] of Object.entries(commits)) {
      const wt = join(options.workDir, name);
      if (!existsSync(join(wt, '.git'))) {
        mkdirSync(options.workDir, { recursive: true });
        git(join(options.reposDir, name), 'worktree', 'add', '-f', '--detach', wt, sha);
      } else git(wt, 'checkout', '-q', '--force', '--detach', sha);
    }
    const dayConfig: Config = { ...config, repos: config.repos.filter((r) => commits[r.name]) };
    const model = buildModel(dayConfig, smaltty, { reposDir: options.workDir, intentDir: options.intentDir, history: false });
    frames.push(frameOf(model, runChecks(model), day));
    analysed++;
  }
  log(`timeline: ${frames.length} days (${analysed} analysed, ${frames.length - analysed} cached)`);
  frames.push(latest);
  return { frames };
}
