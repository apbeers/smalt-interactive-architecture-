# Intent

What the code can't say about itself: what a repository is for, and wiring that imports don't show (a plugin passed
in at run time, a message sent to a worker, a page that loads another by URL). One file per repository,
`intent/<repo>.json`, all fields optional:

```json
{
  "summary": "One sentence: what it is for.",
  "responsibilities": ["What it owns", "What it deliberately does not do"],
  "runtime": [
    { "from": "smaltql", "to": "entry:smaltdb/language", "note": "How and when, in a few words" }
  ],
  "notes": ["Anything an agent should know before changing it"]
}
```

`from` and `to` are node ids (see docs/AGENTS.md). A runtime link between repositories is drawn on the platform map
as "Runtime wiring"; the `stale-intent` check reports any id that no longer exists, so these files can't quietly go
out of date. Write only what the repository's own docs, CLAUDE.md or ADRs say: this is the map's ground truth.
