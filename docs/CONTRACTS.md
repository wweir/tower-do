# Contracts — tower-do

> Contract boundaries, invariants, and the test gate. Field *shape* is encoded
> in code (state.ts schema + typebox schemas in index.ts) — this document
> records the *semantic* invariants that shape alone cannot express, plus what
> tests prove. ARCHITECTURE.md has the data flow; DECISIONS.md the why.

## Task model — semantic invariants

`tower_do` is a **full-replacement** write: every key present in the call is
upserted, every key on the board omitted from the call is **removed**. A caller
who wants to keep an existing task must replay it (usually unchanged).

### capacity — the budget is charged to open work

- At most `MAX_TOWER_DO_OPEN_TASKS` (50) rows of a board may be
  **non-completed**.
- `completed` rows are history/receipts: they consume no budget and replay
  free, so a board whose rows are all completed still accepts a new plan. (It
  did not before: the cap counted every row, and the guard forbids dropping a
  peer's completed row, so a finished board was write-blocked by its own
  history — finding f-902d6eb6-4ab.)
- **Batch length is never a budget**: a full replay is always legal, however
  many completed rows the board carries. What is bounded is *fabricated
  history* — one write may introduce at most `MAX_TOWER_DO_OPEN_TASKS` NEW
  completed keys (replaying an existing completed row is free). Any length
  ceiling reintroduces the deadlock at a higher threshold, because replaying
  peers' completed rows is mandatory, not optional. One constant, two readings
  on purpose: tuning `MAX_TOWER_DO_OPEN_TASKS` moves both the work a board
  carries and the history one write may invent.
- Remediation when the open budget is full: omit your own or an unowned row, or
  compact a finished board with an `as: "tower"` write replaying only the rows
  to keep. The cap error names both; `tower_do_status` renders `open N/50` and
  warns at the cap.
- `dependsOn` is unaffected: a dependency must still be completed and still
  live in the batch, completed rows included.
- **Status rendering**: the dashboard is bounded (`DASHBOARD_ROW_BUDGET` = 200
  rows). Under the default budget, open rows win the slice (stable partition,
  so every status group keeps fold order) — a completed history longer than
  the budget can never hide unfinished work; an explicit `limit` is honoured in
  fold order verbatim and may be raised past the default to widen. Whenever
  rows are hidden, the output names the count and the remedies (`limit`,
  `owner=`/`status=` narrowing).
- **Byte and line caps**: the rendered text is additionally bounded by the host
  caps (50KB, 2000 lines, **tail kept**), so a cut removes the *head* — the
  header, the revision, the board file path, and the open rows that render
  first. A cut is never silent: a footer states how many of how many lines
  survived and repeats the revision and board file path, so the caller can
  re-read the fold instead of replaying a silently incomplete board. The
  footer's bytes *and* its single line are reserved out of those bounds, so the
  disclosure can never be what breaks them (the line cap is reachable on its
  own once a caller raises `limit` past it with tiny rows).
- **List caps count the normalized list, not the raw input**: `dependsOn`,
  `scope`, `changedFiles` and `blockedBy` are trimmed, blank-filtered and
  deduped before the cap is applied, so 101 `changedFiles` entries with one
  duplicate is the legal 100 paths (not a rejection), and 21 references to one
  dependency is one dependency.
- **Unfolded log lines are disclosed, never silent**: a non-empty line the fold
  cannot turn into an event (corrupt JSON, a foreign shape, or a task payload
  that no longer validates under the current limits — e.g. a cap retuned
  downward after the row was written) is counted in `view.skipped` and
  `tower_do_status` reports the count with the board file path, because the
  board still holds that data and a full-replacement write from a peer who
  cannot see it would otherwise drop it from the folded view.
- Test gate: `test/task-cap.ts`.

| field | semantics |
| --- | --- |
| `key` | stable id, 1-40 lowercase `[a-z0-9._-]` |
| `subject` / `description` | content; **owner-guarded** like every other field (only owner/`tower` may change — see Ownership guard) |
| `status` | `pending` / `in_progress` / `completed` / `blocked` |
| `owner` | write boundary: only owner or `tower` may change owner-guarded fields |
| `scope` | declared file-glob mission boundary; owner/tower guarded; advisory (no file enforcement) |
| `changedFiles` | **delivery receipt** (P0): files the owner actually changed, repo-relative; see below |
| `dependsOn` | must resolve against the full board + this batch; cycles rejected; `in_progress`/`completed` require deps completed (`blocked` exempt) |
| `blockedBy` | advisory parked-reason keys, at most `MAX_TASK_BLOCKERS` (20) deduped entries — its own limit, so retuning the dependency cap cannot retune it; non-empty renders the task blocked (as do `status: "blocked"` and unresolved `dependsOn`), except `status: "completed"` which is never blocked |
| `updatedAt` | last write time; **no-op replays keep the original value** (no drift) |

