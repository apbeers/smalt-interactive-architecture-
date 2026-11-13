// Checks out every repository in arch.config.json at the head of its branch (shallow), and smaltty at the pinned
// commit, under .work/. Run again to update. Only git is needed; nothing is installed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parsePaths } from './config.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } }).trim();

/** Brings `dir` to `ref` of `url` at depth 1, cloning it first if needed. */
function checkout(url: string, dir: string, ref: string): string {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', url);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      git(dir, 'fetch', '-q', '--depth', '1', 'origin', ref);
      break;
    } catch (e) {
      if (attempt === 4) throw e;
      execFileSync('sleep', [String(2 ** attempt)]);
    }
  }
  git(dir, 'checkout', '-q', '--force', 'FETCH_HEAD');
  return git(dir, 'rev-parse', 'HEAD');
}

export async function main(args: string[]): Promise<number> {
  const config = loadConfig();
  const paths = parsePaths(args);
  for (const repo of config.repos) {
    const head = checkout(`https://github.com/${config.owner}/${repo.name}.git`, join(paths.repos, repo.name), config.branch);
    console.log(`${repo.name.padEnd(20)} ${head.slice(0, 7)}`);
  }
  const parser = checkout(`https://github.com/${config.parser.repo}.git`, paths.parser, config.parser.ref);
  console.log(`${'parser (smaltty)'.padEnd(20)} ${parser.slice(0, 7)}`);
  return 0;
}
