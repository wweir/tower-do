# Product — tower-do

> Product scope and high-level experience. Architecture in ARCHITECTURE.md,
> contracts in CONTRACTS.md, decisions in DECISIONS.md.

## What it is

A **shared multi-agent task board** for the Pi coding agent — a todo-flavored
Pi extension inspired by Kimi Tower's multi-worker orchestration. Multiple
agents (Pi sessions, or one session + subagents) share a live view of *what's
in progress* plus task-bound communication state, without any central server.

## Scope

- **Shared task board**: plan / claim / update / complete / block tasks; model
  ownership and dependencies.
- **Cross-agent messaging**: addressed mail between owners + structured
  out-of-scope findings for a coordinator to route. Findings have an explicit,
  auditable exit: a claim/close/snooze lifecycle with reasons, a bounded
  non-closed budget (so the backlog is actionable instead of silently
  accumulating), and a pressure-ordered list that never hides the oldest debt.
- **Global status dashboard**: who owns what, blocks, unread messages, open
  findings, activity, presence. The default view is caller-centred — your own
  unfinished work first, then the peer work you are coupled to (a dependency,
  unread mail, or an intersecting declared scope); everything else folds into a
  one-line shape summary plus a compact key ledger. `view=all` expands the
  folded layer and `view=mine` narrows to your own rows; completed rows are
  always a compact key ledger.
- **Conflict awareness**: `changedFiles` delivery receipts on completed tasks
  and derived `scope` conflict advisories (overlap / collision) so parallel
  workers see boundary collisions before they write.

**Out of scope** (deliberate): worktree isolation, merge orchestration, CI,
tool-read git-diff merge gates. Those belong to a Tower-style orchestrator;
TowerDo is its state/communication substrate.

## Experience

- **One session + subagents (typical).** The parent plans on the board and
  claims owners; hands subagents the board path from `tower_do_status`
  (file-as-state); they report back; the parent closes tasks (or records on
  their behalf with `as`). Dependencies via `dependsOn` surface as block
  reasons.
- **Multiple sessions, one project.** Both sides read/write the same
  `~/.pi/tower-do/<project>/board.jsonl`; send a message, the other reads it via
  `inbox`.
- **Advisory conflict signals.** Completing a task with `changedFiles` and
  declaring `scope` turns the board into an early-warning surface: a planner
  whose scope overlaps a just-finished task's files, or two in-progress tasks
  with intersecting scopes, are flagged in `tower_do_status` — resolve by
  messaging, not by gate.
- **Above-editor widget.** Board progress plus two segments: `live N` (sessions
  running against this board right now — each session heartbeats a tiny
  liveness sidecar file and deletes it on exit; `fs.watch` makes peers
  appear/disappear within a second or two; crashed sessions expire after a
  2-minute silence window; counted by identity, so one configured identity
  running three sessions reads `live 1`; hidden in directories without a
  board) and the git segment (`files M · dirty N`):
  worktree dirty file count vs files whose content this session actually
  changed (pre-dirty files count only if edited again; edits committed between
  refreshes are counted too, while a mid-session pull re-anchors attribution
  instead of counting pulled files; later commits can leave `files N · dirty 0`).
  Same unit, two labeled viewpoints; the git segment hides when both counts
  are 0 or the directory is not git; on an empty board the live segment alone
  still shows. Unfinished-task rows (capped) are layered mine → needs you →
  others, recency-first; open/blocked/unread counts stay board-wide, and the
  overflow note names the attention rows that did not fit.

## Identity

`as` param > config `identity` > session name > session id. Recording
work for a subagent: pass its id (`as: "coder-1"`).
