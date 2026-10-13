# Decisions — tower-do

> Why things are the way they are. Contracts in
> [CONTRACTS.md](./CONTRACTS.md), architecture in
> [ARCHITECTURE.md](./ARCHITECTURE.md). Only decisions that still bind the
> two-feature product are kept here.

## 2026-10 — the two-feature reduction (what was removed and why)

The product was reduced to its two core features — a shared project todo board
and cross-session mail. Everything below was removed because it was surface
without being a core guarantee, and each carried state that had to be kept
consistent:

- **Write lease, log compaction, archive.** `board.jsonl` is append-only and
  grows only by the events actually written, and folding it is cheap, so
  compaction was an optimisation — but it dragged in a cross-process lease, a
  content CAS, a stolen-compact reconcile and archive retention. Removing it
  removed the highest-risk code in the repo. A future `gc` can be added with
  its own concurrency proof.
- **Findings.** A whole parallel entity (type, schema, budget,
  claim/snooze/close lifecycle, retention, a dashboard section and a detail
  read) for out-of-scope notes. The two core features need tasks and mail.
- **Scope declarations + `changedFiles` receipts.** Advisory file-glob overlap
  warnings over self-declared scope and self-reported receipts — never a gate,
  and not a core guarantee.
- **Dashboard layers/ledger/presence.** A caller-centred view (mine / needs /
  other), a folded key ledger and a "who is around" presence derivation. The
  status tool now renders open tasks plainly + a completed key ledger.
- **Checkpoint digest (transcript fallback).** The board file is the source of
  truth; when it is missing the board is empty. A digest fallback could only
  hand callers a `baseRevision` the write gate rejects.
- **Push wake.** Waking an idle session for a directly addressed message needed
  branch-scoped delivery state, an at-most-once marker protocol and a rate
  limiter; the pull path (reminder + `inbox`) surfaces the same mail.
- **Liveness sidecar + git segment.** A per-session heartbeat file and a git
  dirty/session attribution layer, both display-only for the widget.
- **Label aliasing (session labels / `sameAgent`).** Identity is now a plain
  string compared exactly (`as` > config > session name > session id).

Legacy compatibility: an existing `board.jsonl` still folds. A pre-compaction
`{kind:"compact"}` header is read, and a legacy `finding` line is ignored
rather than counted as unfoldable.

## 2026-10 — a write reports the revision a fold observes, not a prediction

`writeBoardSnapshot` returns `fold revision + appended events`, which equals the
file's revision only if no other process appended in the same window. There is
deliberately no cross-process lease, so two writers that folded the same
revision can both pass a capacity or ownership check: `baseRevision` is
conflict awareness against a revision a caller OBSERVED, not a lock. `tower_do`
therefore re-folds after a non-empty append and reports THAT revision, so the
value a caller passes back as `baseRevision` is one the file really holds. The
decision window itself stays last-writer-wins (CONTRACTS.md "revision gate").

`test/` also moved under the compile gate (`tsconfig.test.json`): it sits
outside the main `include` on purpose, which is how three imports of symbols
deleted in v0.8.0 stayed green through a release — bun tolerates a missing named
export, so only `tsc` can see the difference.

## 2026-10 — unread mail retires by age, never by the budget

"Fully read" is a pure ack test. It used to proxy reachability through task
ownership ("the recipient owns no row, so nobody can ever read it"), which
contradicted the documented guarantee that unread traffic survives the
retention budget, misclassified mail to any recipient admitted only by recent
board activity, and needed a `tower` carve-out because the orchestrator owns no
task. An unacked message now leaves the default view only through the age
valve, which bounds it without guessing.

## 2026-10 — task writes are upserts, deletion is explicit

A full-replacement write (the caller had to enumerate every key it wanted to
keep, and an omitted key was a removal) made a partial or replay write able to
drop a peer's row, and needed an ownership rule that existed only to police
omission (on a 209-key board a replay could not name every row). Writes now
upsert the rows they list and delete only via an explicit `remove` list, so a
partial write can never delete anything. Capacity, dependency and cycle checks
run over the produced board.

## 2026-10 — identity is a string; the takeover clock is per (owner, task)

Deriving a board label from a session id (with added entropy) and matching
labels through `sameAgent`/alias sets leaked into broadcast audiences and read
receipts, and the takeover gate needed a liveness sidecar to know whether a
quiet owner was alive. Identity is now a plain string and takeover uses a
single per-`(owner, task)` activity clock (the owner's activity on that task,
else the task's `updatedAt`) — one clock, no sidecar.

## 2026-10 — the CI test gate runs `bun <file>`, not `bun run <file>`

Since bun 1.4.0, `bun run <path>` with no matching `package.json` script prints
the CLI help, runs nothing, and exits 0 — a silently always-green release gate.
The gate runs each suite as `bun test/<file>.ts`, and each suite calls
`process.exit(1)` on failure.

## 2026-09 — file-as-state: one append-only JSONL per project

No daemon, no database, no server. State and communication are the same
storage, so any session or subagent that can read the file sees the same board.
The trade-off is deliberate: reads re-fold the log, and cross-process writers
are last-writer-wins past the revision gate (the revision gate is the
conflict-awareness layer, not a lock).

## 2026-09 — the owner guard covers every field

An owned task may only be changed or removed by its owner or `tower` —
comparing every field, not just status/owner, caught the class of bugs where a
worker could rewrite another agent's task by changing only its `subject` or
`dependsOn`. A stale non-completed claim may be displaced (see CONTRACTS.md).

## 2026-09 — config is identity-only

`config.json` carries one optional key (`identity`). Every other constant is
internal: no user evidence justified tuning it, and each one is permanent
schema + docs + test surface.
