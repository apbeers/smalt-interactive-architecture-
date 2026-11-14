# smalt architecture

The smalt family's repositories ([stenhoor](https://github.com/stenhoor)'s main branches) as one interactive
architecture: every product, entry point, folder, file and exported declaration, how they depend on each other, and
what is wrong. A static analyzer builds it, so it costs no model tokens and gives the same answer for the same commits.
It is published to GitHub Pages as a static site with no dependencies.

- **People** explore it on one stage: clicking a box zooms into it and its contents appear inside it, from the platform
  to a product, a folder, a file and its declarations. A 3D depth map in the corner stacks the levels you came through,
  with the links on each, and can take over the stage. Every link carries its evidence (file and line, linked to
  GitHub at the analysed commit), and every node also has a details page.
- **More views** of the same model: a 3D **city** (districts are repositories, buildings are files; colour by health,
  hot spots or change; import arcs), a **time-lapse** of the platform growing day by day, the **layers** as 3D slabs
  with links that climb against them in red, **what breaks** (a ripple through everything that depends on a node),
  **traces** (a path through the code played step by step), a dependency **matrix**, **pin drift** on a timeline, and
  **hot spots** (change × dependents). In the explorer, **Flow** animates the links, and files show the calls between
  their declarations.
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

`build --repos <dir>` reads checkouts you already have; `--previous <dir or url>` compares with an earlier build and
reuses its time-lapse frames; `--no-timeline` skips analysing past days; `--fail-on error` makes CI fail on errors.

The page itself can't read git: history is analysed at build time from the checkouts and written to
`data/timeline.json` (one small frame per day) and into the model (change counts, pin ages).

## How it works

| Step | Code | What it does |
| --- | --- | --- |
| Fetch | `src/fetch.ts` | Every repository in `arch.config.json` at the head of `main`, with its history; smaltty at `parser.ref` |
| Read | `src/analyze/repo.ts` | package.json, packed.json, tsconfig paths, ADRs, README, CLAUDE.md, the files |
| Parse | `src/analyze/extract.ts` | Each file with smaltty's parser: imports, exports, declarations with signatures and docs, workers, dynamic imports; smaltty's binder resolves which declarations each one uses (calls) |
| Link | `src/analyze/graph.ts` | Imports resolved across repositories through exports maps, pins, tsconfig paths and vendored copies; exports followed through re-exports to their declarations; who uses each declaration |
| History | `src/analyze/repo.ts`, `src/timeline.ts` | From git: change per file (hot spots), each pin's date and distance behind main, and one analysed frame per past day for the time-lapse, cached by commit so a build only analyses new days |
| Check | `src/checks/index.ts` | The rules below |
| Write | `src/emit/` | `data/*.json`, Markdown for agents, `llms.txt`, the history |
| Show | `src/site/` | The app: plain TypeScript, stripped to JavaScript by smaltty at build time. Layout (`layout.ts`), the zooming explorer (`explorer.ts`, `levels.ts`), the depth map (`scene3d.ts`) and a small 3D engine on a 2D canvas (`engine3d.ts`: camera, shaded boxes, arcs, picking, treemaps) for the city (`city.ts`) and the layers (`cake.ts`) are our own |

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
