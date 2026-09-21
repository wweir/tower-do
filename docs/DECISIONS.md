# Decisions — tower-do

> Key decisions and the reasoning behind them. Latest first. Short-lived plans
> / reviews live in docs/plans + docs/reviews and get folded here when they
> become durable rules.

## 2026-09 — board exit: four layers, no single TTL

**Context.** Boards accumulated without bound in four DIFFERENT ways, and every
prior fix addressed one while leaving the others: findings had NO exit at all
(append-only, no budget; `tower_do_status` rendered the newest 20, so the oldest
debt was permanently invisible — one board held 73 open findings, the oldest
14 days old, from sessions long gone); messages could be retired from the view
but the file never shrank; completed task rows and superseded upserts made
`board.jsonl` grow to hundreds of KB; and every compact/reminder checkpoint
copied the WHOLE folded view into the session transcript (measured: a single
321 KB `pi-tower-do-board` entry; 147 entries ≈ 2.77 MB in one session).

**Decision.** Split the problem into four layers with distinct mechanisms:

1. **Finding lifecycle + budget** (state machine, `MAX_TOWER_DO_OPEN_FINDINGS`
   = 50 charged to every NON-closed finding, close/snooze reasons required,
   claim defaults to the caller, liveness routes but never resolves).
2. **View retirement** (`retainFindings`, `retainMessages` age valve): pure,
   in-memory, never touches the file; `view=all` / `findingId` / `inbox all`
   read the retired rows back.
3. **Explicit log compaction** (`tower_do action:"gc"`, `tower` only): the
   single-file last-wins rewrite with a `{kind:"compact"}` revision header,
   content CAS and archive. Cross-process safety is a per-board directory
   LEASE (`<board>.lock`, exclusivity proved by the holder's token, stale
   tokens reaped by heartbeat age) that both `append` and `compact` take, plus
   a CAS re-checked through a hard link taken just before the swap. No
   userspace lease can exclude a holder paused past `STALE_LOCK_MS` inside the
   rename window, so the compact re-proves the lease right after the rename
   and, on a steal, reconciles the window under a fresh lease when the shape is
   provable (`content + P + W`, P before W) and otherwise keeps the pre-compact
   log as a `<board>.prev-*` evidence file and fails loud — never a blind
   rollback, which could clobber writes the new holder made after the rename.
4. **Bounded checkpoint digest**: `pi-tower-do-board-digest` replaces the full
   view in the transcript; every field is bounded by a named constant.

Also corrected two pre-existing clocks that made the old exits unreliable:
`staleTaskClaims` now charges staleness to activity **on that task** (the old
`lastSeen` was board-global, so one unrelated message immunized every stale
row) at `TASK_CLAIM_STALE_MS` (6 h), separate from the 30 min presence hint.
The derivation is per **claim** (`owner+task`), and so are its consumers: it
used to return owner labels while the guard applied them per owner, which let
one long-idle row expose the same owner's freshly touched row to takeover or
removal — the per-task clock's own failure mode, in the permission layer. The
same pass fixed the rejection hint, whose completed branch keyed on the
owner-level set instead of the row: it fired whenever the owner happened to be
stalled on some *other* row (a completed row never enters the set, so the
condition was never about the row being rejected), annotating a receipt as
"owner idle" and naming no usable remedy. The other branch's "adopt it … or
remove it" was sound for a genuinely stalled row but, with an owner-level set,
got appended to rejections of rows the owner had touched a minute earlier. The
remedy is now chosen by the row's `status`, and the claim set only decides
whether that row's claim is dead.

**Rejected.** A single age TTL over all record classes (hides actionable
bug/vuln reports — the opposite of an exit); closing a finding because its
reporter's session ended (liveness ≠ resolved); `retiredFindingIds` in the
digest (O(history) in the one place that must be bounded); letting a snooze
skip the budget (a free way to clear it, and then the digest is unbounded
again); `board.base.jsonl` as a second file the old line-counting fold would
have to reconcile (double counting at the crash midpoint); periodic automatic
compaction (unverifiable audit loss — compaction is explicit, named, and
archived).

