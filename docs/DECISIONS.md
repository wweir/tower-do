# Decisions — tower-do

> Key decisions and the reasoning behind them. Latest first. Short-lived plans
> / reviews live in docs/plans + docs/reviews and get folded here when they
> become durable rules.

## 2026-09 — widget `live N` segment: presence-derived, never written

**Context.** The widget should show how many sessions are concurrently
running against this project's board.

**Decision.** Derive the count from the activity log (same signal as
`tower_do_status`'s who-is-around): distinct identities with a board event in
the last 30 minutes (aligned with `SESSION_BREAK_GAP_MS`), plus self — a
fresh session with no board writes yet is by definition running. Any board
interaction refreshes liveness (status/inbox append read acks), so the count
tracks tool activity, not OS processes.

Known blind spot, accepted: a session doing pure code work without touching
the board stays invisible until its next board call — a generous window
covers it. A true liveness signal (heartbeats) would add a second write path
to the file-as-state board for one display number; rejected.

Directories without a board file show no `live` segment at all — a
meaningless `live 1` in every random directory would break the widget's
show-something-only-when-there-is-something minimalism. A board-file read
failure keeps the last count (an empty file is `live 1` via self; collapsing
a failed read to that would hide a real `live N`).

**Rejected.** Process/IPC probing (pi sessions are not enumerable portably);
writing a heartbeat event on every turn (board growth + revision churn for
derived data).

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
roster into the session viewpoint: a window containing a merge commit or more than 20
commits re-anchors the window at the new HEAD. A fast-forward pull of few
commits is the accepted blind spot.

Cost bound: refresh hashes at most 2000 dirty paths per settle; past the
cap (or on a hashing failure) the session viewpoint pauses — dirty stays
correct while the baseline re-seeds on a later refresh.

Display: always-labeled `mine M · dirty N` (session viewpoint first; labels
renamed from `sess`/`git` — cryptic viewpoint shorthands violated the same
principle that killed `ΔN`: a reader must tell which number is which without
docs), joined to the board progress line with a dim `│` (progress carries a
dim `done` unit word; widget task rows carry a dim `key:` prefix matching
`tower_do_status` lines). Widget numbers are emphasized by viewpoint
(`mine` = accent, `dirty` = warning); labels stay dim.
Hidden only when both counts are 0, or in a non-git directory. Empty board
still shows a non-empty git segment. Folding equal counts into a single `ΔN`
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
- **Config surface is `identity` only** (config.json, optional, safe to
  commit). Reminder cadence, widget rows, activity tail, and message retention
  are internal constants — no user evidence ever justified tuning them, and
  every knob is permanent schema+docs+test surface. A malformed config fails
  loudly instead of silently defaulting: a silently-reset identity corrupts
  owner matching in multi-agent sessions.
- **Message read receipts (`readBy`) + audience snapshots** so broadcast
  retirement is bounded and late joiners don't pin history forever.
- **Advisory scope today.** `scope` is a declared mission boundary with owner
  gate + schema validation, but no file-level enforcement — enforcement is
  explicitly out of scope until an orchestrator with worktrees exists.
