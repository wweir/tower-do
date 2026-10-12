# Operations — tower-do

> Deployment, configuration, running and troubleshooting. Product scope in
> [PRODUCT.md](./PRODUCT.md); contracts/tests in
> [CONTRACTS.md](./CONTRACTS.md).

## Install

Three equivalent routes — see the [README](../README.md) for the commands: npm
(`pi install npm:tower-do`), git, or a manual copy to
`~/.pi/agent/extensions/`. Pi auto-discovers the extension at startup;
`/reload` picks it up in an existing session.

Runtime deps (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) are
peer dependencies provided by the Pi host. `@earendil-works/pi-coding-agent` is
the host package itself, so it is a dev dependency (types/constants) yet always
present at runtime. Dev-only `bun install` (bun-types + typescript) is for
typecheck/tests.

## Configuration

`~/.pi/agent/tower-do/config.json` is the only configuration surface — no
environment variables. The file is optional (absent = defaults), global across
every project, and lives outside any repo (never committed).

```json
{ "identity": "team-orchestrator" }
```

| key | default | meaning |
| --- | --- | --- |
| `identity` | session name/id | pin this session's board identity (global, applies to every project); must not be the reserved orchestrator identity `tower` |

Unknown keys are ignored (forward compatibility). A malformed file or an
invalid `identity` fails loudly at session start — it is never silently
defaulted, because a silently-reset identity would corrupt owner matching and
message addressing in multi-agent sessions.

## Release (npm publish on tag)

Tagging `vX.Y.Z` on `main` triggers `.github/workflows/release.yml`, which runs
the compile + test gate, `npm publish`, and then creates a GitHub Release for
the tag. This is the **only** release path — no manual `npm publish` or
`gh release create`.

The tag must sit **on the release commit** — the one that changes
`package.json`'s version and nothing else. `git tag` defaults to `HEAD`, so
tagging after any further commit silently points the tag at a tree whose
`package.json` still carries the OLD version, and the job fails at the version
gate. Land the release commit last, tag that commit explicitly, and never
`git push --tags` from a dirty/ahead HEAD.

```bash
# 1. version bump ONLY — one commit, one file:
#    package.json: "version": "X.Y.Z"
git add package.json
git commit -m "chore(release): vX.Y.Z"

# 2. tag THAT commit (HEAD right now), then push both:
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

# verify before pushing anything (both must agree):
git log -1 --format=%s vX.Y.Z                 # chore(release): vX.Y.Z
git show vX.Y.Z:package.json | grep version   # "version": "X.Y.Z"
```

If a tag is already pushed by mistake, delete it before recreating it — **but
only while npm has no such version** (`curl -s -o /dev/null -w '%{http_code}'
https://registry.npmjs.org/tower-do/X.Y.Z` → `404`). A tag whose release
succeeded must never be force-moved: cut the next version instead.

- The repo ships TypeScript sources directly (`main: ./index.ts`, no build
  step), so the "compile" gate is `bunx tsc --noEmit -p tsconfig.json` and the
  test gate runs each suite as `bun test/<file>.ts` (**not** `bun run <file>`,
  which since bun 1.4.0 prints help and exits 0 without running anything).
- The tag must equal the `package.json` version (`v` stripped), or the job
  fails before publish.
- Publish uses **npm trusted publishing (OIDC)** — no repository secret. The
  workflow's `id-token: write` permission lets the npm CLI exchange a
  short-lived publish token, and provenance is generated automatically. It
  requires a GitHub-hosted runner and npm >= 11.5.1 (the job upgrades npm and
  fails loud below that).
- One-time npmjs.com setup: package `tower-do` → Settings → Trusted Publisher →
  GitHub Actions, with owner `wweir`, repository `tower-do`, workflow filename
  `release.yml`, and **Allow `npm publish`** enabled. `package.json`
  `repository.url` must keep matching the GitHub repo.
- A missing/mismatched npm-side connection fails at `Publish to npm` with
  `ENEEDAUTH`; the workflow/repo/owner fields are case-sensitive and the
  filename must include `.yml`.
- GitHub Release notes are generated from conventional commits since the
  previous `v*` tag.

## Runtime layout

- Board: `~/.pi/tower-do/<project>/board.jsonl` — an append-only event log and
  the single source of truth. `<project>` is the slug-hash of the project's git
  root; state never lives inside a repo, so there is nothing to gitignore.
- Widget: above-editor status line (TUI only).
- There is no `live/` sidecar, no `archive/`, and no lock file.

## Board behaviour

- **Writes are upserts.** A write lists only the rows it creates or changes; a
  key it does not mention is left alone, so a partial write can never drop a
  peer's row. Deleting is explicit (`remove: ["key"]`).
- **Capacity** is charged to open work: at most 50 non-completed rows after a
  write. Completed rows never consume the budget, and one write may introduce
  at most 50 NEW completed rows.
- **The log grows by the events actually written** and is never compacted
  automatically. `tower_do_status` prints `State: … log N line(s) / XKB` and
  discloses `skipped > 0` (lines it could not fold). A long log is expected;
  folding it is cheap.
- **The dashboard** renders every open task (recency-first) and completed rows
  as a key ledger. `limit` caps the rows; `owner=`/`status=` narrow the filter;
  `taskKey` returns one task's full detail. A large dashboard is cut at the host
  caps (50KB / 2000 lines, tail kept); the footer repeats the revision and
  board file path.

## Troubleshooting

- **"stale tower-do revision"** — a peer wrote since your read. Call
  `tower_do_status`, merge your changes onto the fresh view, retry with the new
  `baseRevision`.
- **"owned by …"** — you touched another owner's task. Only its owner or
  `tower` may, unless that owner's activity **on that task** is older than the
  takeover window (`TASK_CLAIM_STALE_MS`, 6 h): then adopt by setting `owner` to
  yourself (and changing nothing else), or remove the non-completed task.
  Unrelated board activity does not protect the row. Completed tasks stay
  guarded. Otherwise message the owner via `tower_do_talk`, or have `tower` do
  it.
- **"open tasks support at most 50 items"** — the open budget is full. Complete
  or `remove` an existing open task first. Completed rows do not consume the
  budget, so a board of finished work is never the cause.
- **Board file missing** — `tower_do_status` warns and shows an empty fold;
  disk stays authoritative (a write treats the missing file as an empty board
  at revision 0).
- **Peer edits invisible** — every read path re-folds from disk, and the widget
  / reminder re-fold on `agent_settled` and on each LLM `context` event, so a
  peer's change shows up without waiting for a tool call.
- **A `finding` line in an old board** — ignored by the fold (valid history),
  not counted as unfoldable.
