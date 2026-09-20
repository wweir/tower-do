# Operations — tower-do

> Deployment, configuration, running, and troubleshooting. Product scope in
> PRODUCT.md; contracts/tests in CONTRACTS.md.

## Install

Three equivalent routes (README has the commands):

1. **npm (recommended)** — `pi install npm:tower-do` (auto-discovered at next
   startup; `/reload` picks it up in an existing session).
2. **git** — `pi install git:https://github.com/wweir/tower-do.git@main`.
3. **manual** — copy to `~/.pi/agent/extensions/`.

Runtime deps (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) are
peer dependencies provided by the Pi host — no manual install.
`@earendil-works/pi-coding-agent` is the host package itself, so it is a dev
dependency (types/constants) yet always present at runtime. Dev-only
`bun install` (bun-types + typescript) is for typecheck/tests.

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
- **Until that npm-side connection exists, a tag push fails at `Publish to
  npm` with `ENEEDAUTH`.** Other causes of the same error: the workflow
  filename / repository / owner not matching npmjs.com exactly (those fields
  are case-sensitive and the filename must include `.yml`), a self-hosted
  runner, or `package.json` `repository.url` not matching the GitHub
  repository. npm does not validate a connection when it is saved, so a typo
  only surfaces on the next publish.
- The GitHub Release notes are generated from conventional commits since the
  previous `v*` tag; the job needs `contents: write` for `gh release create`.

## Runtime layout

- Board: `~/.pi/tower-do/<project>/board.jsonl` (append-only event log — the
  single source of truth). `<project>` is the slug-hash of the project's git
  root; state never lives inside a repo, so nothing to gitignore.
- Checkpoints: on session compact / agent start, the view is embedded as a
  custom context entry (fallback display when the board file is missing).
- Widget: above-editor status line (TUI only).

## Board capacity and compaction

`tower_do` is a full replacement, so every write names the rows to keep. The
budget therefore has to leave room for a replay:

- Only **non-completed** rows count against `MAX_TOWER_DO_OPEN_TASKS` (50).
  `completed` rows are receipts, replay free, and can never block a new plan.
- Batch length is never a budget: replaying the whole board (completed rows
  included) is always legal. One write may introduce at most `MAX_TOWER_DO_OPEN_TASKS`
  (50) NEW completed rows — replaying an existing receipt is free.
- `tower_do_status` prints `open N/50` on the `Tasks:` line and adds a warning
  line at the cap.
- The dashboard renders at most `DASHBOARD_ROW_BUDGET` (200) rows. Open work
  always wins that default budget, and anything hidden is reported
  (`… +N more row(s) hidden by the budget`) — widen with `limit`, or narrow with
  `owner=`/`status=`. A task that "disappeared" from a long board is a
  filter/limit question, not data loss: the fold is the board.
- Unrelated unfinished work is folded, not dropped: the default `view` shows
  your own rows plus the peer work you are coupled to, and folds the rest into
  one stats line + a `key status @owner` ledger. `view=all` expands it, and
  every key stays in the output either way — a `tower_do` write must be able to
  name the rows it is not deleting.
- A very large dashboard is also cut at the host caps (50KB and 2000 lines,
  tail kept), and the cut takes the HEAD (header, revision, board file path,
  open rows). The footer says so and repeats the revision + board file path
  (its own bytes and line are reserved, so it survives the cut); page that file
  when you need every row for a full-replacement write. With completed rows
  folded into a multi-key ledger the byte cap is what normally binds; the
  2000-line bound stays enforced.

When the open budget is full (`open 50/50`):

1. **Free a slot** — omit your own rows (your completed ones too — a receipt you
   own is yours to drop) or an unowned task. Never another owner's row, unless
   that owner is stale and the row is not completed.
2. **Compact a finished board** — when rows are all completed and owned by
departed sessions, replay only the rows worth keeping under an explicit
orchestrator identity: `tower_do` with `as: "tower"`. `tower` owns every task,
so it may drop them; the dropped receipts survive in the JSONL history (until
an explicit `gc` — see below), only the folded view shrinks. This is the
documented, cooperative-trust escape hatch — it is unauthenticated, so treat a
board compaction like any other shared-state maintenance and record it in a
message (`tower_do_talk`) when peers are live.

Completed rows are never garbage-collected automatically: the owner guard
exists to keep delivery receipts trustworthy, and the folded view already has
display budgets (status slices at `limit`, widget shows remaining work only).
Because a write must name the rows it keeps, the practical ceiling on history
is what a reader can see; when the log itself matters, use the explicit `gc`
below — never silent row deletion. See DECISIONS.md.

