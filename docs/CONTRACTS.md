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
  so the slice keeps fold order; the render order inside a layer is
  recency-first — see DECISIONS.md "dashboard layers") — a completed history longer than
  the budget can never hide unfinished work; an explicit `limit` is honoured in
  fold order verbatim and may be raised past the default to widen. Whenever
  rows are hidden, the output names the count and the remedies (`limit`,
  `owner=`/`status=` narrowing).
- **The default view folds unrelated work, and never drops a key**: the default
  `view` (`layers`) renders the caller's own unfinished rows and the peer rows
  it is coupled to in full, and folds every other unfinished row into a one-line
  shape summary plus a `key status @owner` ledger. `all` expands everything,
  `mine` narrows to the caller's own rows. Within the default row budget no
  mode may hide a key: `tower_do` is a full replacement, so a caller must be
  able to name every row it is not deleting. An explicit small `limit` cuts the
  folded ledger like any other row and discloses the count, exactly as it does
  for open rows (see DECISIONS.md "dashboard layers").
- **Byte and line caps**: the rendered text is additionally bounded by the host
  caps (50KB, 2000 lines, **tail kept**), so a cut removes the *head* — the
  header, the revision, the board file path, and the open rows that render
  first. A cut is never silent: a footer states how many of how many lines
  survived and repeats the revision and board file path, so the caller can
  re-read the fold instead of replaying a silently incomplete board. The
  footer's bytes *and* its single line are reserved out of those bounds, so the
  disclosure can never be what breaks them (with completed rows rendered as a
  multi-key ledger, the byte cap is what binds in practice; the 2000-line bound
  stays enforced and is asserted as a bound, and test/smoke.ts drives a board
  whose ledger alone exceeds the byte cap to check the disclosure and both
  budgets).
- **List caps count the normalized list, not the raw input**: `dependsOn`,
  `scope`, `changedFiles` and `blockedBy` are trimmed, blank-filtered and
  deduped before the cap is applied, so 101 `changedFiles` entries with one
  duplicate is the legal 100 paths (not a rejection), and 21 references to one
  dependency is one dependency. Every list-valued field also caps each ENTRY's
  length (`MAX_PATH_ENTRY_CHARS` for `scope`/`changedFiles`, `MAX_BLOCKER_CHARS`
  for `blockedBy`) — `blockedBy` is rendered inline in the reminder, which has
  no byte budget of its own.
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
| `key` | stable id, 1-40 lowercase, first char `[a-z0-9]` then `[a-z0-9._-]` (`TASK_KEY_PATTERN`) |
| `subject` / `description` | content; **owner-guarded** like every other field (only owner/`tower` may change — see Ownership guard) |
| `status` | `pending` / `in_progress` / `completed` / `blocked` |
| `owner` | write boundary: only owner or `tower` may change owner-guarded fields |
| `scope` | declared file-glob mission boundary; owner/tower guarded; advisory (no file enforcement) |
| `changedFiles` | **delivery receipt** (P0): files the owner actually changed, repo-relative; see below |
| `dependsOn` | must resolve against the full board + this batch; cycles rejected; `in_progress`/`completed` require deps completed (`blocked` exempt) |
| `blockedBy` | advisory parked-reason keys, at most `MAX_TASK_BLOCKERS` (20) deduped entries, each at most `MAX_BLOCKER_CHARS` (120) — its own limits, so retuning the dependency cap cannot retune the blocker cap; non-empty renders the task blocked (as do `status: "blocked"` and unresolved `dependsOn`), except `status: "completed"` which is never blocked |
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
section, never a gate. The section grows with the completed history, so the
**default view** keeps the conflicts that involve the caller's own or coupled
tasks first and cuts the section to `DASHBOARD_SCOPE_CONFLICT_LINES` (5) rows,
reporting the rest as a count; `view=all` lists every one. The count is never
hidden. Resolution is messaging the owner (`tower_do_talk`) or
re-scoping, not an automated block. Glob matching supports `*`, `**`, `?` and
exact paths; intersection is conservative (flags obvious collisions only).

## Identity labels — one agent, one key

A generated session identity is `session-<time8>-<rand8>`. pi session ids are
UUIDv7 hex (`8-4-4-4-12`), so the first 12 digits are a millisecond timestamp
and the last 12 are random:

- **The first 8 digits alone are a 65.5 s bucket** (2^16 ms), not an identity.
  Through 0.4.0 the label was exactly that, so every session started inside one
  bucket shared one owner key — two sibling subagents 26 ms apart both became
  `session-01a0b47e` (finding f-79d6f380-a2e).
- `rand8` is 8 hex digits of the id's random tail: bucket siblings differ with
  probability 1 − 2⁻³². The time prefix is kept verbatim only for readability
  (labels are retyped into `owner=`, `to=` and `as=`) — it is not what makes the
  label unique. A full 42-character id was rejected for that reason.
