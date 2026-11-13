// arch.config.json, and where things are on disk.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Layer, Severity } from './model.js';

export interface RepoConfig {
  readonly name: string;
  readonly layer: string;
  readonly plugin?: boolean;
}

/** A boundary rule: files matching `from` in repositories matching `repo` must not import a module matching `forbid`. */
export interface BoundaryRule {
  readonly id: string;
  readonly repo: string;
  readonly from: string[];
  readonly forbid: string[];
  readonly allowSameRepo?: boolean;
  readonly severity: Severity;
  readonly why: string;
  readonly source?: string;
}

export interface Config {
  readonly title: string;
  readonly siteUrl: string;
  readonly owner: string;
  readonly branch: string;
  readonly parser: { repo: string; ref: string };
  readonly layers: Layer[];
  readonly repos: RepoConfig[];
  readonly rules: BoundaryRule[];
}

export const ROOT = resolve(new URL('..', import.meta.url).pathname);

export function loadConfig(path = join(ROOT, 'arch.config.json')): Config {
  return JSON.parse(readFileSync(path, 'utf8')) as Config;
}

export interface Paths {
  /** Where the repositories are checked out, one directory per repository name. */
  readonly repos: string;
  /** smaltty's checkout at the pinned commit. */
  readonly parser: string;
  /** The built site. */
  readonly out: string;
  /** A previous build's data/ (or the live site's URL), to compare with. */
  readonly previous?: string;
}

/** `--repos dir --parser dir --out dir --previous dir|url`, with defaults under .work/. */
export function parsePaths(args: string[]): Paths {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    repos: resolve(value('--repos') ?? join(ROOT, '.work/repos')),
    parser: resolve(value('--parser') ?? join(ROOT, '.work/smaltty')),
    out: resolve(value('--out') ?? join(ROOT, '_site')),
    previous: value('--previous'),
  };
}