**Consequences.** `board.jsonl` can still grow in bytes until an explicit
`gc`; `tower_do_status` discloses the log size and hints the command. The
budget error names the oldest rows, so the backlog is actionable instead of
invisible. The compact preserves `revision`, so no caller's `baseRevision` is
invalidated by it. See CONTRACTS.md "Finding contracts" / "Log compaction" /
"Checkpoint digest" and docs/plans/board-exit.md (landed).

## 2026-09 — a session label carries entropy; legacy labels alias their own session

**Context.** The board identity for a session was `session-<first 8 chars of
the session id>`. pi session ids are UUIDv7 hex (`8-4-4-4-12`), so those 8
digits are the top 32 bits of a 48-bit millisecond timestamp: pure time, no
entropy. Every session started inside one 65536 ms (65.5 s) bucket therefore
resolved to the SAME identity — two sibling subagents 26 ms apart both became
`session-01a0b47e`. The identity is the owner-guard key, the liveness-sidecar
key and the message-audience key, so colliding sessions could edit each other's
tasks, each heartbeat kept the other's ownership alive, and presence rendered
two agents as one line. Parallel subagent launches are this extension's
advertised workflow, so co-start inside one bucket was the norm (finding
f-79d6f380-a2e).

**Decision.** `sessionLabel(id)` = `session-<time8>-<rand8>`, where the suffix
is 8 hex digits of the id's random tail (32 bits of within-bucket
discrimination; a bucket holds ~65 s of starts, and parallel siblings differ in
their tail with probability 1 − 2⁻³²). Labels stay short and keep the readable
time prefix, because a model or human retypes them into `owner=`, `to=` and
`as=` — a 42-character full id would trade a rare collision for frequent
transcription errors. The full id was rejected for that reason; a hash of the
full id was rejected as machinery that buys nothing over the ULID/UUIDv7 tail
the id already carries; widening the prefix (e.g. 10 hex digits = 2048 ms) was
rejected because it is still pure timestamp.

**Migration, and where the alias may apply.** Rows, receipts and messages
written before 0.4.1 carry the legacy label, which cannot name one member of its
bucket. The alias is therefore split by consequence:

- **Permission stays exact.** The owner guard (change and removal), the
  staleness gate and the takeover path compare labels character for character,
  exactly as before. Aliasing them would let any bucket sibling edit or delete a
  legacy row — the same collision wearing permission clothes. A legacy row is
  reached by its own label, by `tower`, or through the idle-window takeover
  (adopt, then edit in a second write). 0.4.1 shipped with the permissive
  version and 0.4.2 tightened it to this rule.
- **Delivery and display alias.** `sameAgent` (exact equality plus legacy →
  current of the same bucket) is used for inbox `to`/`from`/audience, read
  receipts (purely additive — an existing legacy receipt is left as written),
  recipient validation and the dashboard's `me` markers. It may over-deliver
  inside one bucket (the pre-0.4.1 reach, never worse) and must never lose mail.
  It is deliberately NOT transitive, so grouping stays keyed: `derivePresence`
  merges a legacy row only into a bucket holding exactly one current label.

Gate: `test/identity-label.ts` (39 cases) plus the in-process collision case in
`test/identity-scope.ts`; reverting `sessionLabel` to the legacy form fails both.

## 2026-09 — session identity is per extension instance, never a module global

**Context.** pi runs subagent task sessions in-process (they appear as
`sessions/<parent>/tasks/<child>.jsonl`), and every `towerDoExtension(pi)` call
in that process shares module scope. The extension kept its ambient session
context in a module-level variable, so a child session's `restore()` re-labelled
its parent. Observed live while auditing this repo: the parent's board reminder
announced `you are session-01a0b47e` (a subagent), then `you are main` after the
child's `session_shutdown` cleared the global, while the parent's own tasks were
owned by `session-01a0b444`. The parent's liveness heartbeat wrote the child's
identity, so a live owner read as idle and its tasks became displaceable after
the takeover window; presence and `live N` merged the two sessions. The tool
path masked it — `prepare()` assigned the global to its own ctx immediately
before resolving the caller — which is why task writes stayed correctly
attributed and the bug survived.