- Labels that are not generated session labels (a pinned `config.identity`, an
  `as` label) compare verbatim: no pattern, no aliasing.

**Permission is exact; only delivery and display alias.** The owner guard (and
the staleness gate that feeds it, the takeover/adoption path, and the finding
claim guard with its close obligation) compares
labels **character for character**, exactly as it always did. A legacy
`session-<time8>` label cannot name one member of its 65.5 s bucket, so making
it an alias in the guard would hand every bucket sibling write rights over the
row — the collision in permission clothing. Ambiguity is resolved strictly: the
row is touched by its exact label, by `tower`, or through the idle-window
takeover (adopt it by setting `owner` to yourself, then edit in a second
write). That is the remedy, and it is deliberate rather than guessed.

**Identities are self-declared labels; the board has no authentication.** `as`
(including the reserved `tower`) is cooperative-trust coordination metadata, so
a `tower`-only gate such as `gc` is a documented convention, not a verified
boundary — see DECISIONS.md and OPERATIONS.md.

`sameAgent(a, b)` is the **delivery/display** relation: exact equality, plus a
legacy `session-<time8>` reaching the `session-<time8>-<rand8>` label it
prefixes, so mail addressed to a pre-0.4.1 label is still delivered and a
migrated row renders as the same agent. It may therefore *over-deliver* within
one bucket (the pre-0.4.1 reach — never worse, and never lost mail); it never
grants rights. Two CURRENT labels are never equated, not even inside one bucket.

- It is **not transitive** (legacy ↔ each bucket sibling), so grouping must be
  keyed, never transitive: `derivePresence` merges a legacy row only into a
  bucket holding exactly one current label; two current labels in one bucket
  always render as two rows.
- Applied at: inbox addressing (`to`/`from`/broadcast audience), read receipts
  (additive; a legacy receipt is left as written) and recipient validation —
  plus the dashboard's `me` markers. Never at the owner guard.
- Test gate: `test/identity-label.ts`, plus the in-process bucket-sibling case
  in `test/identity-scope.ts`.

## Ownership guard — every field

Only the task `owner` (or reserved `tower`) may change an owned task's fields —
**all** of `status/owner/scope/changedFiles/subject/description/dependsOn/
blockedBy`. Deleting (omitting) an owned task is likewise owner/tower-only.
Unowned tasks may be edited/removed by anyone. Rationale: with full-replacement
semantics, a worker replaying the board could otherwise silently rewrite
another owner's content or roll back a concurrent update. The re-fold,
`baseRevision` guard, owner check, and replacement append execute under one
cross-process write lease; a peer cannot commit another replacement between
the guard and append.

### Stale-owner exception (takeover)

An owner of a non-completed task whose activity **on that task** is older than
`TASK_CLAIM_STALE_MS` (= `OWNER_TAKEOVER_MS`, 6 h) — or who never started at
all and whose task has sat untouched that long — is *displaceable*
(`staleTaskOwners`, pure derivation over board activity + task timestamps).
Unrelated board activity (messages, or work on other task keys) does NOT
protect a row: the clock is per owner+task. The 30 min `SESSION_BREAK_GAP_MS`
now only groups the activity feed / presence hints, never ownership:

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
  Reachability is proxied by TASK OWNERSHIP, because retention is a pure
  function of the folded view: a recipient admitted only for recent board
  activity may therefore retire earlier than the age valve — the age valve is
  always the bound.
- `send` (taskKey existence, recipient validation, audience snapshot) and
  `inbox` (fold + read receipts) run their read-modify-append INSIDE the write
  lease: a concurrent peer cannot delete the task between the check and the
  append (no dangling `taskKey`), and two concurrent acks of the same message
  cannot lose a `readBy` entry to last-write-wins. An inbox with nothing
  unacked for the caller performs NO write and takes no lease — a read-only
  state dir still serves it and a peer mid-compact cannot stall it.

## Finding contracts (exit mechanism)

Findings are the one record class with no natural terminal event, so their
exit is explicit and auditable:

- **Lifecycle**: `open` → (`claim`) `accepted` → `snoozed` (deadline) or
  `done`/`rejected`. `snoozed` is a status; an expired `snoozeUntil` flows back
  to `actionable`. Liveness (`live/` heartbeat) only routes responsibility: an
  `accepted` finding whose owner is not live derives as `actionable`
  (adoptable), never as resolved. Session exit never closes a finding.
