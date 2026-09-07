# Architecture — tower-do

> Long-lived system-boundary + key-data-flow facts. Field-level contracts live
> in [CONTRACTS.md](./CONTRACTS.md); decisions (incl. why) in
> [DECISIONS.md](./DECISIONS.md). README links here for orientation.

## System boundary

tower-do is a **Pi extension** (registered tools + above-editor widget + context
reminders) whose only durable state is a **plain append-only JSONL file** per
project:

```
<project>/.pi/tower-do/board.jsonl
```

- **No daemon, no DB, no lock server.** Any Pi session or subagent that can read
  the file sees the same tasks. This is *file-as-state* (Kimi Tower blackboard
  lineage): state = storage, communication = storage.
- The **disk file is the single source of truth.** In-memory state (widget /
  reminders / `currentView`) is a display cache only. If the workspace is
  cleaned, the last session checkpoint (a custom context entry) is the fallback
  display source — pinned to `revision 0` so it never advertises a stale
  `baseRevision` the disk gate would reject.
- Runtime deps (`typebox`, `@earendil-works/*`) are peer dependencies supplied
  by the Pi host — the package adds no install-time deps of its own.

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
- Every write path re-folds **inside** `withFileMutationQueue`: revision guard +
  diff both see the freshest events, eliminating read-then-write races. Appends
  are per-process serialized on a promise chain with single-write `O_APPEND`
  syscalls; cross-process writers rely on the `baseRevision` gate (last-writer
  wins otherwise).
- The revision a write returns **exactly equals a re-fold** of the file
  (one bump per task event), so a caller can verify the write landed.

## Project anchoring

The board is shared per **project** = nearest ancestor git work-tree root (a
`.git` directory, or a worktree/submodule whose `.git` is a file starting with
`gitdir:`); when no git boundary exists, the directory itself is the project.
`config.json` anchors to the same root, so `identity` is project-level.

## Read derivations (never written)

Several board views are **pure read derivations** over the folded view / raw
activity tail — they never mutate the file, and callers cannot "write" them:

- **Presence** (`Who is around`): per-identity last-seen from parsed activity
  lines; three states — active / `⚠ idle` (>10 min quiet) / (not started).
  Real idle owners of unfinished tasks are footnoted on `tower_do` receipts.
- **Block reasons**: `taskIsBlocked` / `findAllUnresolvedDeps` derive
  "waiting on deps" from the folded task graph.
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
  internal message-retention budget; unread / partially-read messages never exit, and
  orphaned broadcasts (audience all gone) retire so finished rounds don't pin
  the budget forever.

## Layout

```
index.ts     # extension entry: 3 tools + widget + reminder + lifecycle
state.ts     # pure schema / validation / fold / read derivations (no I/O)
board.ts     # disk layer (append-only JSONL) + config normalization
git-count.ts # widget dirty/session file-count derivations (no I/O)
test/        # pure-logic + smoke suites (see CONTRACTS.md gates)
docs/        # this documentation set
```
