# Contracts — tower-do

> The constraints that must hold and the tests that prove them. System
> boundary + data flow in [ARCHITECTURE.md](./ARCHITECTURE.md); why in
> [DECISIONS.md](./DECISIONS.md).

## Task model — semantic invariants

- A task is identified by `key` (`^[a-z0-9][a-z0-9._-]{0,39}$`); the fold is
  last-wins by key.
- `subject` (≤ 160 chars) and `status` (`pending` | `in_progress` | `completed`
  | `blocked`) are required; `description` (≤ 2000), `owner` (≤ 64),
  `dependsOn` (≤ 20 keys), `blockedBy` (≤ 20 entries, ≤ 120 chars each) are
  optional.
- **Upsert semantics.** `tower_do.tasks` creates or patches each listed row;
  omitted optional fields keep their stored value. A key not listed is left
  untouched. Deletion is the explicit `remove` list. A key in both `tasks` and
  `remove`, a duplicate `remove` key, or a `remove` key that does not exist is a
  loud error.
- **Capacity — the budget is charged to open work.** At most
  `MAX_TOWER_DO_OPEN_TASKS` (50) non-completed rows may exist after a write.
  Completed rows are receipts: they never consume the budget, and one write may
  introduce at most 50 NEW completed rows (updating a row the board already
  holds is free). The error names the remedy.
- **Dependencies gate status.** Every `dependsOn` key must exist on the produced
  board; `in_progress` and `completed` require every dependency to be
  `completed` (`blocked` is exempt). Cycles are rejected. These checks run over
  the **produced board**, so a removal may not strand a surviving dependent.
- **Blocked is derived.** `taskIsBlocked` = explicit `status: "blocked"`, a
  non-empty `blockedBy`, or an unresolved `dependsOn`. A `completed` task is
  never blocked, and the derived value is what the dashboard counts and renders.

## Ownership guard — every field

- A task with an `owner` may only be changed (any field) or removed by that
  owner or the reserved orchestrator identity `tower`.
- An unowned task may be claimed by anyone (`owner` set).
- **Stale-claim exception (takeover).** A non-completed row whose owner has been
  quiet **on that task** past `TASK_CLAIM_STALE_MS` (6 h) may be displaced. The
  clock is per `(owner, task)` pair: the owner's last activity on that task, else
  the task's `updatedAt`. Adoption is strictly an ownership displacement — set
  `owner` to yourself and change nothing else; a content edit of a stalled row
  stays rejected (re-plan in a second write). Removal of a stale non-completed
  row is likewise allowed. Completed rows are never displaceable.
- Identity comparison is **exact** (`===`). There is no label aliasing.

## Message contracts

- `send` requires `to` + `subject` + `body`; `body` ≤ 32 KiB, `subject` ≤ 200
  chars. `to` must be `all`, `tower`, a current task owner, or an identity with
  recent board activity. Self-send is rejected.
- A broadcast (`to: "all"`) records the audience snapshot (the board's owners at
  send time, minus the sender), so an owner who joins later does not pin it.
- `inbox` returns messages addressed to the caller (or `all`), newest first, and
  marks the ones it shows as read (`readBy`). `all: true` includes
  view-retired messages; the disk never deletes them.
- `unreadMessagesToMe` counts messages addressed to the caller that it has not
  acked. Mail is surfaced by the widget, the reminder and `tower_do_status`;
  reading `tower_do_status` does **not** ack.

## Revision gate

- `revision` counts folded **task** events only and is derived from the file
  (never self-reported).
- `baseRevision`, when passed, must equal the current revision or the write is
  rejected with a "stale tower-do revision" error naming the remedy (re-read
  via `tower_do_status`, merge, retry).
- Message traffic never advances the revision.

## arg schema vs the fold — who enforces what

The host validates tool arguments against the registered `parameters` schema
**before** `execute` runs, and its error path can only name an index path
(`tasks.84.description`). So:

- A limit on an **array element** that the extension also enforces (fold or
  execute) is never stated at its business value in the schema; wherever the
  schema declares that bound it carries `transportLimit(limit)` — a strictly
  looser payload guard — and the extension owns the error, because only it can
  name the task key, the measured length and the remedy.
- A limit on a **named top-level field** stays in the schema at the business
  value, because that error path already names the field.

Length is measured in Unicode **code points** (`textLength`), not UTF-16 units.

## Test gate (what must stay green)

`bunx tsc --noEmit -p tsconfig.json` plus, run with `bun <file>`:

| Suite | Proves |
| --- | --- |
| `test/smoke.ts` | end-to-end: fold round-trips, the real extension via a mock API (3 tools), owner guard, revision gate, widget/reminder |
| `test/config.ts` | config normalization; `identity` validation fails loud |
| `test/owner-guard.ts` | every-field ownership guard and the stale-claim takeover |
| `test/message-retention.ts` | message read/retention derivations |
| `test/home-isolation.ts` | state lives under `$HOME`, never in a repo |
| `test/board-progress.ts` | the widget progress segment |
| `test/task-cap.ts` | open-task budget, dependency gating across the budget |
| `test/limits.ts` | arg-schema vs fold ownership, per-element limits |
| `test/identity-scope.ts` | per-instance session identity (no module-global leak) |

CI runs this list on every release tag (`.github/workflows/release.yml`); the
workflow is the authoritative copy of the list.
