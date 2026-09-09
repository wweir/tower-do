# Decisions — tower-do

> Key decisions and the reasoning behind them. Latest first. Short-lived plans
> / reviews live in docs/plans + docs/reviews and get folded here when they
> become durable rules.

## 2026-09 — glance rows are mine-first, counts stay board-wide

**Context.** Widget (cap 3) and reminder (cap 12) listed unfinished tasks in
fold order (`updatedAt` ascending). On a busy board the caller's own work
fell into `… +N more` behind older peer or unowned rows. A mine-only filter
or a shortcut toggle would hide the room the glance is supposed to show.

**Decision.** Partition display lists so `owner === identity` rows come first,
preserving relative order inside each group (`orderTasksMineFirst` in
`state.ts`). Identity match is exact (`alice` ≠ `alice-2`); unowned is not
mine. Header `N open`, blocked/unread counts, and overflow `+N more` stay
board-wide — only which rows win the cap changes. Widget and reminder apply
this *before* their caps. `tower_do_status` applies it *inside* each status
group after the dashboard slice (default `limit` 200 never binds below
`MAX_TOWER_DO_TASKS`). An explicit small `limit` still truncates by fold
order, same as before; mine-first does not steal that budget. `owner=` on
status still filters; this is not a second filter.

**Rejected.** Default or togglable mine-only on the widget (a shared board
that hides peers is not a shared board; status already has `owner=`); ranking
by session UUID instead of identity (owner is identity, same as `live N`);
putting unowned backlog in the mine group (anyone may claim it).

## 2026-09 — 0.3.x backlog cull: prune / keybinds / scope-split / gif

**Context.** Four pending rows (`board-prune`, `widget-keybinds`, `dirty-scope`,
`demo-gif`) sat as 0.3.x/0.4 planning. A code-and-contract review showed each
is a category error, not deferred work. This project's `board.jsonl` was 51
lines / 22KB at the time of the cull.

**Decision.** Drop them. Do not re-open as specified:

1. **`board-prune`** (omit completed older than N days on a `tower_do`
   full-replacement) does **not** bound `board.jsonl`. The file is an
   append-only event log (`TowerBoard.append`); omitting a key emits
   `op:remove` and grows the file. It also collides with the completed
   owner-guard/receipts, `dependsOn` (targets must remain in the batch),
   folded `changedFiles` overlap, and `revision` = task-event count. View-layer
   retirement already exists for messages (`retainMessages`); it does not
   rewrite the log. If a board ever needs a byte bound, the design is
   last-wins compaction under the mutation queue — revisit only at 10k+
   lines or when `fold`/`rawLines` show up in a profile.
2. **`widget-keybinds`** (expand completed rows in the above-editor widget)
   fights the glance contract: remaining-work only, cap 3 unfinished,
   completed never appear. Completed already live in `tower_do_status`
   (plus tool-result expand). `pi.registerShortcut` can refresh the widget;
   that is not permission to put completed rows there. See widget-progress
   decision below.
3. **`dirty-scope`** (per-task `mine`/`dirty`) mixes two units. Widget git
   counts are worktree/session global; mission boundary is
   `findScopeConflicts` (scope × receipts, no git). Live git × glob is
   orchestrator territory. See git-segment and P0/P1 decisions below.
4. **`demo-gif`** is marketing, not a product gate. README's PNG already
   matches the documented glance. A CAS/widget-refresh capture needs a human
   two-session TUI recording; do not block a release on an agent-scripted GIF.

**Rejected.** Implementing prune-as-specified "to keep the file bounded"; a
widget toggle that lists completed under the 3-open cap; per-task git counters
in the header; treating a GIF as a version requirement.

## 2026-09 — stale-owner takeover: idle ownership is displaceable