**Decision.** Session-scoped state lives in the extension closure (`selfCtx`),
and `sessionIdentity`/`resolveCaller` take the calling session's context
explicitly; no module-level mutable session state. Gate:
`test/identity-scope.ts` loads two instances into one process and asserts the
parent's reminder and status identity are unchanged after the child starts
(verified by reintroducing the global: the parent was re-labelled
`session-bbbbbbbb`).

**Rejected.** Keying a module-level cache by `pi` in a `WeakMap` (correct only
while pi hands every session its own API object; an explicit ctx is correct
under either) and clearing the global on `session_shutdown` (a child's shutdown
then wipes the parent's context — observed as `you are main`).

**Also filed (fixed in 0.4.1).** The default identity was `session-<first 8
chars of the session id>` — pure timestamp, zero entropy. (Corrected: pi session
ids are UUIDv7 hex, so those 8 hex digits are the top 32 bits of a 48-bit
millisecond timestamp and the collision bucket is 65536 ms = **65.5 s**, not the
1024 ms first reported.) Observed live: two sibling subagents
(`01a0b47e-b9bf…`, `01a0b47e-b9d9…`, 26 ms apart) both became
`session-01a0b47e`, and their liveness records cross-protected each other's
ownership. See the 0.4.1 entry above for the fix.

## 2026-09 — content limits are enforced by the fold, guarded by the schema

**Context.** An 85-task replay was rejected preflight by the host's
arg-schema validation: `tasks.84.description: must not have more than 2000
characters`. The description had grown from a stored 1664 characters (83% of
the cap) to 2224; the error named only the array index, the whole write was
aborted before the extension ran, and the host echoed the entire 85-task
payload (6279 characters) back into context to say so. The limit existed
twice — `maxLength: 2_000` in the arg schema and the same check in the fold —
with different wording, and the layer that fired first was structurally
incapable of naming the task it rejected (an instance path can only carry an
index). The two layers also disagreed on the metric (host: UTF-16 units for BMP
text, grapheme clusters for astral text; fold: `String.length`), so which error
a caller saw depended on the characters involved.

**Decision.** One definition per limit (`state.ts` constants, exported) and one
owning layer per rule class. An **element-level** rule (anything under
`tasks[i].*`) is enforced by the **extension**, because only it can name the
task, and its arg-schema bound is `transportLimit(limit)` = 2× — a payload
guard, not a rule. A **named top-level field** (`as`, `to`, message `subject`,
finding `title`/`summary`) keeps the business limit in the schema, because that
error path already names the field. The guard is safe rather than arbitrary: the
host's counted length is never larger than the extension's code-point count
(plain BMP text: equal; astral or combining text: fewer), so a value the
extension accepts is never refused preflight, and 2× keeps a realistic
overshoot (the incident was 1.11×) on the key-bearing path; it is deliberately
not an upper bound on payload, since one grapheme may carry thousands of code
points. The extension counts Unicode **code points** (`textLength`) — one emoji
is one character, unlike `String.length` — and its messages name index, key,
measured length, limit and remedy
(`tasks[84].description (cg-release-145-catalog-fix) is 2224 characters
(max 2000) — shorten it, or omit the field to preserve the stored text`). The
tool and field descriptions state the limits so a caller can budget without
being told. Gates: `test/limits.ts` (derived bounds for element and named
fields, the enforced limit and limit + 1 pass the real registered schema, the
guard refuses a gross overflow, key-bearing rejection for text AND counts,
code-point boundary, combining text still reaching the extension,
omission-preserves).

**Rejected.** Keeping the schema bound equal to the enforced limit and only
re-wording the messages (the host still fires first for BMP text — the
extension's actionable error stays unreachable and the payload echo stays); a
much looser guard such as 20k (widens the preflight echo by an order of
magnitude and buys nothing — the guard is a payload bound, not the business
rule); silently truncating to the limit (the silent-wrong class this extension
exists to prevent); switching the metric to UTF-8 bytes (a legal
1664-character Chinese description is already ~5KB, so a byte cap would shrink
the budget of boards holding valid text) or to grapheme clusters
(`Intl.Segmenter`, and the host's own count is already a hybrid of UTF-16 units
and graphemes, so matching it exactly buys nothing at a real cost).

**Also.** The guard bounds one field, not the write: the preflight echo is
dominated by the number of rows, and `tasks` deliberately has no `maxItems`
(completed rows are receipts that replay free, and a full replay is mandatory),
and combining-heavy text passes any `maxLength` guard, so an invalid write can
still echo a large payload. That is a host-behaviour +
full-replacement-design issue, filed as a finding (f-04f7935e-b9a) rather than
papered over by a row ceiling that would break the capacity contract.

## 2026-09 — open-task budget: completed rows never block a new plan

**Context.** The batch cap (`MAX_TOWER_DO_TASKS` = 50) was checked against the
whole write batch, and `tower_do` is a full replacement, so it was a
*board-size* cap that charged completed rows. A real project board reached 50
rows with every one `completed` (43 owned by six departed sessions, 7 unowned):
adding a task needed a 51st row, and dropping a peer's completed row is
rejected by the owner guard (receipt integrity). Only `as: "tower"` could
compact, no remediation was documented, and ordinary sessions stopped planning
on that board (finding f-902d6eb6-4ab) — the board was write-blocked by its own
finished history.

**Decision.** The budget is charged to **open (non-completed) work**:
`MAX_TOWER_DO_OPEN_TASKS` = 50 bounds non-completed rows, while completed rows
are receipts/history and replay free — **batch length is not a budget at all**,
so a full replay is legal however long the history gets (replay is mandatory,
and any length ceiling just recreates this deadlock at a higher threshold).
What stays bounded is *fabricated history*: one write may introduce at most
`MAX_TOWER_DO_OPEN_TASKS` new completed keys. The completed-row owner guard is
unchanged. The cap errors and the status header state the capacity and the
remediation (omit your own or an unowned row, or compact a finished board with
an `as: "tower"` write).

**Rejected.** Raising the fixed cap (moves the wall, never removes it); any
batch-length ceiling, fixed or board-relative (same deadlock at a higher
threshold); archive/prune of completed rows into a separate file (reopens the
`board-prune` rejection — removal only appends `op:remove` to the same log, and
the folded view already has display budgets); auto-dropping completed rows of
idle owners (destroys the audit trail the guard exists to protect);
sticky-completed omission ("omitting a completed row keeps it") — then nothing
could ever remove one, and the board would grow without bound in the folded
view.

**Also.** `MAX_TOWER_DO_TASKS` was doing double duty as the live-alias cap; it
is split into `MAX_TOWER_DO_ALIASES` (identities a session remembers) and
`MAX_TOWER_DO_OPEN_TASKS` (work a board carries). The alias side is a rename
only: same value, same behaviour. `MAX_TOWER_DO_OPEN_TASKS` itself carries two
readings on purpose — work the board carries, and history one write may invent
(both derive from the one constant, so a retune moves them together instead of
letting them drift); CONTRACTS.md *capacity* is the authority for both.

**Consequence — the dashboard can now outgrow its budget.** Boards were
previously capped at 50 rows, so `tower_do_status`'s 200-row dashboard slice
could never bind. It can now, so the slice became a rule instead of an
accident: under the default budget open rows win it (stable partition, groups
keep fold order), an explicit `limit` still means fold order verbatim, and any
hidden rows are reported (`… +N more row(s) hidden by the budget`, with the
remedies: a larger `limit`, or `owner=`/`status=` narrowing). Without that, a
long completed history would silently hide the one open row the caller needed
to see.

**Known limit.** Completed history is unbounded now, and every write must name
the rows it keeps — so the practical ceiling is what a caller can *read*, and
the dashboard binds long before the log does: 200 rows, plus the host's caps —
50KB **and** 2000 lines — whose **tail-kept cut removes the head** (header,
revision, board file path, and the open rows, which render first). The line cap
is structural rather than routinely reachable now that completed rows pack
several keys per line — the byte cap binds first — but it stays enforced.
The cut is therefore disclosed in a footer that repeats the revision and the
board path (its bytes and its one line are reserved out of both caps), and
paged reads of `board.jsonl` stay the complete path. The `board-prune` entry's
~10k log lines remain the trigger for row-level log compaction (last-wins under
the board write lease, receipts folded, never silently deleted) — not for row
deletion.

## 2026-09 — publish auth moves to trusted publishing (OIDC), no token

**Context.** `release.yml` published with `NODE_AUTH_TOKEN:
${{ secrets.NPM_TOKEN }}`. The token expired (npm defaults new tokens to 7
days), which failed the v0.3.5 release with `E404`; a token without bypass
2FA fails with `E403`, and npm removes bypass-2FA direct-publish tokens in
January 2027. A long-lived publish token is a standing secret to rotate and
leak.

**Decision.** Publish with npm **trusted publishing**: keep `id-token: write`,
drop `NODE_AUTH_TOKEN`, upgrade npm (needs >= 11.5.1; Node 22 ships older) and
fail loud below that version. Authentication is a short-lived OIDC exchange
scoped to this workflow, and provenance is automatic. The npm-side connection
is package `tower-do` → Settings → Trusted Publisher → GitHub Actions
(`wweir` / `tower-do` / `release.yml`) with **Allow `npm publish`** explicitly
enabled — connections created after 2026-09-03 default to stage-only.
`package.json` `repository.url` must keep matching the GitHub repository, or
npm refuses the exchange.

**Rejected.** Keeping the token as a fallback in the same job: it would mask an
OIDC misconfiguration (the publish would succeed via the token, so the switch
would be unverified). Staged publishing (`npm stage publish` + manual 2FA
approval) is the stronger posture, but this repo releases on tag push and a
manual approval per release was not wanted.

## 2026-09 — reminder cadence is independent of snapshot strip

**Context.** `session_compact` / `before_agent_start` persist a
`TOWER_DO_BOARD_TYPE` custom message in the transcript. The `context` hook
strips those (and `TOWER_DO_REMINDER_TYPE`) so a peer cancel cannot linger
in the LLM window. The same `hadBoardContext` flag (since removed; the
current mechanism is `llmCallsSinceReminder`) also skipped `REMINDER_INTERVAL`: once a snapshot was in the window, every subsequent
LLM call re-injected a fresh reminder.

**Decision.** Strip is unconditional; cadence always counts the call. A
leftover snapshot is removed even on the 1st/2nd call of the interval, and
a replacement reminder is injected only when the counter hits
`REMINDER_INTERVAL` (3). Because the strip also removes the snapshot a
forced checkpoint just injected, `session_compact` (willRetry / pending
messages) and `before_agent_start` arm the counter
(`REMINDER_ARMED = REMINDER_INTERVAL - 1`) so the immediately following
context event replaces it with a fresh one; the every-3 cadence then
resumes. An all-done board still strips and never re-injects.

**Rejected.** Refreshing the snapshot every call (keeps the LLM current,
but the periodic reminder is then a standing prompt). Counting only calls
that had no leftover snapshot (cadence would stall for the rest of a
session after the first compact). Resetting the forced-checkpoint counter
to 0 (the checkpoint's own snapshot is stripped before the LLM sees it, so
its board context would never arrive).

## 2026-09 — dashboard layers unfinished work; completed folds to a key ledger

**Context.** A long-lived board carried 38 completed rows from ten departed
sessions while the caller's own work was one row. `tower_do_status` rendered
every completed receipt in full (measured: 211 bytes/row — subject, scope,
changedFiles) and every open finding as an untruncated single line (one
measured 2000+ characters), while the TUI result folded the FIRST 14 lines. The
reader therefore saw other sessions' history and the top of the board, and the
sections that need action (messages, findings) fell past the fold. The text
layer keeps the TAIL over 50KB; the TUI kept the head — the two cuts pointed
opposite ways.

**Decision.** Render unfinished rows in three layers and receipts as a ledger.

- `mine` (the caller's unfinished work), `needs` (peer work the caller is
  coupled to: its own unfinished work awaits it, a message to the caller
  threads under it, or it awaits the caller's unfinished work), `other`.
- Order inside every layer is recency-first (`updatedAt` DESC, `key` ASC). Fold
  order hid the newest work behind the oldest as soon as a cap applied.
- Completed rows render as a compact key ledger (several keys per line), so the
  first screen is not spent on other sessions' receipts; subject / scope /
  changedFiles are one `taskKey` lookup away. The ledger prints the STORED
  status — it is the value a replay writes back, and echoing the derived
  `blocked` view would turn a parked reason into a stored status. The dashboard
  budget and the host byte/line caps still bound the ledger exactly as they
  bounded rows before — a key outside the budget was already unenumerable, and
  that cut was already disclosed.
- Findings render as one truncated line (`DASHBOARD_FINDING_LINE_CHARS`); the
  full text moves behind a new `findingId` read. `suggestedFix` leaves the
  list.
- The default `view` is `layers`: the caller's own unfinished rows and the
  peer rows it is coupled to render in full; every other unfinished row folds
  into a one-line shape summary plus a `key status @owner` ledger. `view=all`
  expands that layer, `mine` narrows to the caller's own rows, and `needs`
  stays an alias for `layers`; an excluded layer folds into the same ledger, it
  never disappears.
- The `needs` layer also covers a declared `scope` intersecting the caller's
  own unfinished scope: a peer about to edit the same files affects the caller,
  so it is shown rather than folded. The reminder and the widget follow the
  same split — their rows carry the caller's own work and the coupled peer
  work, and the unrelated layer folds to one key line (`formatOtherKeysLine`)
  or a count, never to nothing.
- The TUI result folds **by section** (mine / needs / findings / messages
  first) instead of by line count.
- The widget's git segment renames `mine N` to `files N`: the segment shares
  its line with the board's task counts, and "mine" already names the caller's
  task layer one field earlier.

**Rejected.** Dropping peer rows from the default view (a full-replacement
write must enumerate every key, or `tower_do` fails and unowned work is
silently dropped); the earlier mine-first ordering as the whole answer (it
reorders rows within a cap but still spends the window on other sessions'
receipts, and it has no `needs` layer, so a caller blocked on a peer sees only
a key); counting keys as rows so the 200-row dashboard budget could bound the
ledger (that budget bounds rows and the ledger is deliberately fewer rows than
keys — `view=all` plus the byte-cap disclosure stay the honest bound).

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
   last-wins compaction under the board write lease — revisit only at 10k+
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

**Decision.** Ownership is a claim on availability, so it gets a liveness
rule of its own: an owner idle past `OWNER_TAKEOVER_MS` may be displaced on a
non-completed task — **adopt**
it (set `owner` to yourself, strictly nothing else) or **remove** it.
Completed tasks keep the full guard (a receipt cannot be dropped or forged by
a peer), and the sidecar heartbeat (session identity plus `as` aliases)
keeps an alive-but-heads-down owner from being raced. The exact mechanism,
failure modes, and inert-on-bad-data rules are the contract in CONTRACTS.md
§ Stale-claim exception.

**Superseded (2026-09).** The threshold is no longer 30 min: `OWNER_TAKEOVER_MS`
is now an alias of `TASK_CLAIM_STALE_MS` (**6 h**), so the two cannot drift,
and the 30 min `SESSION_BREAK_GAP_MS` serves only presence/session-break
display. CONTRACTS.md § Stale-claim exception is authoritative.

Properties: the threshold is far beyond the 10-minute display-only idle mark
(`PRESENCE_IDLE_MS`) so a heads-down worker is never raced; a task assigned
to a never-active owner is protected by its fresh `updatedAt` ("just
assigned, not begun yet" stays unstarted — the unstarted/idle distinction
derivePresence already makes). Staleness is judged PER owner+task pair: a
fresh `updatedAt` protects only its own row, and an owner's activity on one
task never protects their other rows (exact label matching, never
bucket-sibling activity). Adoption is ownership-only, so the every-field
guard's promise survives (a peer can displace a dead claim, never silently
rewrite content). Unowned pending rows are deliberately NOT expired —
backlog that nobody claimed is work, not garbage; the exit mechanism keeps
cleaning only the liveness sidecar, and task lifecycle stays explicit.

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
  edits do not count. A later commit can still show `files N · dirty 0`.

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

Display: always-labeled `files M · dirty N` (session viewpoint first; labels
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