- **Budget**: `MAX_TOWER_DO_OPEN_FINDINGS` (50) bounds every NON-closed finding
  — `open`, `accepted`, and `snoozed` alike. A snooze or a claim occupies a
  slot; only `done`/`rejected` frees one. Filing past the budget is rejected
  with the OLDEST rows named by pressure and a batch remedy, so the rejection
  itself surfaces the hidden backlog (the old dashboard rendered the newest 20,
  permanently hiding the oldest debt). "Oldest" here is the last transition
  (`at`), not first filing, so a re-opened row ranks as fresh. The
  count-and-append is done under the
  cross-process write lease (`withWriteLock`), so two sessions cannot each
  observe 49 and both reopen to 51; a legacy over-cap board can always DRAIN
  (only an increase that would exceed the cap is rejected).
- **Close obligation**: a live owner holding a claimed finding past
  `FINDING_CLOSE_GRACE_MS` (7d) cannot file a new finding until it closes or
  snoozes it. A dead owner never blocks a peer (their claim already collapsed
  to actionable).
- **Close/snooze require a single-line `reason` (≤ `MAX_FINDING_REASON_CHARS`);
  a `snoozeUntil` must be future and ≤ `FINDING_SNOOZE_MAX_MS` (30d) ahead.**
- **Batch update**: `findingIds[]` (≤ 50, deduped) + one status/reason/snooze
  updates many findings in one call; each id still appends its own LWW event
  (one audit row per finding). `findingId` and `findingIds` are mutually
  exclusive. An owned (claimed) finding may only be changed by its owner,
  `tower`, or a peer when the claim is not live (stale adoption); an
  incomplete liveness scan treats every owner as live (strict guard).
- **View retirement is Layer 2, never a delete**: closed findings past the
  grace leave the default list but stay in the fold, are listed by `view=all`,
  and remain readable by `findingId`. Nothing `actionable` is ever retired by
  age alone.
- **Messages**: the age valve (`MESSAGE_PENDING_RETIRE_MS`, 14d on an unread
  message) and the fully-read budget only affect the DEFAULT view. `inbox`
  `all=true` reads the retired set from the full fold; the retired set is
  recomputed per fold and must never enter a checkpoint.

## Log compaction (Layer 3, explicit only)

- The board log is append-only; `retainMessages`/`retainFindings` are view
  projections and never shrink the file. The ONLY bound on disk is an explicit
  `tower_do action:"gc"` (orchestrator identity `tower` only, empty `tasks`),
  which rewrites `board.jsonl` as one `{kind:"compact"}` header plus one
  last-wins snapshot event per surviving entity.
- **Revision is preserved**: the header carries the logical `revision`, and
  the snapshot block does not bump it, so a refold after a compact reports
  exactly the revision it did before — a caller's `baseRevision` is never
  invalidated. Appends after the compact bump it as usual (monotonic).
- **Crash/CAS safety**: the previous log is archived only AFTER the CAS
  passes, immediately before the rename (an aborted compact leaves no
  archive behind); the new file is written to `board.jsonl.tmp`, fsynced, the
  live file is re-read through a hard link taken just before the rename (so
  the CAS covers exactly the bytes the swap will replace) and its sha256
  compared to the fold's source, and only then is the tmp renamed over it.
  Every crash point leaves the old file intact.
- **Cross-process mutual exclusion**: `append` and `compact` both take a
  `<board>.lock` lease — a directory created atomically by `mkdir`, holding a
  file named after the holder's random token; the token file's mtime is
  refreshed by a heartbeat while held. Reaping checks each token's own
  mtime, never a directory mtime observed before scanning it (the old
  directory may already have been replaced by a new owner's lease). That closes the previous race where an
  append landing
  between the CAS re-read and the rename wrote to the unlinked inode and was
  lost. A lease is stolen only after `STALE_LOCK_MS` without a heartbeat (dead
  holder). **Ownership is proved by exclusivity**, never by "the mkdir did not
  throw": a reaper can `rmdir` a still-empty lease directory between a
  creator's `mkdir` and its token write, and the write then lands in the
  peer's replacement directory without error — so acquisition requires the
  directory to hold exactly this holder's token (an orphan token is dropped
  and the acquire retried), and the same proof is re-run immediately before
  each mutation (`assertHeld`), because a holder paused past `STALE_LOCK_MS`
  is reaped while it still believes it holds the lease. Release is safe even
  for a stalled holder that was stolen: it unlinks only the file named after
  its OWN token (already removed by the stealer) and then calls `rmdir`, which
  refuses the stealer's non-empty directory — so waking up cannot delete the
  new holder's lease. (A `readFile`-then-`unlink` token check would be a TOCTOU
  and is deliberately not used.) The CAS re-check
  is still
  run immediately before the rename as a second guard for any writer that
  ignores the lease (e.g. an older extension version). The lease is a hard
  requirement for `compact` (it fails closed if the lock cannot be created);
  an `append` may degrade to unlocked when the lock path is unwritable (its
  `O_APPEND` write is still atomic), so a previously writable board does not
  become a hard failure.
