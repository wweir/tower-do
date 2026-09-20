# Architecture — tower-do

> Long-lived system-boundary + key-data-flow facts. Field-level contracts live
> in [CONTRACTS.md](./CONTRACTS.md); decisions (incl. why) in
> [DECISIONS.md](./DECISIONS.md). README links here for orientation.

## System boundary

tower-do is a **Pi extension** (registered tools + above-editor widget + context
reminders) whose only durable state is a **plain append-only JSONL file** per
project:

```
~/.pi/tower-do/<project>/board.jsonl   # <project> = slug-hash of the git root
```

- **No daemon, no DB, no lock server.** Any Pi session or subagent that can read
  the file sees the same tasks. This is *file-as-state* (Kimi Tower blackboard
  lineage): state = storage, communication = storage. The only concurrency
  control is a per-board **write lease on disk** (`<board>.lock`, a directory
  holding the holder's token file) — taken by `append`/`compact`, never by
  readers.
- The **disk file is the single source of truth.** In-memory state (widget /
  reminders / `currentView`) is a display cache only. If the workspace is
  cleaned, the last session checkpoint (a custom context entry) is the fallback
  display source — pinned to `revision 0` so it never advertises a stale
  `baseRevision` the disk gate would reject.
- Runtime deps (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`)
  are peer dependencies supplied by the Pi host; `@earendil-works/pi-coding-agent`
  is the host package itself (a dev dependency used for types/constants and
  always present at runtime). The package adds no install-time deps of its own.

## Event log & folding

Three event kinds are appended (one JSON line each), each with distinct fold
semantics:

| kind | fold | write path |
| --- | --- | --- |
| `task` | LWW by `key` (key total order; full-replacement snapshot) | `tower_do` |
| `message` | append, LWW by `id` for re-emissions (acks) | `tower_do_talk send` / `inbox` |
| `finding` | LWW by `id` + status machine | `tower_do_talk finding` |

- **`revision` counts only task events** — message/finding traffic never makes a
  peer's legal `baseRevision` stale (communication is "free").
- Task full-replacement re-folds **inside** both `withFileMutationQueue` and
  `withWriteLock`: its revision guard and diff see the freshest events across
  processes. Finding budget decisions re-fold inside `withWriteLock`; message
  sends/acks use the process mutation queue for local ordering. Appends
  are per-process serialized on a promise chain with single-write `O_APPEND`
  syscalls; across processes `append` and `compact` share the on-disk write
  lease, and a read-modify-append decision holds that lease through its
  append. `fold()` treats a missing file
  as an empty board; any other read error throws (an unreadable file must not
  look like a cleared board).
  `rawLines()` / `rawTail()` always throw on I/O error — display callers
  degrade; the stale-owner gate reads `rawLines()` (full log) so a bounded
  tail can never misreport an active owner as idle.
- The revision a write returns **exactly equals a re-fold** of the file
  (one bump per task event), so a caller can verify the write landed.

### Log compaction (explicit)

`board.jsonl` may open with a `{kind:"compact"}` header (written only by
`tower_do action:"gc"`, `tower` only). It carries the logical `revision` and
`snapshotLines`; the following snapshot lines rebuild the maps WITHOUT bumping
the revision, so a refold after a compact reports the same revision (a
caller's `baseRevision` is never invalidated) and appends after it stay
monotonic. The rewrite is content-CAS-guarded (re-read the live sha through a
hard link taken just before the swap, so the checked bytes are the ones the
rename replaces) and archives the previous log under `archive/` only after the
CAS passes, immediately before the rename; every crash point leaves the live
file intact. A holder paused past the lease staleness limit inside that rename
window cannot be excluded by a userspace lease, so the compact re-proves the
lease right after the rename and, on a steal, reconciles the window's writes
under a freshly taken lease when the shape is provable (`content + P + W`),
failing loud with a `<board>.prev-*` evidence file when it is not — it never
rolls back blindly, because a rollback could clobber writes the new holder
made after the rename.
`append` and `compact` also share a per-board `<board>.lock` lease
(a directory created atomically with the holder's token file inside it; the
holder refreshes the token file's mtime and only a token whose heartbeat has
stopped is reaped), so a peer append cannot land inside the
compaction window. Ownership of that lease is proved by exclusivity — the
directory must hold exactly the holder's token — both at acquisition and
again immediately before each mutation, because a reaper can recycle a
still-empty lease directory between a creator's `mkdir` and its token write.
The compact keeps every surviving entity, including
completed receipts and closed findings, and preserves each task owner's real
last-activity timestamp — it folds superseded upserts/acks, it never deletes
rows. See CONTRACTS.md "Log compaction".

### Checkpoint digest (bounded transcript payload)

`session_compact` / `before_agent_start` persist a `pi-tower-do-board-digest`
instead of the full view: `counts` (fixed record) + `openTasks` (≤ 50) +
`findings` (≤ 50, non-closed titles). The legacy full-snapshot type stays
readable. A digest-only restore (board file missing) is marked `incomplete`
and disclosed by the reminder and `tower_do_status`; the write path never uses
it (it folds the real file, missing = empty). See CONTRACTS.md "Checkpoint
digest".

## Project anchoring

The board is shared per **project** = nearest ancestor git work-tree root (a
`.git` directory, or a worktree/submodule whose `.git` is a file starting with
`gitdir:`); when no git boundary exists, the directory itself is the project.
`config.json` is global (`$HOME/.pi/agent/tower-do/`, beside pi's own config),
so `identity` applies across projects. The board/live state stays under
`$HOME/.pi/tower-do/<project>/`.

## Liveness sidecar (not board events)

The widget's `live N` does not read the board log: each running session owns
exactly one file `~/.pi/tower-do/<project>/live/<identity>.<sessionId>.json`
(`{"identity", "at", "aliases"?}`), rewritten on a 30s heartbeat and deleted
on clean exit. The count is a pure read derivation (`liveSessionCount` in
`state.ts`): distinct identities with a record fresh within 2 minutes, plus
self. Optional `aliases` are extra owner labels the session has written as
(`as: "coder-1"`): they populate the stale-owner gate's liveness set (a
parent still heartbeating protects its subagent's claim) but never inflate
`live N`. Own-file snapshots are serialized per session, so an older write
cannot land after a newer one and drop an alias. `fs.watch`
on the sidecar dir and `board.jsonl` (debounced ~250ms, session-scoped) makes
peer enter/exit — and peer board writes, which also re-fold the view — visible
within one tick. The board log keeps exactly task/message/finding events:
liveness never churns `revision` or the activity feed, and directories without
a board file get neither a live segment nor sidecar writes.

## Read derivations (never written)

Several board views are **pure read derivations** over the folded view / raw
activity tail — they never mutate the file, and callers cannot "write" them:

- **View layers** (`classifyTaskLayers`): unfinished tasks split for one
  caller into `mine` / `needs` (the caller's own work awaits it, unread mail
  threads under it, it awaits the caller's unfinished work, or its declared
  scope intersects the caller's own unfinished scope) / `other`, plus
  `completed` receipts; order inside every layer is `updatedAt` DESC, `key`
  ASC. Feeds the widget rows, the reminder and the `tower_do_status`
  dashboard. Pure — the folded view is untouched.
- **Presence** (`Who is around`): per-identity last-seen from parsed activity
  lines; three states — active / `⚠ idle` (>10 min quiet) / (not started).
  Real idle owners of unfinished tasks are footnoted on `tower_do` receipts.
- **Stale owners** (`staleTaskOwners`): owner labels whose activity **on that
  task** (or, for a never-active owner, the task's `updatedAt`) is older than
  `TASK_CLAIM_STALE_MS` and who have no fresh sidecar heartbeat/alias. The old
  board-global `lastSeen` let one unrelated message immunize every stale row;
  the clock is now per owner+task key. Feeds the owner-guard's takeover
  exception (contract in CONTRACTS.md) — a permission gate, not a display:
  `tower_do` reads the full activity log and the sidecar dir, and any read
  failure yields no stale owners (strict guard).
- **Finding state** (`deriveFindingState`): `actionable` / `claimed` /
  `snoozed` / `closed`, derived from status + `snoozeUntil` + liveness. The
  view retires closed rows past the grace (`retainFindings`) and pages by
  pressure; the budget gate charges every non-closed row. Never written.
- **Block reasons**: `taskIsBlocked` is a read derivation over explicit
  `status: "blocked"`, the persisted `blockedBy` field, and unresolved
  `dependsOn`. `findAllUnresolvedDeps` only lists the dependency reason.
  `status: "completed"` is never blocked (stale `blockedBy` does not count).
- **Scope conflicts** (P1): `findScopeConflicts` derives two advisory signals
  from `scope` declarations + `changedFiles` receipts:
  1. **overlap** — a completed task's receipt file lies inside an in-progress /
     pending task's `scope` glob (planner may be about to touch what a peer
     already changed);
  2. **collision** — two in-progress tasks declared intersecting `scope` globs
     (a planning mistake worth surfacing before both start writing).
  Advisory only — never a gate (scope is self-declared, changedFiles is
  self-reported; authoritative conflict resolution needs git-diff reads, out of
  scope for TowerDo).
- **Message retention**: `retainMessages` retires *fully-read* history past the
  internal message-retention budget; unread / partially-read messages never exit
  on the budget, though an unread message nobody acks still leaves the DEFAULT
  view after the age valve (`MESSAGE_PENDING_RETIRE_MS`; disk and `inbox all`
  keep it), and orphaned broadcasts (audience all gone) retire so finished
  rounds don't pin the budget forever.

## Layout

```
index.ts     # extension entry: 3 tools + widget + reminder + lifecycle
state.ts     # pure schema / validation / fold / read derivations (no I/O)
board.ts     # disk layer (append-only JSONL) + config normalization
git-count.ts # widget dirty/session file-count derivations (no I/O)
test/        # pure-logic + smoke suites (see CONTRACTS.md gates)
docs/        # this documentation set
```
