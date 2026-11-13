# For agents

This site maps the smalt family's repositories (`stenhoor/*`, main branches) from their code: every product, entry
point, directory, file and exported declaration, how they depend on each other, and what the checks found. A static
analyzer (smaltty's parser) makes it on every run; no model reads the code, so it is the same every time for the same
commits.

## Before you change something

1. Read `context/platform.md` once: the layers, what each repository is for, and every error and warning.
2. Read `md/<repo>.md` for the repository you are in: entry points with their full API, dependencies both ways, ADRs,
   files, and its issues.
3. Before changing or removing an export, find who uses it: the symbol's page lists every importing file in every
   repository (`md/<repo>/<path>.md`, "Used by"), or run `node bin/arch.mjs who-uses <id>`.
4. Before moving a pin or changing an entry point, run `node bin/arch.mjs impact <repo or id>`: everything that
   depends on it, directly or not.

## After a change

Run the analyzer on your checkout (`node bin/run.mjs build --repos <dir with your checkouts>`) and compare
`data/index.json`'s issues with the site's. The "Changes" page and `data/changes.json` show what moved since the
previous build: API removed or changed (with the consumers that use it), links added or removed.

## Node ids

| Node | Id |
| --- | --- |
| Repository | `smaltdb` |
| Entry point | `entry:smaltdb/language` (`entry:` + the import path) |
| Directory | `smaltdb/src/engine/` |
| File | `smaltdb/src/client/index.ts` |
| Declaration | `smaltdb/src/client/index.ts#open` |
| Outside package | `ext:hyparquet`, `node:fs` |

On the site, `#/e/<id>` opens a node in the explorer (add `?view=3d` for the 3D map) and `#/n/<id>` its details page.

## The query tool

In the architecture repository (Node 22.18 or later, nothing to install):

```bash
node bin/arch.mjs help
node bin/arch.mjs find open                       # nodes by name
node bin/arch.mjs show entry:smaltdb/language     # a node, its links and issues
node bin/arch.mjs who-uses smaltdb/src/client/index.ts#open
node bin/arch.mjs impact smaltkit                 # what depends on it, transitively
node bin/arch.mjs issues --repo smaltbi --severity error
node bin/arch.mjs rules smaltdb                   # the rules that apply to a repository
```

It reads `_site/data` after a local build, or the live site with `--site <url>`.

## Issues

Each issue has a rule, a level (error, warning, info), the node it is about, evidence (file and line) and, where known,
a fix. Rules are listed on the site's Rules page; boundary rules live in `arch.config.json` and quote the CLAUDE.md or
ADR they come from. Runtime wiring that imports do not show (a worker started by a URL, a plugin registered by name) is
written down in `intent/<repo>.json`, and the `stale-intent` check keeps it honest.