### Log compaction (`tower_do action: "gc"`)

The board log is append-only, so `retainMessages` / `retainFindings` (view
projections) never shrink it. The only byte bound is an explicit compact:

```
tower_do  { "action": "gc", "tasks": [], "as": "tower" }
```

- `tower` identity only; `tasks` must be empty. Never periodic.
- `append` and `compact` share a per-board `<board>.lock` lease (a directory
  holding the holder's token file), so a peer
  append cannot land inside the compaction window (a stale lease from a dead
  holder is stolen after 30s; release unlinks only the holder's own token file
  and `rmdir` refuses a non-empty directory, so a stolen holder's cleanup
  cannot delete the new lease). `compact` fails
  closed if the lock cannot be created; an `append` degrades to unlocked when
  the lock path is unwritable (its own write is still atomic).
- Rewrites `board.jsonl` as one `{kind:"compact"}` header + one last-wins
  snapshot event per surviving entity (completed tasks and closed findings
  INCLUDED — it folds superseded upserts/acks, it does not delete rows). The
  snapshot preserves each owner's real last activity on a task, so a gc does
  not flip the takeover clock.
- The previous log is archived to `archive/board-rev<N>-<utc>.jsonl` — written
  only after the CAS passes, immediately before the rename, so an aborted
  compact never leaves an archive behind.
- Content CAS: the live sha is re-checked immediately before the rename (read through a hard link taken just before the swap, so the checked bytes are exactly the ones the rename replaces), and the pre-rename guard also verifies the path still names that preserved inode — a peer that replaced the board (compaction) in the window makes the compact abort instead of silently swapping the peer's board away. A mismatch aborts with the live file untouched, and every crash point leaves the old file intact. The lease is
  re-proven right after the rename: a holder paused past the staleness limit
  inside that window fails loud, and when the shape is provable the compact
  reconciles the window under a fresh lease (`content + P + W`, CAS re-checked
  at the swap) so the peer's writes reappear in the live fold; when it is not
  provable the pre-compact log is kept as a `board.jsonl.prev-*` evidence file
  named in the error. Nothing is ever rolled back blindly.
- `revision` is preserved (the header carries it), so `baseRevision` stays
  valid. Unfoldable lines block it unless `dropSkipped: true` is passed
  (recorded in the header as audit metadata; the live `skipped` count clears).
- `tower_do_status` prints `State: <slug> · log N line(s) / XKB [· compact
  rev M]` and hints the command at `BOARD_COMPACT_HINT_LINES` (10k) /
  `BOARD_COMPACT_HINT_BYTES` (1 MiB) or when `skipped > 0`.
- Known limit: the snapshot keeps each entity's ORIGINATING activity — the
  task owner's real clock, and for findings the last event's actor — so a gc
  does not flip the takeover clock or credit a peer's finding status change to
  the original filer. Message ACKS by other identities are not replayed (only
  the sender's time is kept), so the presence/idle hint can show an acker as
  quieter than the pre-gc log implied. The takeover clock (the load-bearing
  one) is preserved.

## Troubleshooting

- **"stale tower-do revision"** — a peer wrote since your read. Call
  `tower_do_status`, merge your changes onto the fresh view, retry with the new
  `baseRevision`.
- **"owned by ..."** — you touched another owner's task. Only its owner or
  `tower` may, unless that owner's activity ON THAT TASK is older than the
  takeover window (`TASK_CLAIM_STALE_MS`, 6 h) with no fresh `live/` heartbeat
  (including `as` aliases): then adopt by setting `owner` to yourself, or remove
  the non-completed task. Unrelated board activity does not protect the row.
  Completed tasks stay guarded. Otherwise message the owner via `tower_do_talk`,
  or have `tower` do it.
- **"open tasks support at most 50 items"** — the board's open budget is full.
  Omit your own or an unowned task, or compact a finished board with
  `as: "tower"` (see *Board capacity and compaction*). Completed rows do not
  consume the budget, so a board of finished work is never the cause.
- **Board file missing / empty view after cleanup** — `tower_do_status` warns
  and shows an empty fold; if the transcript holds a bounded checkpoint digest
  it is shown instead (open tasks + finding titles only, marked incomplete).
  Disk stays authoritative: a write treats the missing file as an empty board
  (revision 0), so no stale `baseRevision` survives the loss.
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
