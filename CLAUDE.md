# CLAUDE.md

This repository builds an interactive architecture of the smalt family (stenhoor/* main branches) and publishes it to
GitHub Pages. Read README.md for the pipeline and docs/AGENTS.md for how agents use the output.

## Workflow

No pull requests (owner, 2026-11-13): when work is done and `npm test` passes, commit and push straight to `main`.
A push to `main` rebuilds the site and publishes it to GitHub Pages (`.github/workflows/pages.yml`).

## Commands

| Command | What it does |
| --- | --- |
| `node bin/run.mjs fetch` | Checkouts with history under `.work/`, smaltty at `parser.ref` |
| `node bin/run.mjs build [--repos dir] [--parser dir]` | The site in `_site/` |
| `npm test` | The analyzer's tests (`node --test`, smaltty from `.work/smaltty` or `SMALTTY_DIR`). Before every commit |
| `node bin/arch.mjs help` | The query tool over `_site/data` |

## Rules

- **No dependencies.** No npm packages at all, at build time or in the page: the parser is smaltty's source, run by
  Node's own type stripping (`scripts/ts-hook.mjs` maps `./x.js` to `./x.ts`); the site's TypeScript is stripped by
  smaltty. Ask the owner before adding outside code of any kind.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties), imports written `./x.js`.
- **The page is static.** Everything it shows comes from `data/`; it loads nothing from another site.
- **The model is a contract** with the site, the query tool and agents: add fields freely; removing or renaming one
  raises `SCHEMA_VERSION` in `src/model.ts`.
- **Checks state facts with evidence.** Every issue names a node and, where there is one, the file and line, in the
  family's plain words. A rule that misfires gets fixed or narrowed, not left noisy.
- **Intent files hold only what the mapped repositories' own docs say.**
- Colours are smalt-brand tokens (`var(--…)`), never hand-picked hex values.
- No fixed sleeps in tests; probe tests (`test/zz-*.test.ts`) are scratch and never committed.
