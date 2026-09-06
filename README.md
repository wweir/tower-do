# tower-do — Shared Multi-Agent WIP Board (Pi extension)

> A todo-flavored Pi extension inspired by **Kimi Tower's multi-worker orchestration** design. Multiple agents (sessions / subagents) share a live view of "what's in progress" plus task-bound communication state.

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

[中文版说明 / Chinese README](./README.zh-CN.md)

## What it does

Shared WIP board for parallel Pi agents: plan / claim / complete / block tasks
with owners + dependencies, cross-agent messaging + findings, and a global
status dashboard. **Conflict awareness**: completing a task with `changedFiles`
(a delivery receipt of files you actually changed) plus declared `scope` file
globs lets `tower_do_status` flag *overlaps* (an active task's scope matches a
just-completed task's receipt) and *collisions* (two in-progress tasks'
scopes intersect) — advisory warnings, resolved by messaging, not gates.

Three tools:

| Tool | Purpose |
| --- | --- |
| `tower_do` | One-shot atomic board update: plan / claim (`owner` + `in_progress`) / complete (`changedFiles` receipt) / block (`blocked` + `blockedBy`). `baseRevision` protects against clobbering |
| `tower_do_talk` | Cross-agent messaging: `send` (known owner or `all`; self-send rejected), `inbox`, `finding` (structured out-of-scope report / status update) |
| `tower_do_status` | Shared dashboard: everyone's WIP (owner / deps / scope / changedFiles / block reasons), **scope conflicts**, messages, open findings, activity + presence |

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

Pi auto-discovers the extension at startup; existing sessions pick it up with `/reload`. Runtime dependencies (`typebox`, `@earendil-works/*`) are provided by the Pi environment (peerDependencies — no manual install needed).

## Quick tour

**One session + subagents (typical).** Parent plans tasks on the board and
claims owners; hands subagents the board path from `tower_do_status`
(file-as-state); they report back; parent closes out. **Multiple sessions, one
project.** Both read/write the same `<project>/.pi/tower-do/board.jsonl` — send
a message, the peer reads it via `inbox`.

Identity resolution: `as` param > project config `identity` > session name >
session id. Recording work for a subagent: pass its id (e.g. `as: "coder-1"`).

## Configuration

One optional key — `<project>/.pi/tower-do/config.json`. No environment
variables.

```json
{ "identity": "team-orchestrator" }
```

| key | default | meaning |
| --- | --- | --- |
| `identity` | session name/id | pin this session's board identity (project-level); must not be the reserved orchestrator identity `tower` |

That is the whole surface. Absent file = defaults; unknown keys are ignored
(forward compatibility); a malformed file or invalid `identity` fails loudly at
session start — never silently defaulted, because a silently-reset identity
would corrupt owner matching in multi-agent sessions. The file holds no
secrets and is safe to commit for shared team settings; gitignore only
`board.jsonl`. Details: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Architecture

Three layers, strict dependency direction (top depends on bottom, never
reverse):

```text
Pi sessions / subagents (multiple, same project)
   │  tower_do · tower_do_talk · tower_do_status  (+ widget, reminders)
   ▼
index.ts   extension layer — tool params & prompt contract, TUI widget,
           board-reconciliation reminders, session lifecycle
   ▼
state.ts   pure core — schema + validation (every-field owner guard,
           baseRevision stale gate), event fold, read derivations (presence,
           blocked, scope conflicts, message retention); no I/O
   ▼
board.ts   disk layer — append-only JSONL event log; every read re-folds
           from disk, writers append single-line events
   ▼
<project>/.pi/tower-do/board.jsonl   single source of truth (file-as-state,
                                     shared by all sessions; gitignore it)
```

Write path: tool params → validate + revision gate → append event(s) → fold →
view. Read path: re-fold events into a view, derive everything else — there
are no mutable state files besides the log. Full data flow and derivations:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Doc | Content |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product scope & high-level experience |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System boundary, event log & folding, read derivations (presence / block / scope conflicts / retention) |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Task-model invariants (incl. `changedFiles` receipt + scope-conflict contracts), ownership guard, revision gate, test gate |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why: share boundary facts not diffs (P0/P1), file-as-state, every-field owner guard, advisory scope |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, config, runtime layout, troubleshooting |
| [README.zh-CN.md](./README.zh-CN.md) | 中文版说明 |

## Files

```text
├── index.ts     # extension entry: 3 tools + widget + reminder + lifecycle
├── state.ts     # pure schema/validation/fold/read-derivations (no I/O)
├── board.ts     # disk layer: append-only JSONL (file-as-state) + config
├── test/        # smoke + owner-guard + presence-retention + changed-files + scope-conflicts + config
├── docs/        # PRODUCT / ARCHITECTURE / CONTRACTS / DECISIONS / OPERATIONS
└── README.md
```

## Verification

```bash
bun install               # devDeps — typecheck/tests only
bunx tsc --noEmit -p tsconfig.json   # strict + noUnused, zero errors
bun run test/smoke.ts               # end-to-end: 3 tools, persistence, scoping, changedFiles disk round-trip
bun run test/config.ts              # config fail-loud + reserved identity (11 cases)
bun run test/owner-guard.ts         # every-field owner guard (10 cases)
bun run test/presence-retention.ts  # read receipts / retirement / presence (34)
bun run test/changed-files.ts       # P0 delivery-receipt invariants (10 cases)
bun run test/scope-conflicts.ts     # P1 glob matching + conflict derivation (17 cases)
```

See [docs/CONTRACTS.md](docs/CONTRACTS.md) for what each suite proves.

References: Kimi Tower's multi-worker orchestration design (official Tower
blog/docs) and the reference extension implementation
<https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>.