- **Rename window**: no userspace lease can exclude a holder paused past
  `STALE_LOCK_MS` between the final proof and the rename, so the compact
  re-proves the lease right AFTER the rename. Immediately before the swap it
  also verifies the path still names the preserved inode: a peer that replaced
  the board (compacted) in the window makes the compact abort with the peer's
  board live, instead of silently swapping it away. On a steal it fails LOUD
  and, if the shape is provable, reconciles under a freshly taken lease: it re-reads
  the live file, requires it to still be its own compaction plus appends and
  the preserved log to be the fold's source plus appends, and rewrites
  `content + P + W` (P before W) with the CAS re-checked at the swap — so the
  peer's window writes end up back in the live fold. When the shape cannot be
  proved (e.g. the peer compacted in the window) it keeps the pre-compact log
  as a hard-linked `board.jsonl.prev-*` evidence file named in the error and
  reports the loud failure; it never rolls the inode back, because a rollback
  could clobber writes the new holder made after the rename.
- **Unfoldable lines block compaction** unless `dropSkipped` is passed (via
  the `tower_do` `dropSkipped` parameter). The dropped count is recorded in the
  compact header as **historical audit metadata** — it is deliberately NOT
  re-added to the live `skipped` count, because after the drop the board no
  longer holds those lines and re-reporting them would be false and would block
  every later compact forever.
- The compact is never periodic: `tower_do_status` only *hints* it (via the
  `State:` log line) at `BOARD_COMPACT_HINT_LINES` / `BOARD_COMPACT_HINT_BYTES`
  or when `skipped > 0`.

## Checkpoint digest (Layer 4)

Session transcripts carry a bounded `pi-tower-do-board-digest` instead of the
full view. Its invariant: **every field's size is bounded by a single named
constant, never by board history** — `openTasks ≤ MAX_TOWER_DO_OPEN_TASKS`,
`findings ≤ MAX_TOWER_DO_OPEN_FINDINGS`, and `counts` is a fixed record (its
only growth is the digit count of a number). No history-shaped array (a
`retiredFindingIds`-style field) may be added. The legacy full-snapshot type
stays readable; a digest-only restore (missing board file) is marked
`incomplete` and disclosed by both the reminder and `tower_do_status`, and is
never used for writes (the write path folds the real file, missing = empty,
revision 0). A restored entry is re-validated per ROW, not only in count: keys
must match the task-key pattern and the rendered subject/title/owner/id fields
are length- and single-line-bounded, so a forged entry cannot materialize an
unbounded or newline-injecting view. `closed`/`retired` travel through a
re-checkpoint: a digest-only view carries no closed rows, so re-size-summarizing
it would persist zero in place of the checkpoint's counts.

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
bun run test/owner-guard.ts         # every-field owner guard + per-task stale-owner takeover (25 cases)
bun run test/presence-retention.ts  # read receipts / retirement / presence / caller-line match / checkpoints (66)
bun run test/finding-exit.ts        # finding lifecycle/budget/view-retirement + bounded checkpoint digest + writer-side digest guards + digest round-trip + forged-digest field bounds + non-finite timestamps (43 cases)
bun run test/changed-files.ts       # P0 receipt invariants (12 cases)
bun run test/scope-conflicts.ts     # P1 glob + conflict derivation (17 cases)
bun run test/git-count.ts           # widget git-segment pure derivations (31 cases)
bun run test/live-sessions.ts       # widget live-segment liveness window + sidecar-record parsing (30 cases)
bun run test/board-progress.ts      # widget board-progress remaining-work glance (8 cases)
bun run test/task-cap.ts            # open-task budget + fabricated-receipt bound (19 cases)
bun run test/board-compact.ts       # explicit log compaction: revision preserved, entity survival, owner-clock + lease/CAS atomicity, token-scoped stale reaping, lease exclusivity + abort cleanup, task revision gate, steal-in-rename-window (loud abort + provable reconcile, else evidence; no blind rollback), both-window P/W reconcile ordering, structural-failure fail-loud (43 cases)
bun run test/home-isolation.ts      # static guard: every index.ts-loading suite isolates HOME before import and imports dynamically (9 cases)
bun run test/view-layers.ts         # layered unfinished view (mine/needs/others) + key ledger + recency order + reminder + folded TUI sections + dashboard budget slice/note (74 cases)
bun run test/limits.ts              # arg schema vs fold: derived bounds, transport guard, key-bearing errors, list-cap ordering, per-entry caps, code-point metric (61 cases)
bun run test/identity-scope.ts      # session scoping: a nested in-process session never re-labels its parent (reminder + status identity), bucket siblings stay distinct (6 cases)
bun run test/identity-label.ts       # identity labels: bucket siblings stay distinct; permission exact, delivery aliased, legacy rows adoptable via the idle window (39 cases)
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
