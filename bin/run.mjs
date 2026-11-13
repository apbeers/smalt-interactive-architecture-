#!/usr/bin/env node
// Runs one of this project's TypeScript entry points without a build: `node bin/run.mjs build|fetch|arch [args]`.
import { register } from 'node:module';

register('../scripts/ts-hook.mjs', import.meta.url);
const commands = { build: '../src/build.ts', fetch: '../src/fetch.ts', arch: '../src/cli/arch.ts' };
const [command, ...args] = process.argv.slice(2);
const entry = commands[command];
if (!entry) {
  console.error(`usage: node bin/run.mjs <${Object.keys(commands).join('|')}> [args]`);
  process.exit(2);
}
const module = await import(new URL(entry, import.meta.url).href);
process.exitCode = (await module.main(args)) ?? 0;
