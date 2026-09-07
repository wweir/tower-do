# Contracts — tower-do

> Contract boundaries, invariants, and the test gate. Field *shape* is encoded
> in code (state.ts schema + typebox schemas in index.ts) — this document
> records the *semantic* invariants that shape alone cannot express, plus what
> tests prove. ARCHITECTURE.md has the data flow; DECISIONS.md the why.

## Task model — semantic invariants

`tower_do` is a **full-replacement** write: every key present in the call is
upserted, every key on the board omitted from the call is **removed**. A caller
who wants to keep an existing task must replay it (usually unchanged).

| field | semantics |
| --- | --- |
| `key` | stable id, 1-40 lowercase `[a-z0-9._-]` |
| `subject` / `description` | content; **owner-guarded** like every other field (only owner/`tower` may change — see Ownership guard) |
| `status` | `pending` / `in_progress` / `completed` / `blocked` |
| `owner` | write boundary: only owner or `tower` may change owner-guarded fields |
| `scope` | declared file-glob mission boundary; owner/tower guarded; advisory (no file enforcement) |
| `changedFiles` | **delivery receipt** (P0): files the owner actually changed, repo-relative; see below |
| `dependsOn` | must resolve against the full board + this batch; cycles rejected; `in_progress`/`completed` require deps completed (`blocked` exempt) |
| `blockedBy` | advisory parked-reason keys; non-empty renders the task blocked (as do `status: "blocked"` and unresolved `dependsOn`), except `status: "completed"` which is never blocked |
| `updatedAt` | last write time; **no-op replays keep the original value** (no drift) |

### changedFiles receipt (P0) — worker-set-once, owner/tower amendable audit trail

- **Set only in the same call that sets `status: "completed"`** — providing
  `changedFiles` with any other status is a validation error (no silent
  "receipt on an unfinished task").
- **Owner-guarded like every other field**: a worker cannot add / rewrite /
  clear another owner's receipt (the owner guard compares every field). A
  worker sets it once when completing its own task; its owner and `tower` may
  amend later.
- Entries are single-line, trimmed, deduped, each 1-256 chars, capped at 100.
  Paths are repo-relative; matching is advisory.
- Semantics: **audit trail, not an authority.** Self-reported — it must never be
  used as a merge gate (that requires tool-read git diffs, out of scope).

### scope-conflict derivation (P1) — advisory only

`findScopeConflicts` (pure, read-only) flags:

- **overlap**: an active (in-progress / pending) task whose `scope` glob matches
  a *completed* task's `changedFiles` path → "you plan to touch what X already
  changed";
- **collision**: two in-progress tasks with intersecting `scope` globs.

Both are **advisory** — rendered by `tower_do_status` under a "Scope conflicts"
section, never a gate. Resolution is messaging the owner (`tower_do_talk`) or
re-scoping, not an automated block. Glob matching supports `*`, `**`, `?` and
exact paths; intersection is conservative (flags obvious collisions only).

## Ownership guard — every field

Only the task `owner` (or reserved `tower`) may change an owned task's fields —
**all** of `status/owner/scope/changedFiles/subject/description/dependsOn/
blockedBy`. Deleting (omitting) an owned task is likewise owner/tower-only.
Unowned tasks may be edited/removed by anyone. Rationale: with full-replacement
semantics, a worker replaying the board could otherwise silently rewrite
another owner's content or roll back a concurrent update.

## Message contracts

- Recipient must be a known task owner, `tower`, or `all`; **self-send banned**;
  subject/recipient single-line; body ≤ 32 KiB (pointer-style references for
  long reports).
- `inbox` **acks** what it shows (LWW `readBy` update). Sender never counts as a
  reader of its own broadcast; a broadcast's send-time owner list is snapshotted
  as `audience` — late joiners aren't part of it and can't pin retirement.
- Historical broadcasts without `audience` are back-filled at fold time from the
  owner table at the replay point (owner transfers don't leak old owners).
- Undeliverable / orphaned messages auto-retire (nobody can ever read them).

## Revision gate

`baseRevision` (from `tower_do_status`) must equal the board revision or the
write is rejected — never silently overwrite a peer. Revision = cumulative task
event count, tool-read from the file (never self-reported).

## Test gate (what must stay green)

```bash
bun install            # devDeps (bun-types + typescript) — typecheck/tests only
bunx tsc --noEmit -p tsconfig.json      # strict + noUnused, zero errors
bun run test/smoke.ts               # end-to-end: 3 tools, persistence, scoping, changedFiles disk round-trip
bun run test/config.ts              # config fail-loud + reserved identity (11 cases)
bun run test/owner-guard.ts         # every-field owner guard (10 cases)
bun run test/presence-retention.ts  # read receipts / retirement / presence / caller-line match / checkpoints (61)
bun run test/changed-files.ts       # P0 receipt invariants (10 cases)
bun run test/scope-conflicts.ts     # P1 glob + conflict derivation (17 cases)
bun run test/git-count.ts           # widget git-segment pure derivations (24 cases)
```

Coverage intent: **pure, dependency-free logic** (state.ts, git-count.ts)
carries regression suites; I/O-touching layers (board.ts / index.ts) are
covered by the smoke test exercising all three tools end-to-end against a
temp board.

The same gate runs in CI on every `v*` tag push before the npm publish step
(`.github/workflows/release.yml`) — a tag that fails the gate never ships.
