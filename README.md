# tower-do — Shared Multi-Agent WIP Board (Pi extension)

> A todo-flavored Pi extension inspired by **Kimi Tower's multi-worker orchestration** design. Multiple agents (sessions / subagents) share a live view of "what's in progress" plus task-bound communication state.

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

[中文版说明 / Chinese README](./README.zh-CN.md)

## Install

**Option 1 — from npm (recommended)**

```bash
pi install npm:tower-do
```

**Option 2 — from git**

```bash
pi install git:https://github.com/wweir/tower-do.git@main
```

**Option 3 — manual copy to the global extensions dir**

```bash
mkdir -p ~/.pi/agent/extensions && cp -r tower-do ~/.pi/agent/extensions/
```

Pi auto-discovers the extension at startup; existing sessions pick it up with `/reload`. Runtime dependencies (`typebox`, `@earendil-works/*`) are provided by the Pi environment (declared as peerDependencies — no manual install needed).

## Tools

| Tool | Purpose |
| --- | --- |
| `tower_do` | One-shot atomic board update: plan / claim (`owner` + `in_progress`) / complete / block (`blocked` + `blockedBy`). Supports `baseRevision` for clobber protection |
| `tower_do_talk` | Cross-agent messaging: `send` (to a known owner or `all`; self-send rejected), `inbox`, `finding` (structured out-of-scope report / status update) |
| `tower_do_status` | Shared dashboard: everyone's WIP (owner / deps / scope / block reasons), messages for you, open findings, activity tail |

Identity resolution: `as` param > project config `identity` > session name > session id. When recording work on behalf of a subagent, pass its id (e.g. `as: "coder-1"`).

## Mapping to Kimi Tower (design correspondence)

| Kimi Tower mechanism | tower-do implementation |
| --- | --- |
| Shared blackboard (file-as-state) | `<project>/.pi/tower-do/board.jsonl`, append-only JSONL folded into the current view; any session/subagent that can read the file sees the same WIP |
| Role separation (workers touch only their own mission) | Tasks carry `owner`; only the owner or the reserved identity `tower` can change its status/scope (out-of-scope writes error out) |
| Mission scope | Tasks carry `scope` (file globs), visible to all, extendable only by owner/tower |
| Negotiation (interoffice mail / findings) | `tower_do_talk`: recipient must be a known owner or `all`, self-send forbidden; out-of-scope discoveries go through `finding` instead of silent edits |
| Deterministic gate (revision-based read) | Board `revision` is derived from the event count (write result = re-fold result); stale `baseRevision` is rejected — never silently overwrite a peer's update |

## Multi-agent usage

**One Pi session + subagents (typical)**: the parent `tower_do`s out tasks and claims `owner`s; hand the board path printed by `tower_do_status` to subagents (file-as-state), they report results back, the parent closes out with `tower_do` (or records on their behalf with `as`). Model dependencies with `dependsOn` (unfinished deps surface as block reasons).

**Multiple Pi sessions sharing one project**: both sides read/write the same `<project>/.pi/tower-do/board.jsonl` automatically; one session sends a message, the other reads it via `inbox` — that is cross-agent messaging made concrete.

## Scope: what counts as a "project"

The board is shared per **project**, not per literal working directory. Each session's `cwd` is first resolved upward to the **nearest git root** (a repo containing `.git`, or a worktree/submodule whose `.git` is a file with `gitdir:`); **if no git boundary is found, the directory itself is the project boundary**.

| Scenario | Effect |
| --- | --- |
| Sessions in `/repo` and `/repo/src` | Same board (same git root) |
| Repo-root session + any nested dir session | Shared (both anchor to repo root) |
| Two unrelated non-git dirs | Independent (dir is the boundary) |
| Nested git repos (child has own `.git`) | Each anchors to its own root, no crossing |
| Git worktree (`.git` is a file) | Worktree root is the boundary |

`config.json` anchors to the same project root: `identity` is **project-level** — different sessions in the same project share one identity config.

## Configuration (optional)

`<project>/.pi/tower-do/config.json`:

```json
{ "identity": "team-orchestrator", "reminderInterval": 3, "collapsedTaskLimit": 3, "activityTail": 8, "messageRetention": 50 }
```

- `reminderInterval`: inject a board-reconciliation reminder every N LLM calls (0 = off)
- `identity`: pin this session's identity (otherwise session name / session id)
- `collapsedTaskLimit`: max unfinished-task rows shown in the widget (overflow folds to `… +N more`)
- `activityTail`: number of activity lines shown by `tower_do_status`
- `messageRetention`: message retention budget — **fully-read** old messages past this budget leave all read views (default 50, `0` = keep all, legacy behavior); unread / partially-read messages never leave

## Design notes & conventions

