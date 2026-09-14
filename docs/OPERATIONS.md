# Operations — tower-do

> Deployment, configuration, running, and troubleshooting. Product scope in
> PRODUCT.md; contracts/tests in CONTRACTS.md.

## Install

Three equivalent routes (README has the commands):

1. **npm (recommended)** — `pi install npm:tower-do` (auto-discovered at next
   startup; `/reload` picks it up in an existing session).
2. **git** — `pi install git:https://github.com/wweir/tower-do.git@main`.
3. **manual** — copy to `~/.pi/agent/extensions/`.

Runtime deps (`typebox`, `@earendil-works/*`) are peer dependencies provided by
the Pi host — no manual install. Dev-only `bun install` (bun-types +
typescript) is for typecheck/tests.

## Configuration

`~/.pi/agent/tower-do/config.json` is the only configuration surface — no
environment variables. The file is optional (absent = defaults), global across
every project, and lives outside any repo — it is never committed. A leftover
per-project state dir at the retired `<project>/.pi/tower-do/` location is
auto-migrated into the global records home on first use (a pinned identity
rides along to the global config path). If the global state dir already
exists, a leftover project dir is ignored — it does not brick the session.

```json
{ "identity": "team-orchestrator" }
```

| key | default | meaning |
| --- | --- | --- |
| `identity` | session name/id | pin this session's board identity (global, applies to every project); must not be the reserved orchestrator identity `tower` |

That is the whole surface. Reminder cadence, widget rows, activity tail, and
message retention are internal tuning constants, not configuration. Unknown
keys are ignored (forward compatibility). A malformed file or invalid
`identity` fails loudly at session start — it is never silently defaulted,
because a silently-reset identity would corrupt owner matching and message
addressing in multi-agent sessions.

## Release (npm publish on tag)

Tagging `vX.Y.Z` on `main` triggers `.github/workflows/release.yml`, which
runs the compile + test gate, `npm publish`, and then creates a GitHub
Release for the tag — all automatically. This is the **only** release path —
no manual `npm publish` or `gh release create`.

```bash
# bump version in package.json, commit, then:
git tag vX.Y.Z && git push origin main --tags
```

- The repo ships TypeScript sources directly (`main: ./index.ts`, no build
  step), so the "compile" gate is `bunx tsc --noEmit -p tsconfig.json`.
- Tag must equal `package.json` version (`v` stripped); a mismatched tag
  fails the job before publish.
- Publish uses **npm trusted publishing (OIDC)** — no repository secret. The
  workflow's `id-token: write` permission lets the npm CLI exchange a
  short-lived publish token, and provenance is generated automatically.
  Requires a GitHub-hosted runner (OIDC/trusted publishing is unavailable on
  self-hosted runners) and npm >= 11.5.1 — the job upgrades npm and fails
  loud below that version.
- One-time npmjs.com setup: package `tower-do` → Settings → Trusted Publisher
  → GitHub Actions, with Organization or user `wweir`, Repository `tower-do`,
  Workflow filename `release.yml`, and **Allow `npm publish`** enabled
  (connections created after 2026-09-03 default to stage-only).
  `package.json` `repository.url` must keep matching the GitHub repo, or npm
  refuses the exchange. The old `NPM_TOKEN` secret is no longer used.
- The GitHub Release notes are generated from conventional commits since the
  previous `v*` tag; the job needs `contents: write` for `gh release create`.

## Runtime layout

- Board: `~/.pi/tower-do/<project>/board.jsonl` (append-only event log — the
  single source of truth). `<project>` is the slug-hash of the project's git
  root; state never lives inside a repo, so nothing to gitignore.
- Checkpoints: on session compact / agent start, the view is embedded as a
  custom context entry (fallback display when the board file is missing).
- Widget: above-editor status line (TUI only).

## Troubleshooting

- **"stale tower-do revision"** — a peer wrote since your read. Call
  `tower_do_status`, merge your changes onto the fresh view, retry with the new
  `baseRevision`.
- **"owned by ..."** — you touched another owner's task. Only its owner or
  `tower` may, unless that owner has been idle 30+ minutes with no fresh
  `live/` heartbeat (including `as` aliases): then adopt by setting `owner`
  to yourself, or remove the non-completed task. Completed tasks stay
  guarded. Otherwise message the owner via `tower_do_talk`, or have `tower`
  do it.
- **Board file missing / empty view after cleanup** — falls back to the last
  session checkpoint for display (disk stays authoritative).
- **Conflicting scope advisories** — advisory only: message the peer owner or
  re-scope. They never block writes.
- **Peer edits invisible** — every read path re-folds from disk. Widget and
  context reminders also re-fold on `agent_settled` / each LLM `context` event,
  so a peer's cancel shows up without waiting for a tool call. Stale compact
  snapshots are stripped on every `context` event; a replacement reminder is
  injected every 3 LLM calls (`REMINDER_INTERVAL`), not on every call just
  because a leftover snapshot was present. A forced checkpoint
  (`session_compact` retry / `before_agent_start`) arms the next event so its
  own snapshot is immediately replaced instead of being stripped and lost.
  Cross-process writers are last-writer-wins past the revision gate
  (single-tower assumption).
