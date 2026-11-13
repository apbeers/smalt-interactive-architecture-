// Shared test setup: smaltty from SMALTTY_DIR, .work/smaltty or a sibling checkout.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadSmaltty, type Smaltty } from '../src/analyze/extract.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export function smalttyDir(): string {
  const candidates = [process.env.SMALTTY_DIR, join(ROOT, '.work/smaltty'), join(ROOT, '../stenhoor/smaltty')].filter((d): d is string => !!d);
  const dir = candidates.find((d) => existsSync(join(d, 'src/index.ts')));
  if (!dir) throw new Error('smaltty not found: run `node bin/run.mjs fetch` or set SMALTTY_DIR');
  return dir;
}

let cached: Promise<Smaltty> | undefined;
export const smaltty = (): Promise<Smaltty> => (cached ??= loadSmaltty(smalttyDir()));

/** Writes `files` (path → text) under a new temporary directory and returns it. */
export function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