### changedFiles receipt (P0) — worker-set-once, owner/tower amendable audit trail

- **Set only in the same call that sets `status: "completed"`** — providing
  `changedFiles` with any other status is a validation error (no silent
  "receipt on an unfinished task"). Leaving `completed` (reopen / send back)
  without an explicit `changedFiles` **voids** the inherited receipt — a
  delivery record does not apply to an unfinished task. The JSONL history
  still has the old receipt. Explicit `changedFiles: []` on `completed`
  clears it while staying completed.
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

### Stale-owner exception (takeover)

An owner of a non-completed task whose last board activity is older than
`OWNER_TAKEOVER_MS` (= `SESSION_BREAK_GAP_MS`, 30 min) — or who never started
at all and whose task has sat untouched that long — is *displaceable*
(`staleTaskOwners`, pure derivation over board activity + task timestamps):

- **adopt**: a peer may set `owner` to itself — and nothing else; the write
  must equal the existing task except for the owner swap. Content edits of a
  stalled task stay rejected; the adopter re-plans in a second write once it
  owns the task.
- **remove**: the non-completed task may be dropped by anyone (a hopeless
  task should not need an adopter first).
- **liveness tiebreaker**: an owner whose process still heartbeats (fresh
  `live/<id>.*.json` record within `LIVE_WINDOW_MS`) is never stale, however
  quiet on the board. The record identity *and* its `aliases` (`as` labels
  that session has written as) populate `liveOwners`; `live N` still counts
  identity only. Aliases are capped at `MAX_TOWER_DO_ALIASES`; a session that
  tries to record a further distinct `as` fails loud rather than dropping
  the label. No liveness data (unreadable sidecar dir) disables the
  exception, it never loosens it.

