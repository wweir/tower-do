# Product — tower-do

> Product scope and high-level experience. Architecture in
> [ARCHITECTURE.md](./ARCHITECTURE.md), contracts in
> [CONTRACTS.md](./CONTRACTS.md), decisions in [DECISIONS.md](./DECISIONS.md).

## What it is

A Pi extension that gives every session and subagent in a **project** two
things:

1. **A shared todo board** — plan, claim, update, complete, and block tasks
   with owners and dependencies. Every session reads and writes the same board;
   there is no daemon, no database, and no server, just one file per project.
2. **Cross-session mail** — addressed messages between the sessions working on
   that project, stored on the same board.

Plus a one-line above-editor widget showing the current workload
(`TowerDo 3 open · 1 msg`).

## Scope

- **Shared task board.** Tasks carry `key`, `subject`, optional `description`,
  `status` (`pending` / `in_progress` / `completed` / `blocked`), `owner`,
  `dependsOn`, and free-form `blockedBy`. Writes are upserts; deletion is
  explicit. `dependsOn` gates `in_progress`/`completed` and is rendered as a
  block reason.
- **Ownership.** A task with an `owner` can only be changed or removed by that
  owner or the reserved orchestrator identity `tower`. A claim whose owner has
  been quiet **on that task** past the takeover window may be displaced by a
  peer (adopt it, or remove it while it is not completed). Completed rows stay
  with their owner — a delivery record cannot be forged or dropped by a peer.
- **Cross-session mail.** `tower_do_talk send` addresses a message to `all`,
  the orchestrator `tower`, a current task owner, or an identity with recent
  board activity; self-send is rejected. `inbox` lists and acknowledges your
  mail. Unread mail is surfaced by the widget, the reminder, and
  `tower_do_status`.
- **Stale-write gate.** Every write may carry the `baseRevision` it read; the
  board rejects a stale write instead of silently overwriting a peer's work.
- **Status dashboard.** `tower_do_status` renders open tasks (recency-first),
  completed rows as a key ledger, your messages, and the activity tail; prints
  the board file path and revision so another agent (or a subagent) can read
  state directly; and returns one task's full detail with `taskKey`.

**Out of scope** (deliberate): findings/issues, file-scope declarations and
conflict advisories, session liveness counts, git-dirty attribution, push
wake, log compaction, checkpoint digests. Those were removed in the
two-feature reduction; see [DECISIONS.md](./DECISIONS.md).

## Experience

- **One session + subagents (typical).** The parent plans tasks on the board
  and claims owners; hands subagents the board path from `tower_do_status`
  (file-as-state); they report back; the parent closes tasks (or records on
  their behalf with `as`). Dependencies surface as block reasons.
- **Multiple sessions, one project.** Both sides read/write the same
  `~/.pi/tower-do/<project>/board.jsonl`; send a message and the peer reads it
  via `inbox` (or sees it as an unread count).
- **Above-editor widget.** `TowerDo N open · M msg` plus the most recently
  updated open tasks (capped, with an overflow line that still names their
  keys); hidden when there is nothing open and no unread mail.

## Identity

`as` param > config `identity` > session name > session id. Recording work for
a subagent: pass its id (`as: "coder-1"`).