- **Every write path re-folds inside `withFileMutationQueue`**: baseRevision validation and diffing both run against the latest lock-held view, eliminating read-then-write races (same verifiability philosophy as the Kimi Tower store).
- Every change is an appended event (`{kind, task|message|finding, ...}`); revision = cumulative task-event count, and **the revision a write returns exactly equals a re-fold**. A `tower_do` call with no field changes (no-op) replies `board unchanged`, appends no event, and **keeps the original `updatedAt` without drift**.
- **Delete is guarded + full-board replacement**: `tower_do` replaces the whole board — every omitted key is deleted. Deletion is only allowed for your own or unclaimed tasks; deleting another's owned task is rejected by the owner guard. Dependency validation runs on the **post-write graph**: surviving tasks may not depend on tasks deleted in the same write (clear deps with `dependsOn: []` first, then delete), nor on tasks absent from the board or not provided by this write. A task's status/owner/scope may only be changed by owner/tower (subject/description are unprotected; they may ride along in a full-board LWW rewrite).
- Message bodies ≤ 32 KB; use pointer-style references for long reports to keep context lean.
- **Messages carry read receipts**: `readBy` records who read; reading via `tower_do_talk inbox` auto-acks (appends a same-id event; LWW fold dedupes). A broadcast's **sender does not count as a reader** (self-sent messages never enter your own inbox), so a broadcast can retire once every other owner has read it. On send, the current owner list is **snapshotted as `audience`**: owners joining later are not part of the audience and cannot pin an old broadcast forever. **Backward compat for historical logs**: old broadcasts without an `audience` field are **back-filled at fold time** from the owner table at the replay point (owners present at send time, sender excluded; owner transfers don't leak old owners; later ack replays never widen an already back-filled audience).
- **Undeliverable messages auto-retire**: a named message whose recipient has left the board (rebuilt/cleared, nobody can read it) counts as read and can retire; a **broadcast whose whole audience has left** (round of testing/coordination over, board rebuilt under fresh owners) can retire too — finished broadcast rounds don't squat the retention budget forever because nobody reads them. Orphan messages never grow the folded view without bound.
- **Historical-message exit**: all read views (status / inbox / reminder / widget) go through `retainMessages` — **unread never exits**; only when fully-read messages exceed the `messageRetention` budget do the oldest read ones leave the view. The append-only event log on disk is preserved (audit); the fold output no longer bloats.
- **Presence derived with zero writes**: the `Who is around` section of `tower_do_status` aggregates recent timestamps from the activity log by `by` (pure read — never marks the reader as active), listing only **people with unfinished tasks** or **people active within the last hour**; other historical identities fold into a count. Three states: **active** (touched recently), **`⚠ idle`** (was active but no action for 10+ minutes — coordinator may message or reclaim), **(not started)** (newly assigned, never active on the board — not stalled, not a false idle). `tower_do` write receipts also footnote real idle owners. The `Recent activity` section renders compact human lines (`who · time · glyph detail`); message acks show as `👁 read` instead of re-sends. When adjacent events are > 30 min apart, a `── session break ──` divider separates "same continuous session" from "multiple sessions apart"; a header line `last updated N ago by X` (derived purely from the activity tail) makes it obvious at a glance whether the board is stalled — `revision` is monotonic but carries no liveness.
- Done criteria: mark a task `completed` only after implementation + verification succeed; when waiting on a dependency or peer use `blocked` + `blockedBy`, don't leave it hanging.
- In-memory state is only a widget/reminder cache; the disk file is the single source of truth; if the workspace is cleaned up, recover from the most recent session checkpoint (custom entry).

## Verification

```bash
cd <repo>                # repo root
bun install              # install devDeps (bun-types + typescript); only needed for typecheck/tests
bunx tsc --noEmit -p tsconfig.json   # authoritative typecheck (strict + noUnused)
bun run test/smoke.ts                # smoke: ownership/delete overreach, dangling deps, stale revision, messages/findings, cross-instance persistence, all three tools end-to-end
bun run test/owner-guard.ts          # full-field owner guard regression (10 cases)
bun run test/presence-retention.ts   # read receipts + historical exit + presence derivation + feed rendering/session breaks + orphan/audience retirement regression (34 cases)
```

Smoke covers: planning persistence, dependency blocking/unblocking, `tower` bypass & arbitrary delete, owner-only change/delete enforcement, dangling-dependency interception, same-write delete-with-dependent rejection / clear-then-delete allowance, stale `baseRevision` rejection, interoffice mail delivery & inbox, `tower` as a legal recipient, self-send ban, single-line field constraint, invalid status filter error, finding reporting & dashboard visibility, cross-subdir/nested-repo/worktree project scoping, second session reading the same board.

## Files

```
├── index.ts     # extension entry: 3 tools + widget + reminder + lifecycle
├── state.ts     # pure schema/validation/fold/snapshot/read-retention/presence derivation
├── board.ts     # disk layer: append-only JSONL (file-as-state) + config
├── test/smoke.ts
├── test/owner-guard.ts
├── test/presence-retention.ts
├── tsconfig.json  # typecheck only
└── README.md
```

References: Kimi Tower's multi-worker orchestration design (official Tower blog/docs) and the reference extension implementation <https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>.
