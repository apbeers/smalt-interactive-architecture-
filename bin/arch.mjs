#!/usr/bin/env node
// The query tool for people and agents: `node bin/arch.mjs help`.
import { register } from 'node:module';

register('../scripts/ts-hook.mjs', import.meta.url);
// `arch … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
const module = await import(new URL('../src/cli/arch.ts', import.meta.url).href);
process.exitCode = (await module.main(process.argv.slice(2))) ?? 0;
