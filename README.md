# smalt architecture

The smalt family's repositories ([stenhoor](https://github.com/stenhoor)'s main branches) as one interactive
architecture: every product, entry point, folder, file and exported declaration, how they depend on each other, and
what is wrong. A static analyzer builds it, so it costs no model tokens and gives the same answer for the same commits.
It is published to GitHub Pages as a static site with no dependencies.

- **People** click from the platform map into a product, a folder, a file and a declaration, and see every link with
  its evidence (file and line, linked to GitHub at the analysed commit).
- **Agents** read `llms.txt`, `context/platform.md` and one Markdown page per repository and per file, or query the
  JSON with `node bin/arch.mjs`. See [docs/AGENTS.md](docs/AGENTS.md).
- **CI** rebuilds it every six hours, on demand, and when a mapped repository sends a `smalt-updated` dispatch. Each
  build compares itself with the live site: API removed or changed, links added or removed, repositories that moved.

## Run it

Node 22.18 or later and git. Nothing to install.

```bash
node bin/run.mjs fetch     # shallow checkouts of every repository under .work/, and smaltty at the pinned commit
node bin/run.mjs build     # the site in _site/ (about two seconds)
npm run serve              # http://localhost:8080
npm test                   # the analyzer's tests
node bin/arch.mjs help     # the query tool
```

`build --repos <dir>` reads checkouts you already have; `--previous <dir or url>` compares with an earlier build;
`--fail-on error` makes CI fail on errors.

## How it works

| Step | Code | What it does |
| --- | --- | --- |
| Fetch | `src/fetch.ts` | Every repository in `arch.config.json` at the head of `main`; smaltty at `parser.ref` |
| Read | `src/analyze/repo.ts` | package.json, packed.json, tsconfig paths, ADRs, README, CLAUDE.md, the files |
| Parse | `src/analyze/extract.ts` | Each file with smaltty's parser: imports, exports, declarations with signatures and docs, workers, dynamic imports |
| Link | `src/analyze/graph.ts` | Imports resolved across repositories through exports maps, pins, tsconfig paths and vendored copies; exports followed through re-exports to their declarations; who uses each declaration |
| Check | `src/checks/index.ts` | The rules below |
| Write | `src/emit/` | `data/*.json`, Markdown for agents, `llms.txt`, the history |
| Show | `src/site/` | The app: plain TypeScript, stripped to JavaScript by smaltty at build time; layout and drawing are our own |

The model's shape is `src/model.ts`. Colours come from smalt-brand's `tokens.css`, copied at build time.

## Checks

| Rule | Finds |
| --- | --- |
| `pin-behind-main`, `pins-disagree` | Commit pins that are not main, and consumers pinned to different commits |
| `missing-export`, `deep-import` | Imports of a family package by a path its main does not export |
| `outside-code` | Code from outside the family that ships (allowed in plugins) |
| `file-cycle`, `repo-cycle` | Import cycles between files, and between repositories |
| `unresolved-import`, `broken-doc-link` | Imports and Markdown links to files that do not exist |
| `unused-export`, `untested` | Exports nothing imports; source files no test reaches |
| `api-removed`, `api-changed` | Entry point changes since the previous build, with their consumers |
| `no-agent-file`, `not-parsed`, `stale-intent` | Housekeeping |
| Boundary rules | From `arch.config.json`: what each repository's CLAUDE.md and ADRs forbid importing |

## Adding to it

- **A repository:** add it to `repos` in `arch.config.json` with its layer.
- **A boundary rule:** add it to `rules`, quoting the CLAUDE.md or ADR it comes from.
- **Intent and runtime wiring:** `intent/<repo>.json` ([format](intent/README.md)).
- **A new parser version:** move `parser.ref` and run the tests.