**Context.** The owner guard (every-field, worker/owner/`tower` only) pins a
task to its owner forever — by design for content and receipts, but fatal for
ownership itself: a session that exits (cleanly or not) leaves its non-completed
tasks permanently stuck, and the only documented recourse ("message them or
re-claim via tower") had no working path — a peer messaging the owner got no
answer, and only the orchestrator identity could act. Boards accumulated
`pending` rows pinned by owners no session could ever displace.

**Decision.** Ownership itself is a claim on availability, so it gets a
liveness rule of its own: an owner of a non-completed task whose last board
activity is older than `OWNER_TAKEOVER_MS` (= `SESSION_BREAK_GAP_MS`, 30 min)
— or who never started and whose task has sat untouched that long — is
displaceable (`staleTaskOwners` in state.ts, pure derivation; `tower_do`
feeds it the full activity log and the liveness sidecar records). A peer may **adopt** (set `owner` to
itself, strictly nothing else — `taskEquals` against the existing task minus
the owner swap) or **remove** the non-completed task. Completed tasks keep the
full guard: a receipt cannot be dropped or forged by a peer, however idle its
author. The liveness sidecar is the tiebreaker between "exited / crashed"
and "alive but heads-down": an owner with a fresh `live/` heartbeat record
(`LIVE_WINDOW_MS`) is never stale, however quiet on the board. The record's
`identity` is the session identity; `aliases` are extra owner labels this
session has written as (`as: "coder-1"`) so a parent recording work for a
subagent stays protected while its process heartbeats. `live N` still counts
identity only — aliases do not inflate the widget. No liveness data
(unreadable sidecar dir) disables the exception rather than loosening it. `tower_do` errors carry an actionable hint when they reject a
stale-owned task ("adopt it by setting owner to yourself"), and the gate
reads on itself: no activity log → no stale owners → strict guard. Because
this is a permission gate, it reads the FULL board log (`TowerBoard.rawLines`,
the same file `fold()` already reads) — a bounded tail could truncate an
active owner's recent events in a churny fleet and let a peer displace them.

Properties: the threshold is far beyond the 10-minute display-only idle mark
(`PRESENCE_IDLE_MS`) so a heads-down worker is never raced; a fresh
assignment is protected by its fresh `updatedAt` ("just assigned, not begun
yet" stays unstartable — the unstarted/idle distinction derivePresence
already makes); adoption is ownership-only, so the every-field guard's
promise survives (a peer can displace a dead claim, never silently rewrite
content). Unowned pending rows are deliberately NOT expired — backlog that
nobody claimed is work, not garbage; the exit mechanism keeps cleaning only
the liveness sidecar, and task lifecycle stays explicit.

**Rejected.** Auto-clearing owners on `session_shutdown` (a clean exit says
nothing about the work being abandoned, and the board is cross-session —
losing the claim history would orphan legitimately unfinished work);
releasing owned tasks after `PRESENCE_IDLE_MS` (10 min: races a worker in a
long tool call); letting the adopter re-plan in the same write (adoption plus
arbitrary content edits would bypass the every-field guard — the adopter can
re-plan in a second write once it owns the task); expiring unowned pending
tasks (backlog, not garbage); deriving staleness from board activity alone
(the sidecar heartbeat already answers "is the process still there?" —
ignoring it would let a peer displace a worker who is 30 minutes deep in a
coding stretch and has not touched the board).

## 2026-09 — widget `live N`: per-session liveness sidecar, watched

**Context.** The widget should show how many sessions are concurrently
running against this project's board. The first cut derived the count from
the board activity log (distinct identities with an event in the last 30
minutes, plus self) and refreshed it only on `session_start` /
`agent_settled`. Both directions were wrong for minutes at a time: a new
session was invisible to peers until its first board call (so an old session
kept `live 1` while the newcomer already saw `live 2`), a session doing pure
code work stayed invisible, and a crashed session haunted the count until its
last activity aged out of the window. The blind spot accepted below the old
entry is superseded.

**Decision.** Liveness is a different signal from board activity ("process
running" vs "touched the board"), so it gets its own channel:
`~/.pi/tower-do/<project>/live/<identity>.<sessionId>.json` — one file per session,
rewritten on a 30s heartbeat (`LIVE_HEARTBEAT_MS`), deleted on clean exit.
The count is a pure derivation (`liveSessionCount` in state.ts over the
sidecar records): distinct identities with a record fresh within 2 minutes
(`LIVE_WINDOW_MS`), plus self. `fs.watch` on the sidecar dir and board.jsonl
(debounced, started in `session_start`, torn down in `session_shutdown`)
makes peer enter/exit/write visible within one tick; board events also fold
into the widget's progress segment. Wiring gates on board existence — no
board, no `live` segment, no sidecar writes in non-tower projects.

Properties that made a per-session file beat appending to a shared log:
heartbeat writes never contend cross-process (own file, temp + rename);
exit is a delete (unambiguous, instant); a crash expires after four missed
heartbeats instead of 30 minutes; the channel is bounded (O(sessions) files,
not O(heartbeats) lines) so no truncation races. `board.jsonl` keeps exactly
task/message/finding events — liveness never churns `revision` or the
activity feed. Still counted by identity: one configured identity running
three sessions reads `live 1` (roles, not processes, are what a coordinator
reasons about).

**Rejected.** Heartbeat events appended to board.jsonl (a second write path
on the board plus unbounded growth, for a display number — same reason as
the original rejection); process/IPC probing (pi sessions are not enumerable
portably); counting sessions instead of identities (an orchestrator's
subagents would inflate the count); folding the board on live-dir events
(30s heartbeat churn per peer for data the heartbeat cannot change).

## 2026-09 — widget progress counts remaining work, not lifetime

**Context.** The widget header showed `TowerDo x/y done · rev N`. Both numbers
only ever grow: completed rows are routinely retired in place (the owner
guard and `dependsOn` pin them), so the fraction tracks board *lifetime*, not
work; and `rev` is a monotonic CAS token backing the `baseRevision` gate, not
a metric.

**Decision.** The glance counts remaining work only — `TowerDo N open`, plus
`· M blocked` / `· K msg` when present (`formatBoardProgress` in `state.ts`,
suite `test/board-progress.ts`). Completed tasks never appear; a board of
only completed rows renders no progress segment (git/live segments remain).
Unread mail alone keeps the segment alive, so hiding the progress line never
hides the inbox signal. `rev` stays in `tower_do_status`, where the CAS
token belongs.

**Rejected.** Keeping `x/y done` with completed rows excluded from the
denominator (the fraction still grows with board lifetime, and flipping the
numerator's meaning while keeping the shape reads backwards to anyone who
knew the old widget); `open N` without the `TowerDo` title (collides with
finding counts — a reader can't tell which counter it is); showing `rev`
next to progress (monotonic gate token, not a workload metric).

## 2026-09 — widget git segment: dirty vs session, same unit

**Context.** The above-editor widget should show how dirty the worktree is and
how much of that this session caused, without a second unit (lines, commits).

**Decision.** Two file counts, one unit:

- **dirty** = `git status --porcelain -z -uall` entries (NUL-separated, no
  C-quoting; untracked directories expanded to file granularity; a rename/copy
  is one entry — the destination). Status runs from the toplevel so paths are
  root-relative regardless of `status.relativePaths`.
- **session** = files whose content this session actually changed. First
  observation freezes the attribution window at the current HEAD
  (`rev-parse --verify HEAD`; unborn → the empty tree) and hashes every
  dirty path (`git hash-object`; missing, non-file, or newline-named paths
  use an `absent` sentinel). Each refresh folds the *incremental* window
  `lastHead..HEAD` into the persistent set: a path counts if its worktree
  hash differs from the baseline, it is new, it left the dirty set with a
  blob different from the baseline, or it appears in the window with a blob
  different from the baseline — the last one catches edits that were made
  *and* committed between two refreshes. Pre-dirty files this session never
  edits do not count. A later commit can still show `mine N · dirty 0`.

External HEAD movement (pull / rebase / branch switch) never folds its
roster into the session viewpoint: the previous HEAD not being an ancestor
of the current one (branch switch / rebase / diverged pull — ancestry is the
only signal a *small* switch emits; a merge/count heuristic alone folds it
into `mine`), a window containing a merge commit, or a window of more than 20
commits, all re-anchor the window at the new HEAD. Forward-only small moves
— a fast-forward pull, or a switch to a *descendant* branch with few
commits — carry no signal that distinguishes them from the session's own
commits short of tracking the branch ref (which would mislabel a
session-created branch as external), so they are the accepted blind spot.

Cost bound: refresh hashes at most 2000 dirty paths per settle; past the
cap (or on a hashing failure) the session viewpoint pauses — dirty stays
correct while the baseline re-seeds on a later refresh.

Display: always-labeled `mine M · dirty N` (session viewpoint first; labels
renamed from `sess`/`git` — cryptic viewpoint shorthands violated the same
principle that killed `ΔN`: a reader must tell which number is which without
docs), joined to the board progress line with a dim `│` (progress carries
dim `open`/`blocked`/`msg` unit words; widget task rows carry a dim `key:`
prefix matching `tower_do_status` lines). Widget numbers are emphasized by
viewpoint (`mine` = accent, `dirty` = warning); labels stay dim. Hidden only
when both counts are 0, or in a non-git directory. Empty board still shows a
non-empty git segment. Folding equal counts into a single `ΔN`
was rejected — it hid which viewpoint the number belonged to.

**Rejected.** Counting both rename endpoints as dirty (breaks the same-unit
fold against porcelain entries); a rename may still count source+dest in
`sess` — path-level content change. Disabling the segment on any git failure
(an `index.lock` would hide it for the rest of the session). Gating
`agent_settled` refresh on widget registration (empty board then never
initializes the segment). Subtracting the first-observation *path* set (`sess`
stayed 0 while editing already-dirty files). Using the *worktree* `git diff
<startHead>` as `sess` (a dirty worktree then makes `sess` ≈ `git`). Sampling
only `lastDirty` vs current dirty (edits committed between two refreshes were
invisible). Folding `startHead..HEAD` monotonically (one `git pull` polluted
`touched` with foreign files for the rest of the session — hence the
incremental window + re-anchor). C-style quoting on porcelain output (`"`,
`\`, tabs still get
quoted even with `quotePath=false`; `-z` removes quoting entirely). Leaving
`?? dir/` collapsed (one `absent` sentinel absorbed every later change inside
an untracked directory).

## 2025-09 — share "changed files" as boundary facts, not diffs (P0 + P1)

**Context.** Research asked whether multiple agents editing one repo should
broadcast their file-change lists to each other. Naive answers (post every diff
/ file list to the board) fail: a diff is a *flow*, the board is a *converging
snapshot* (model mismatch); unconditional sharing burns context and is noise;
and broadcasting changes who *sees*, not who *tells the truth* — trust needs
tool-read git, not more copies.

**Decision.** Share **subtracted signals**, not the raw list:

1. **P0 — `changedFiles` delivery receipt.** A completed task may carry the
   files its owner actually changed (a worker sets it once when completing;
   the owner / `tower` may amend — worker edits to another's receipt are
   rejected by the every-field owner guard). It is *audit trail*, explicitly
   *not* an authority — never a merge gate.
   Rationale: closes the handoff information gap (a dependent task knows what
   its upstream touched) and the trust gap (scope used to be only a *plan*;
   the receipt is the closest thing to a *fact* the board can hold without
   git access).
2. **P1 — derived scope-conflict advisory.** `tower_do_status` derives
   *overlap* (active task's scope ⊃ a completed task's receipt file) and
   *collision* (two in-progress tasks' scope globs intersect) warnings. Advisory
   only — because scope is a self-declared glob and changedFiles is
   self-reported, neither is authoritative enough to gate on.

**Rejected.** Tool-read `git diff` + scope-containment merge gates (Kimi
Tower's real mechanism). Requires worktree isolation + a merge orchestrator —
a different project. If it ever lands, TowerDo stays the state/communication
backend and the orchestrator consumes the board.

## Prior decisions (condensed from the initial port)

- **File-as-state over locks/daemon.** Board = append-only JSONL; any reader
  sees the same tasks. Communication and state are the same storage primitive.
  (Kimi Tower blackboard lineage; see research/kimi-tower-*.)
- **Revision counts task events only** so messages/findings never stale a peer's
  baseRevision.
- **Full-replacement + every-field owner guard** over per-field merge: with
  full replacement, an unguarded content field would let a stale replay roll
  back a peer's concurrent update.
- **`tower` reserved identity** as the orchestrator escape hatch (owner of
  everything). It is not claimable via config, so no session can *drift into*
  the orchestrator role by default; an explicit `as: "tower"` call remains the
  documented (unauthenticated, cooperative-trust) way for the orchestrator to
  act. Same class of collision: the broadcast keyword `"all"` is rejected as
  any identity (config / `as` / owner).
- **Config surface is `identity` only** (config.json in `$HOME/.pi/agent/tower-do/`,
  optional, global across projects — a personal pin, not a committed team
  setting; a leftover per-project state dir is auto-migrated into the global
  records home, and ignored (never an error) when the global state dir already
  exists). Reminder cadence, widget rows, activity tail, and message retention
  are internal constants — no user evidence ever justified tuning them, and
  every knob is permanent schema+docs+test surface. A malformed config fails
  loudly instead of silently defaulting: a silently-reset identity corrupts
  owner matching in multi-agent sessions.
- **Message read receipts (`readBy`) + audience snapshots** so broadcast
  retirement is bounded and late joiners don't pin history forever.
- **Advisory scope today.** `scope` is a declared mission boundary with owner
  gate + schema validation, but no file-level enforcement — enforcement is
  explicitly out of scope until an orchestrator with worktrees exists.
