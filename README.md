# tower-do — Shared Multi-Agent Task Board (Pi extension)

> A todo-flavored Pi extension inspired by **Kimi Tower's multi-worker orchestration** design. Multiple agents (sessions / subagents) share a live view of "what's in progress" plus task-bound communication state.

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-orange.svg)](LICENSE)

[中文版说明 / Chinese README](./README.zh-CN.md)

![tower-do above-editor widget: board progress (`TowerDo 6 open · 1 blocked`), live session count, `mine/dirty` file segments, and annotated unfinished-task rows](https://raw.githubusercontent.com/wweir/tower-do/main/docs/pi-tower-do.png)

## What it does

Parallel coding agents fail at coordination, not at coding: they clobber each
other's files, redo finished work, and never know who is doing what. tower-do
gives every agent in the project one shared board to plan, claim, and finish
work — and the manners to talk about it.

- **One board, many agents.** Plan, claim, complete, and block tasks with
  owners and dependencies. Every session and subagent reads and writes the
  same board — no daemon, no database, no setup beyond installing the
  extension.
- **Finish with receipts.** Completing a task records the files you actually
  changed (`changedFiles`), so whoever picks up the next task knows what just
  moved under them.
- **Talk where the work lives.** Addressed messages to a task's owner (or
  broadcast to all), plus structured findings (bug / improve / vuln / idea)
  for out-of-scope discoveries — routed to the right agent, not lost in chat.
- **Conflict awareness.** The dashboard flags when your task's declared scope
  overlaps files a peer just changed, or when two in-progress tasks declare
  intersecting scopes — advisory warnings you resolve by messaging, never
  gates that block you.
- **Who is around.** Presence shows which sessions are active, idle, or gone
  quiet while still owning unfinished work — so a coordinator knows whom to
  ping instead of reassigning blind.
- **A widget that explains the room.** The above-editor line shows remaining
  work (`TowerDo 2 open · 1 blocked`), how many sessions are live, which dirty
  files are yours vs. the worktree's, and the unfinished tasks with owners.

Three tools:

| Tool | Purpose |
| --- | --- |
| `tower_do` | One-shot atomic board update: plan / claim (`owner` + `in_progress`) / complete (`changedFiles` receipt) / block (`blocked` + `blockedBy`). `baseRevision` protects against clobbering |
| `tower_do_talk` | Cross-agent messaging: `send` (owner / recent-activity identity / `all`; self-send rejected), `inbox`, `finding` (structured out-of-scope report / status update) |
| `tower_do_status` | Shared dashboard: everyone's in-progress work (owner / deps / scope / changedFiles / block reasons), **scope conflicts**, messages, open findings, activity + presence; `taskKey` returns one task's full detail |

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

Pi auto-discovers the extension at startup; existing sessions pick it up with `/reload`.

## Quick tour

**One session + subagents (typical).** Parent plans tasks on the board and
claims owners; hands subagents the board path from `tower_do_status`
(file-as-state); they report back; parent closes out. **Multiple sessions, one
project.** Both read/write the same `~/.pi/tower-do/<project>/board.jsonl` — send
a message, the peer reads it via `inbox`.

Identity resolution: `as` param > config `identity` > session name >
session id. Recording work for a subagent: pass its id (e.g. `as: "coder-1"`).

## Configuration

One optional key — `~/.pi/agent/tower-do/config.json` (global, applies to every
project). No environment variables.

```json
{ "identity": "team-orchestrator" }
```

| key | default | meaning |
| --- | --- | --- |
| `identity` | session name/id | pin this session's board identity (global, applies to every project); must not be the reserved orchestrator identity `tower` |

## How it works

One append-only JSONL file per project (`~/.pi/tower-do/<project>/board.jsonl`)
is the single source of truth — state and communication are the same storage.
Every read re-folds the log; writes carry a monotonic revision so a peer's
concurrent update is rejected instead of silently clobbered. System boundary,
event semantics, and read derivations:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Doc | Content |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product scope & high-level experience |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System boundary, event log & folding, source layout, read derivations (presence / block / scope conflicts / retention) |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Task-model invariants (incl. `changedFiles` receipt + scope-conflict contracts), ownership guard, revision gate, test gate |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why: share boundary facts not diffs (P0/P1), widget segments, file-as-state, every-field owner guard, advisory scope |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, config, release flow (tag → CI → npm), troubleshooting |
| [README.zh-CN.md](./README.zh-CN.md) | 中文版说明 |

Quality gate: `bunx tsc --noEmit` plus nine test suites, enforced in CI on
every release tag — the list and what each suite proves live in
[docs/CONTRACTS.md](docs/CONTRACTS.md).

References: Kimi Tower's multi-worker orchestration design (official Tower
blog/docs) and the reference extension implementation
<https://github.com/99percentpeople/pi-extensions/blob/master/extensions/todo/index.ts>.
