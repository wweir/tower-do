# Operations — tower-do

> Deployment, configuration, running, and troubleshooting. Product scope in
> PRODUCT.md; contracts/tests in CONTRACTS.md.

## Install

Three equivalent routes (README has the commands):

1. **npm (recommended)** — `pi install npm:tower-do` (auto-discovered at next
   startup; `/reload` picks it up in an existing session).
2. **git** — `pi install git:https://github.com/wweir/tower-do.git@main`.
3. **manual** — copy to `~/.pi/agent/extensions/`.

Runtime deps (`typebox`, `@earendil-works/*`) are peer dependencies provided by
the Pi host — no manual install. Dev-only `bun install` (bun-types +
typescript) is for typecheck/tests.

## Configuration

`<project>/.pi/tower-do/config.json` is the only configuration surface — no
environment variables. The file is optional (absent = defaults) and safe to
commit for shared team settings: it holds no secrets. Only `board.jsonl`
belongs in `.gitignore`.

```json
{ "identity": "team-orchestrator" }
```

| key | default | meaning |
| --- | --- | --- |
| `identity` | session name/id | pin this session's board identity (project-level); must not be the reserved orchestrator identity `tower` |

That is the whole surface. Reminder cadence, widget rows, activity tail, and
message retention are internal tuning constants, not configuration. Unknown
keys are ignored (forward compatibility). A malformed file or invalid
`identity` fails loudly at session start — it is never silently defaulted,
because a silently-reset identity would corrupt owner matching and message
addressing in multi-agent sessions.

## Runtime layout

- Board: `<project>/.pi/tower-do/board.jsonl` (append-only event log — the
  single source of truth; keep it out of git via `.gitignore`).
- Checkpoints: on session compact / agent start, the view is embedded as a
  custom context entry (fallback display when the board file is missing).
- Widget: above-editor status line (TUI only).

## Troubleshooting

- **"stale tower-do revision"** — a peer wrote since your read. Call
  `tower_do_status`, merge your changes onto the fresh view, retry with the new
  `baseRevision`.
- **"owned by ..."** — you touched another owner's task. Only its owner or
  `tower` may; message the owner via `tower_do_talk`, or have `tower` do it.
- **Board file missing / empty view after cleanup** — falls back to the last
  session checkpoint for display (disk stays authoritative).
- **Conflicting scope advisories** — advisory only: message the peer owner or
  re-scope. They never block writes.
- **Peer edits invisible** — every read path re-folds from disk; if a widget
  looks stale, any tool call refreshes `currentView`. Cross-process writers are
  last-writer-wins past the revision gate (single-tower assumption).