Completed tasks keep the full guard even when their owner is idle — a delivery
receipt cannot be dropped or forged by a peer. A fresh assignment is protected
(an owner with no activity whose task `updatedAt` is recent is "just assigned,
not begun yet", not stalled); a missing/unreadable activity log disables the
exception (no stale owners) rather than loosening the guard.

## Message contracts

- Recipient must be a current task owner, `tower`, `all`, or an identity with
  recent board activity (a peer whose tasks are all completed stays reachable
  via its historical bylines); **self-send banned**; subject/recipient
  single-line; body ≤ 32 KiB (pointer-style references for long reports).
- `taskKey` (optional thread under an existing task) is **send-only**: passing
  it with `inbox`/`finding` is rejected — findings are board-level records and
  carry no task link.
- `inbox` **acks** what it shows (LWW `readBy` update). Sender never counts as a
  reader of its own broadcast; a broadcast's send-time owner list is snapshotted
  as `audience` — late joiners aren't part of it and can't pin retirement.
- Historical broadcasts without `audience` are back-filled at fold time from the
  owner table at the replay point (owner transfers don't leak old owners).
- Undeliverable / orphaned messages auto-retire (nobody can ever read them).

## Revision gate

`baseRevision` (from `tower_do_status`) must equal the board revision or the
write is rejected — never silently overwrite a peer. Revision = cumulative
count of *folded* task events, tool-read from the file (never self-reported): a
log line the fold cannot turn into an event does not bump it and is reported as
`skipped` instead of vanishing (see below).

## arg schema vs the fold — who enforces what

pi validates tool arguments against the extension's `parameters` schema
**before** `execute` runs, and that failure path can name only an array index
(`tasks.84.description`), aborts the whole atomic write, and echoes the entire
rejected payload back into the model's context. So a content rule that lives in
the schema is a rule whose error cannot say which task it rejected: an 85-task
replay died on a 2224-character `description` (stored text was already 1664 —
83% of the cap) and the caller had to guess the row.

Ownership rule:

- **An element-level limit** — a text length or a list count under
  `tasks[i].*` — is enforced by the extension (fold or execute), and wherever
  the schema *also* declares that bound, the declared value is
  `transportLimit(limit)`: a strictly looser payload guard, never the rule. The
  extension's error names the task key, the measured length and the remedy
  (every element-level content error does; the `key` field itself is the one
  exception — a rejected key cannot name itself):
  `tasks[84].description (cg-release-145-catalog-fix) is 2224 characters
  (max 2000) — shorten it, or omit the field to preserve the stored text`.
  Limits the schema does not declare at all (the per-entry size of
  `scope`/`changedFiles`, the key format inside `dependsOn`) are enforced by
  the extension alone and need no guard — nothing can pre-empt them.
- **A named top-level field** (`as`, `to`, message `subject`, finding
  `title`/`summary`/`location`/`suggestedFix`, the status `owner` filter) keeps
  the business value in the schema: the host's error path already names those
  fields, so a guard would only add a second rule. The extension's own checks
  on them (where they exist) are backstops for direct callers.
- The task key is ASCII, so its length is metric-free: the pattern and
  `maxLength` both live in the schema, derived from `MAX_TASK_KEY_CHARS`.
- **One definition per limit**: every limit is a `state.ts` constant and every
  other layer (schemas included) derives from it. A second literal is a second
  rule that drifts silently.
- **The guard is a payload bound, not a rule**: the host's counted length is
  never larger than the extension's code points (plain BMP text: equal; astral
  or combining text: fewer), so a value the extension accepts is never refused
  preflight. 2× keeps the guard strictly above the limit so a realistic
  overshoot (the incident was 1.11×) reaches the key-bearing error instead of
  the host's index-only one, while still bounding the ordinary case at twice
  the intended payload. It is *not* an upper bound on payload — one base
  character plus thousands of combining marks is a single grapheme and passes
  any such guard, and that value then simply reaches the extension, which is
  the outcome we want.
- **Metric**: the extension counts Unicode **code points** (`textLength`) — one
  emoji is one character (`String.length` would count two) and a combining
  sequence counts per code point (a grapheme-cluster limit would count one).
  Code points are cheap and dependency-free, and the host's count never exceeds
  them; a limit expressed in code points therefore never lets through what the
  host would refuse.
- **Remedy contract**: a rejected write changes nothing (the extension throws
  before any event is appended), and an omitted field on an existing task
  preserves the stored value — an over-limit row is fixed by shortening it or
  by omitting the field, never by resending the whole board.
- Test gate: `test/limits.ts`.

## Test gate (what must stay green)

```bash
bun install            # devDeps (bun-types + typescript) — typecheck/tests only
bunx tsc --noEmit -p tsconfig.json      # strict + noUnused, zero errors
bun run test/smoke.ts               # end-to-end: 3 tools, persistence, scoping, changedFiles disk round-trip, reminder cadence vs snapshot strip, dashboard truncation footer
bun run test/config.ts              # config fail-loud + reserved identity (11 cases)
bun run test/owner-guard.ts         # every-field owner guard + stale-owner takeover (22 cases)
bun run test/presence-retention.ts  # read receipts / retirement / presence / caller-line match / checkpoints (66)
bun run test/changed-files.ts       # P0 receipt invariants (12 cases)
bun run test/scope-conflicts.ts     # P1 glob + conflict derivation (17 cases)
bun run test/git-count.ts           # widget git-segment pure derivations (31 cases)
bun run test/live-sessions.ts       # widget live-segment liveness window + sidecar-record parsing (30 cases)
bun run test/board-progress.ts      # widget board-progress remaining-work glance (8 cases)
bun run test/task-cap.ts            # open-task budget + fabricated-receipt bound (19 cases)
bun run test/mine-first.ts          # glance/reminder mine-first order + dashboard budget slice/note (23 cases)
bun run test/limits.ts              # arg schema vs fold: derived bounds, transport guard, key-bearing errors, list-cap ordering, code-point metric (60 cases)
bun run test/identity-scope.ts      # session scoping: a nested in-process session never re-labels its parent (reminder + status identity) (5 cases)
```

Coverage intent: **pure, dependency-free logic** (state.ts, git-count.ts)
carries regression suites; I/O-touching layers (board.ts / index.ts) are
covered by the smoke test exercising all three tools end-to-end against a
temp board, by `test/limits.ts`, which drives the *registered* tool schemas
through the same TypeBox checker the host uses and then asserts the fold's
answer for each boundary it lets through, and by `test/identity-scope.ts`,
which loads two extension instances into one process the way pi runs a session
and its subagent task sessions.

The same gate runs in CI on every `v*` tag push before the npm publish step
(`.github/workflows/release.yml`) — a tag that fails the gate never ships.
