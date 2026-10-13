# Architecture — tower-do

> System boundary and key data flows. Field-level contracts live in
> [CONTRACTS.md](./CONTRACTS.md); decisions (incl. why) in
> [DECISIONS.md](./DECISIONS.md).

## System boundary

tower-do is a **Pi extension** (three registered tools + an above-editor widget
+ a context reminder) whose only durable state is a **plain append-only JSONL
file** per project:

```
~/.pi/tower-do/<project>/board.jsonl   # <project> = slug-hash of the git root
```

- **No daemon, no DB, no lock server.** Any Pi session or subagent that can read
  the file sees the same tasks. This is *file-as-state*: state = storage,
  communication = storage.
- The **disk file is the single source of truth.** In-memory state (widget /
  reminder / `currentView`) is a display cache only; every read path re-folds
  the file.
- Runtime deps (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`)
  are peer dependencies supplied by the Pi host;
  `@earendil-works/pi-coding-agent` is the host package itself (a dev
  dependency used for types/constants and always present at runtime). The
  package adds no install-time dependencies.

## Event log & folding

Two event kinds are appended (one JSON line each):

| kind | fold | write path |
| --- | --- | --- |
| `task` | LWW by `key`; `op: "upsert"` replaces the row, `op: "remove"` deletes it | `tower_do` |
| `message` | LWW by `id` (a later event carries an ack update) | `tower_do_talk send` / `inbox` |

- **`revision` counts only task events** — message traffic never makes a peer's
  legal `baseRevision` stale (communication is "free").
- A write appends only the events of the entities it actually changes: one
  `task` upsert per created/updated row and one `task` remove per explicit
  deletion. A write that changes nothing appends nothing and does not bump the
  revision.
- `append` is one `open(O_APPEND)` + single `write(2)` call per batch, so
  concurrent processes cannot interleave inside a batch. The batch is atomic;
  the DECISION that produced it is not — a writer folds, decides and appends
  without holding anything a peer respects, so it must report the revision a
  fresh fold observes after its append (never a prediction) and `baseRevision`
  is conflict awareness, not a lock. **There is no cross-process lease and no
  log compaction**: the log grows only by the events actually written, and
  folding a few hundred kilobytes is cheap. A future `gc` is an optimisation,
  never a correctness requirement.
- `fold()` treats a missing file as an empty board; any other read error throws
  (an unreadable file must not look like a cleared board).
- **Legacy tolerance.** A pre-compaction `{kind:"compact"}` header from an older
  version is still read (its snapshot lines rebuild the maps without bumping
  the revision). A legacy `finding` line is ignored — valid history, not a
  corrupt row — and is not counted as unfoldable.
- A line the fold cannot turn into an event is counted in `view.skipped` and
  disclosed by `tower_do_status`; it is never salvaged with `Date.now()` (a
  task event's `at` IS the ownership clock).

## Write path

`writeBoardSnapshot(current, input, caller, staleClaims)` in `state.ts` is pure:

1. Reject a stale `baseRevision`.
2. Resolve `tasks` as **upserts** (merge each patch onto the stored row; new
   keys require `subject` + `status`) and validate `remove` keys.
3. Guard ownership: an owned row may only be changed/removed by its owner or
   `tower`, except a stale non-completed claim.
4. Compute the capacity, dependency-consistency and cycle checks over the
   **produced board** (existing rows − removals + upserts), not the input list.
5. Return the produced view, a change summary, and the events to append
   (`index.ts` re-folds after a NON-EMPTY append and reports that observed
   revision, because the produced view's own revision is only a prediction).

## Identity & takeover

- Identity is a plain string: `as` > config `identity` > session name >
  session id. Comparisons are exact (`===` / `Set.has` / `Array.includes`).
- **Takeover clock.** `staleTaskClaims` derives the displaceable
  `(owner, task)` pairs from board activity: the owner's last activity on that
  task, falling back to the task's `updatedAt`, older than
  `TASK_CLAIM_STALE_MS` (6 h). The clock is per owner+task — an owner's work on
  another task never protects this one, and unrelated board chatter does not
  either. A completed task is never displaceable.

## Read derivations (never written)

- **Block reasons** (`taskIsBlocked`): explicit `status: "blocked"`, the
  persisted `blockedBy` field, or unresolved `dependsOn`. A completed task is
  never blocked.
- **View layers** — removed (the dashboard renders open tasks plainly).
- **Message retirement** (`retainMessages`): fully read = every addressee has
  acked (a broadcast: its whole audience). Acked history past the internal
  retention budget leaves the default view; unread mail never exits on the
  budget and retires only through the age valve.

## Widget & reminder

- **Widget** (TUI only): `TowerDo N open · M msg` plus the most recently updated
  open tasks, capped at `WIDGET_TASK_LIMIT`, with an overflow line that names
  the remaining keys. Hidden when nothing is open and no mail is unread.
- **Reminder**: every `REMINDER_INTERVAL` (3) LLM calls a one-screen board
  summary is injected (header + open rows + the overflow line), so an agent
  that never calls `tower_do_status` still sees the shared state. A reminder
  already in the transcript is stripped and replaced.

## Layout

```
index.ts     # extension entry: 3 tools + widget + reminder + lifecycle
state.ts     # pure schema / validation / fold semantics / read derivations (no I/O)
board.ts     # disk layer (append-only JSONL) + config normalization
test/        # test suites (see CONTRACTS.md test gate)
docs/        # this documentation set
```
