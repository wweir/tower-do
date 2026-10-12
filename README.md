# tower-do — Shared Project Board + Cross-Session Mail (Pi extension)

> A todo-flavored Pi extension: every session in a project shares one task
> board, and can send messages to the other sessions working on it.

[![npm version](https://img.shields.io/npm/v/tower-do.svg)](https://www.npmjs.com/package/tower-do)
[![Pi gallery](https://img.shields.io/badge/Pi-gallery-7c3aed)](https://pi.dev/packages/tower-do)
[![GitHub](https://img.shields.io/badge/GitHub-wweir%2Ftower--do-181717?logo=github)](https://github.com/wweir/tower-do)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-orange.svg)](LICENSE)

[中文版说明 / Chinese README](./README.zh-CN.md)

## Two features

Parallel coding agents fail at coordination, not at coding. tower-do gives
every session and subagent in a project two things:

1. **A shared todo board.** Plan, claim, update, complete, and block tasks
   with owners and dependencies. Every session reads and writes the same
   board — no daemon, no database, no server, just one file per project.
2. **Cross-session mail.** Send an addressed message to another session (or
   broadcast to `all`) and read your inbox. Mail is stored on the same board,
   so a peer sees it whenever it next looks — and `tower_do_status` surfaces
   your unread count.

Plus a one-line above-editor widget (`TowerDo 3 open · 1 msg`) showing the
current workload.

Three tools:

| Tool | Purpose |
| --- | --- |
| `tower_do` | One atomic board update. `tasks` is an **upsert** list (create or patch); `remove` deletes explicitly. Claim with `owner` + `in_progress`, complete with `status: "completed"`, block with `status: "blocked"` + `blockedBy`. `baseRevision` rejects a stale write instead of clobbering a peer. |
| `tower_do_talk` | `send` an addressed message (recipient must be `all`, `tower`, a current task owner, or an identity with recent board activity; self-send rejected); `inbox` lists and acknowledges your mail. |
| `tower_do_status` | Shared dashboard: every open task (recency-first), completed rows as a key ledger, your messages, and the activity tail. `taskKey` returns one task's full detail. Pass its revision back as `baseRevision`. |

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

**One session + subagents (typical).** The parent plans tasks on the board and
claims owners; hands subagents the board path from `tower_do_status`
(file-as-state); they report back; the parent closes out.

**Multiple sessions, one project.** Both read/write the same
`~/.pi/tower-do/<project>/board.jsonl`. Send a message with `tower_do_talk`;
the peer sees it in `inbox` (and as an unread count in its widget / status).

**Upsert, not replay.** A write lists only the rows it creates or changes — a
key you do not mention is left alone, so a partial write can never drop a
peer's task. Deleting is explicit (`remove: ["key"]`).

Identity resolution: `as` param > config `identity` > session name > session
id. Recording work for a subagent: pass its id (e.g. `as: "coder-1"`).

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
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System boundary, event log & folding, source layout |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Task-model invariants, ownership guard, message contracts, revision gate, test gate |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why: file-as-state, upsert writes, the ownership guard, single-clock takeover |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, config, release flow (tag → CI → npm), troubleshooting |
| [README.zh-CN.md](./README.zh-CN.md) | 中文版说明 |

Quality gate: `bunx tsc --noEmit` plus the suites listed in
[docs/CONTRACTS.md](docs/CONTRACTS.md), enforced in CI on every release tag.

## License

MPL-2.0.
