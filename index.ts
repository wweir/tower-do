/**
 * tower-do — a shared multi-agent task board for pi.
 *
 * Fuses the coordination design of Kimi Tower's multi-worker orchestration
 * into a todo-style extension:
 *
 *  - file-as-state: the board lives in `<project>/.pi/tower-do/board.jsonl`
 *    (append-only JSONL; folding events yields the current view). Every agent
 *    session — or a subagent pointed at the board path — sees the same tasks.
 *  - ownership: tasks may carry an `owner`; only the owner or the reserved
 *    orchestrator identity "tower" may change an owned task's fields
 *    (workers touch only their own missions).
 *  - scope: optional file-glob list describing what a task may touch; visible
 *    to everyone; only owner/tower may change it (the mission boundary).
 *  - negotiated handoff, not blind clobber: tower_do_talk delivers addressed
 *    messages (recipient must be a known owner or "all", self-send rejected)
 *    and files structured findings; tower_do_status is the shared dashboard.
 *  - merge gate, simplified: the monotonic board `revision` is read from the
 *    file (tool-read, never self-reported) and backs the baseRevision guard —
 *    a stale write is rejected instead of silently overwriting a peer's work.
 *
 * Usage:
 *   tower_do           — plan / claim / update / complete / block shared tasks
 *   tower_do_talk      — send an inbox message to a task owner / read your
 *                        inbox / file a structured finding
 *   tower_do_status    — shared dashboard: everyone's tasks, blocks, messages,
 *                        open findings, and the activity tail
 *
 * Identities: default to the session identity (config `identity` >
 * session name > session id). Pass `as` to act for a subagent you spawned
 * (e.g. as "coder-1") when recording its work on the shared board.
 *
 * Reference style: mirrors 99percentpeople/pi-extensions/extensions/todo.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  keyHint,
  truncateTail,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Type } from "typebox";

import {
  normalizeBoardConfig,
  TowerBoard,
  type TowerDoConfig,
} from "./board.ts";
import {
  cloneBoard,
  createEmptyBoard,
  DEFAULT_IDENTITY,
  derivePresence,
  findAllUnresolvedDeps,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  formatActivityFeed,
  formatBoardReminder,
  findScopeConflicts,
  formatPresenceLine,
  getAllTasks,
  isTowerDoStatus,
  latestActivity,
  MAX_FINDING_SUMMARY_CHARS,
  MAX_FINDING_TITLE_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_TOWER_DO_TASKS,
  messagesToMe,
  parseActivityLine,
  readBoardSnapshot,
  relativeTime,
  retainMessages,
  taskIsBlocked,
  TOWER_DO_BOARD_TYPE,
  TOWER_DO_REMINDER_TYPE,
  TOWER_DO_STATUS_TOOL_NAME,
  TOWER_DO_STATUSES,
  TOWER_DO_TALK_TOOL_NAME,
  TOWER_DO_TOOL_NAME,
  TOWER_IDENTITY,
  TowerDoValidationError,
  unreadMessagesToMe,
  writeBoardSnapshot,
  type ActivityEntry,
  type FindingKind,
  type FindingSeverity,
  type FindingStatus,
  type TowerBoardView,
  type TowerDoFinding,
  type TowerDoMessage,
  type TowerDoStatus,
  type TowerDoTask,
} from "./state.ts";

const WIDGET_KEY = "pi-tower-do-widget";

// Internal tuning constants — deliberately NOT user config (DECISIONS.md:
// no user evidence ever justified tuning them, and every knob is permanent
// schema+docs+test surface).
const REMINDER_INTERVAL = 3; // inject a board reminder every N LLM calls
const WIDGET_TASK_LIMIT = 3; // unfinished tasks shown in the above-editor line
const STATUS_ACTIVITY_TAIL = 8; // activity feed lines in tower_do_status
const MESSAGE_RETENTION = 50; // max fully-read messages kept in the view

// ---------------------------------------------------------------------------
// Config (project-scoped, best-effort JSON)
// ---------------------------------------------------------------------------

interface BoardEntry {
  board: TowerBoard;
  config: TowerDoConfig;
}

// ---------------------------------------------------------------------------
// Project-root anchoring
//
// The board is shared per *project*, not per working directory. A project is
// the nearest ancestor that is a git work tree (a `.git` directory) or a git
// worktree/submodule (a `.git` *file*); when no git boundary exists, the
// directory itself is the project. So `cd /repo` and `cd /repo/src` sessions
// read and write the same board, while two unrelated directories stay
// isolated even when neither is under git.
// ---------------------------------------------------------------------------

function isGitMark(p: string): boolean {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return true;
    if (st.isFile()) {
      // A `.git` file marks a git worktree / submodule checkout; its content
      // is `gitdir: <path>`.
      return readFileSync(p, "utf8").startsWith("gitdir:");
    }
    return false;
  } catch {
    return false;
  }
}

const projectRootCache = new Map<string, string>();

/** Nearest git work-tree root for `cwd`, else `cwd` itself (directory = scope). */
export function projectRoot(cwd: string): string {
  const cached = projectRootCache.get(cwd);
  if (cached !== undefined) return cached;
  let dir = cwd;
  for (;;) {
    if (isGitMark(join(dir, ".git"))) {
      projectRootCache.set(cwd, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  projectRootCache.set(cwd, cwd);
  return cwd;
}

function towerDoDir(cwd: string): string {
  return join(projectRoot(cwd), CONFIG_DIR_NAME, "tower-do");
}

function boardFileFor(cwd: string): string {
  return join(towerDoDir(cwd), "board.jsonl");
}

function loadConfig(dir: string): TowerDoConfig {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return {};
  // Fail loud, never silently default: a broken config would drop a pinned
  // identity and corrupt owner matching / message addressing in multi-agent
  // sessions. Annotate every failure with the path — JSON.parse and
  // normalizeBoardConfig errors alone do not carry it.
  try {
    return normalizeBoardConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `tower-do config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class BoardCache {
  private readonly entries = new Map<string, BoardEntry>();

  entryFor(cwd: string): BoardEntry {
    const file = boardFileFor(cwd);
    let entry = this.entries.get(file);
    if (entry === undefined) {
      entry = {
        board: new TowerBoard(file),
        config: loadConfig(towerDoDir(cwd)),
      };
      this.entries.set(file, entry);
    }
    return entry;
  }
}

const boards = new BoardCache();

// Module-scope session handle shared with sessionIdentity (identity fallback
// to the session id) and reset on session_shutdown.
let lastContext: ExtensionContext | undefined;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Resolve the acting identity: config > session name > session id. */
function sessionIdentity(cwd: string | undefined, pi: ExtensionAPI): string {
  const entry = cwd === undefined ? undefined : boards.entryFor(cwd);
  const configured = entry?.config.identity?.trim();
  if (configured) return configured;
  const sessionName =
    typeof pi.getSessionName === "function"
      ? pi.getSessionName()?.trim()
      : undefined;
  if (sessionName) return sessionName;
  const sessionId =
    typeof lastContext?.sessionManager.getSessionId === "function"
      ? (lastContext.sessionManager.getSessionId() ?? "")
      : "";
  if (sessionId) return `session-${sessionId.slice(0, 8)}`;
  return DEFAULT_IDENTITY;
}

function resolveCaller(
  as: string | undefined,
  cwd: string | undefined,
  pi: ExtensionAPI,
): string {
  const caller = as?.trim();
  if (!caller) return sessionIdentity(cwd, pi);
  if (/[\r\n\u2028\u2029]/.test(caller)) {
    throw new TowerDoValidationError("as must be a single line");
  }
  if (caller.length > 64) {
    throw new TowerDoValidationError("as must be at most 64 characters");
  }
  if (caller === "all") {
    throw new TowerDoValidationError(
      'as must not be the reserved broadcast recipient "all"',
    );
  }
  return caller;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TaskKeySchema = Type.String({
  description:
    "Stable 1-40 character lowercase task key, e.g. auth-refactor or feat-gemm",
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});

const TowerDoTaskSchema = Type.Object({
  key: TaskKeySchema,
  subject: Type.Optional(
    Type.String({
      description:
        "Short imperative task subject; required for a new key, omitted to preserve an existing value",
      minLength: 1,
      maxLength: 160,
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Long-form task description; omitted to preserve, empty string to clear",
      maxLength: 2_000,
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
      description:
        "Current task status; required for a new key, omitted to preserve. Use blocked when waiting on a dependency or a peer.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        'Agent/session identity that owns this task. Only the owner or the orchestrator identity "tower" may change its fields (status/owner/scope/changedFiles/subject/description/dependsOn/blockedBy).',
      maxLength: 64,
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Dependency keys; must exist on the shared board or in this call. Omitted to preserve, empty array to clear.",
      maxItems: 20,
    }),
  ),
  scope: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional file-glob list describing what paths this task may touch (Tower mission scope). Only owner/tower may change it.",
      maxItems: 20,
    }),
  ),
  changedFiles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Delivery receipt: files the owner actually changed. Only settable when status is "completed" (set it in the same call that completes the task). A worker may set it once; its owner or "tower" may amend later (the owner guard rejects other workers). Paths are repo-relative.',
      maxItems: 100,
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional keys (message/finding ids) describing what blocks this task. Advisory; visible to everyone.",
      maxItems: 20,
    }),
  ),
});

const TowerDoParamsSchema = Type.Object({
  tasks: Type.Array(TowerDoTaskSchema, {
    description:
      "Complete authoritative task list to retain; omitted current keys are removed. Existing tasks may omit unchanged fields; new keys require subject and status.",
    maxItems: MAX_TOWER_DO_TASKS,
  }),
  baseRevision: Type.Optional(
    Type.Integer({
      description:
        "Board revision you last observed (from tower_do_status). Rejects stale writes when a peer changed the board since; omitting it disables the stale-write check.",
      minimum: 0,
    }),
  ),
  as: Type.Optional(
    Type.String({
      description:
        "Identity to act as (default: your session identity). Pass a subagent id when recording work on its behalf.",
      maxLength: 64,
    }),
  ),
});

const TalkParamsSchema = Type.Object({
  action: StringEnum(["send", "inbox", "finding"] as const),
  to: Type.Optional(
    Type.String({
      description:
        'send: recipient identity — "all" or a task owner on the board. Self-send is rejected.',
      maxLength: 64,
    }),
  ),
  subject: Type.Optional(
    Type.String({
      description: "send: short subject",
      maxLength: MAX_MESSAGE_SUBJECT_CHARS,
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: `send or finding: the message body or finding summary (send: max ${Math.round(MAX_MESSAGE_BYTES / 1024)} KiB — split oversized content into multiple messages)`,
    }),
  ),
  taskKey: Type.Optional(TaskKeySchema),
  kind: Type.Optional(
    StringEnum(["bug", "improve", "vuln", "idea"] as const, {
      description: "finding: kind (required when filing a new finding)",
    }),
  ),
  severity: Type.Optional(
    StringEnum(["low", "medium", "high"] as const, {
      description: "finding: severity (default: medium)",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "finding: title (required when filing a new finding)",
      maxLength: MAX_FINDING_TITLE_CHARS,
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "finding: summary (required when filing a new finding)",
      maxLength: MAX_FINDING_SUMMARY_CHARS,
    }),
  ),
  location: Type.Optional(
    Type.String({
      description: "finding: file/line location",
      maxLength: 256,
    }),
  ),
  suggestedFix: Type.Optional(
    Type.String({ description: "finding: suggested fix", maxLength: 2_000 }),
  ),
  findingId: Type.Optional(
    Type.String({ description: "finding: id to update (with status)" }),
  ),
  status: Type.Optional(
    StringEnum(["open", "accepted", "rejected", "done"] as const, {
      description:
        "finding update: new status; requires findingId; ignored for send/inbox",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "inbox: max messages to return",
      minimum: 1,
      maximum: 100,
    }),
  ),
  as: Type.Optional(
    Type.String({
      description:
        "Identity to act as (default: your session identity). Pass a subagent id when recording work on its behalf.",
      maxLength: 64,
    }),
  ),
});

const StatusParamsSchema = Type.Object({
  owner: Type.Optional(
    Type.String({
      description: "Filter tasks by owner identity (combined AND with status)",
      maxLength: 64,
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
      description: "Filter tasks by a single status",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Max task lines (default 200)",
      minimum: 1,
      maximum: 200,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<TowerDoStatus, string> = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
  blocked: "✗",
};

/** Theme color for a task status glyph. Shared by the widget and renderCall. */
function statusColor(
  status: TowerDoStatus,
): "warning" | "error" | "success" | "muted" {
  if (status === "in_progress") return "warning";
  if (status === "blocked") return "error";
  if (status === "completed") return "success";
  return "muted";
}

function taskLine(task: TowerDoTask, showOwner: boolean): string {
  const owner = showOwner && task.owner !== undefined ? ` @${task.owner}` : "";
  const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
  const scope = task.scope?.length ? ` [scope: ${task.scope.join(", ")}]` : "";
  return `${task.key}: ${task.subject}${owner}${deps}${scope}`;
}

/** Receipt rendering: ` [files: a.ts, b.ts]` — only ever present on completed tasks. */
function changedFilesSuffix(task: TowerDoTask): string {
  const files = task.changedFiles;
  if (files === undefined || files.length === 0) return "";
  const joined =
    files.length <= 4
      ? files.join(", ")
      : `${files.slice(0, 4).join(", ")}, …+${files.length - 4}`;
  return ` [files: ${joined}]`;
}

function formatChange(
  view: TowerBoardView,
  caller: string,
  change: { added: string[]; updated: string[]; removed: string[] },
): string {
  if (view.tasks.length === 0) {
    return `TowerDo board cleared (revision ${view.revision}).`;
  }
  if (
    change.added.length === 0 &&
    change.updated.length === 0 &&
    change.removed.length === 0
  ) {
    return `TowerDo board unchanged (revision ${view.revision}, ${view.tasks.length} task(s)) by ${caller} — no field on any task changed.`;
  }
  const lines: string[] = [];
  const byKey = new Map(view.tasks.map((task) => [task.key, task]));
  if (change.removed.length > 0) {
    lines.push(
      `removed (${change.removed.length}): ${change.removed.join(", ")}`,
    );
  }
  if (change.updated.length > 0) {
    lines.push(
      `updated (${change.updated.length}): ${change.updated.join(", ")}`,
    );
  }
  for (const key of change.added) {
    const task = byKey.get(key);
    if (task) {
      lines.push(
        `[added] ${STATUS_GLYPH[task.status]} ${taskLine(task, true)}`,
      );
    }
  }
  return `TowerDo board revision ${view.revision} (${view.tasks.length} task(s)) by ${caller}:\n${lines.join("\n")}`;
}

function ensureKnown(view: TowerBoardView, recipient: string): void {
  // "all" broadcasts; the orchestrator identity is always addressable.
  if (recipient === "all" || recipient === TOWER_IDENTITY) return;
  const known = new Set(
    view.tasks
      .filter((task) => task.owner !== undefined)
      .map((task) => task.owner),
  );
  if (!known.has(recipient)) {
    const knownNames = [...known].join(", ");
    throw new TowerDoValidationError(
      `unknown recipient "${recipient}" — address "all", ${TOWER_IDENTITY}, or a task owner on the board (known owners: ${knownNames || "(none)"})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function towerDoExtension(pi: ExtensionAPI): void {
  let currentView: TowerBoardView = {
    schemaVersion: 1 as const,
    revision: 0,
    tasks: [],
    messages: [],
    findings: [],
  };
  let contextCheckpointNeeded = false;
  let llmCallsSinceReminder = 0;
  let widgetRegistered = false;
  let uiContext: ExtensionContext | undefined;
  let activeCwd: string | undefined;

  // -------------------------------------------------------------------------
  // Widget (above-editor status line)
  // -------------------------------------------------------------------------

  const clearWidget = (): void => {
    if (widgetRegistered && uiContext?.hasUI) {
      try {
        uiContext.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // best-effort: widget teardown must never throw during shutdown
      }
    }
    widgetRegistered = false;
  };

  const updateWidget = (ctx?: ExtensionContext): void => {
    if (ctx) uiContext = ctx;
    if (!uiContext?.hasUI || uiContext.mode !== "tui") return;
    if (currentView.tasks.length === 0 && currentView.messages.length === 0) {
      clearWidget();
      return;
    }
    if (!widgetRegistered) {
      uiContext.ui.setWidget(
        WIDGET_KEY,
        (_tui: TUI, theme: Theme) => {
          return {
            render: (width: number) => {
              const tasks = getAllTasks(currentView);
              const unfinished = tasks.filter(
                (task) => task.status !== "completed",
              );
              const blocked = tasks.filter((task) =>
                taskIsBlocked(task, currentView),
              );
              const identity = sessionIdentity(activeCwd, pi);
              const inboxForMe = unreadMessagesToMe(
                currentView,
                identity,
              ).length;
              const header =
                theme.fg(
                  "accent",
                  theme.bold(
                    `TowerDo ${tasks.length - unfinished.length}/${tasks.length}`,
                  ),
                ) +
                theme.fg("dim", ` rev ${currentView.revision}`) +
                (blocked.length > 0
                  ? theme.fg("error", ` ${blocked.length} blocked`)
                  : "") +
                (inboxForMe > 0
                  ? theme.fg("warning", ` ${inboxForMe} msg`)
                  : "");
              const lines = [header];
              // WIDGET_TASK_LIMIT caps how many unfinished tasks the
              // above-editor line shows; the rest fold into an overflow note.
              const cap =
                activeCwd === undefined ? unfinished.length : WIDGET_TASK_LIMIT;
              const shown = unfinished.slice(0, cap);
              for (const task of shown) {
                const glyph = STATUS_GLYPH[task.status];
                const color = statusColor(task.status);
                const owner =
                  task.owner === undefined
                    ? ""
                    : theme.fg("dim", ` @${task.owner}`);
                lines.push(
                  `${theme.fg(color, glyph)} ${theme.fg("text", task.subject)}${owner}`,
                );
              }
              if (unfinished.length > shown.length) {
                lines.push(
                  theme.fg(
                    "dim",
                    `… +${unfinished.length - shown.length} more`,
                  ),
                );
              }
              return lines.map((line) => truncateToWidth(line, width, "…"));
            },
            invalidate: () => {},
            dispose: () => {},
          };
        },
        { placement: "aboveEditor" },
      );
      widgetRegistered = true;
    }
  };

  // -------------------------------------------------------------------------
  // Common execute plumbing
  // -------------------------------------------------------------------------

  /**
   * Fold the board and retire fully-read history beyond the configured
   * retention budget. EVERY read view (status / inbox / reminder / widget /
   * write re-fold) goes through this so retired messages never resurface and
   * unread traffic always survives.
   */
  const foldRetained = async (cwd: string): Promise<TowerBoardView> => {
    const entry = boards.entryFor(cwd);
    const folded = await entry.board.fold();
    return cloneBoard({
      ...folded,
      messages: retainMessages(folded.messages, folded, MESSAGE_RETENTION),
    });
  };

  const prepare = async (
    ctx: ExtensionContext,
    as: string | undefined,
  ): Promise<{ board: TowerBoard; caller: string; view: TowerBoardView }> => {
    const entry = boards.entryFor(ctx.cwd);
    const view = await foldRetained(ctx.cwd);
    lastContext = ctx;
    activeCwd = ctx.cwd;
    currentView = view;
    uiContext = ctx;
    const caller = resolveCaller(as, ctx.cwd, pi);
    return { board: entry.board, caller, view };
  };

  // -------------------------------------------------------------------------
  // tower_do — plan / claim / update / complete / block shared tasks
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TOOL_NAME,
    label: "TowerDo",
    description: `Maintain the shared multi-agent task board with one atomic update.
- Full replacement: include every key to keep; omitting a key removes it.
- Omitted optional fields on existing keys are preserved; new keys require subject and status.
- Owner guard: a task with an owner can only be changed (any field) or removed by its owner or the "tower" identity.
- Always pass baseRevision from tower_do_status; omitting it disables the stale-write check.
- Up to ${MAX_TOWER_DO_TASKS} tasks. Optional per-task fields: dependsOn (must exist on the board or in this call), scope (file globs the task may touch), blockedBy (non-empty renders the task as blocked).`,
    promptSnippet:
      "Maintain the shared multi-agent task board with one atomic update",
    promptGuidelines: [
      "Use tower_do for the task plan instead of direct file edits when multiple agents or sessions share the work; it is the shared board, not a private todo list.",
      "When a task needs a plan of 3+ steps, define it yourself and call tower_do with subject + status before beginning substantive work.",
      "Include baseRevision (from tower_do_status) in every tower_do call; a stale revision is rejected so you never silently overwrite a peer's update.",
      "Mark a task completed only after implementation and verification succeed. Use status blocked with a blockedBy note instead of leaving it hanging.",
      "Claim shared tasks by setting owner and in_progress together. Only the owner or the orchestrator identity tower may change an owned task's fields or remove it — to remove or reassign another agent's task, message the owner via tower_do_talk instead of editing it directly.",
      "Reconcile actual progress with the shared board before your final response, and do not issue a no-op tower_do call only to acknowledge a reminder.",
    ],
    parameters: TowerDoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("TowerDo update cancelled");
      }
      const { board, caller } = await prepare(ctx, params.as);
      return withFileMutationQueue(board.file, async () => {
        // Re-fold INSIDE the mutation queue: the revision guard and diff must
        // see the freshest events, or a same-process call that appended
        // between prepare() and the queue would be silently clobbered.
        const freshView = await foldRetained(ctx.cwd);
        const details = writeBoardSnapshot(
          freshView,
          { tasks: params.tasks, baseRevision: params.baseRevision },
          caller,
        );
        await board.append(details.taskEvents);
        currentView = cloneBoard(details.view);
        llmCallsSinceReminder = 0;
        updateWidget(ctx);
        // Presence footnote: surface owners who own unfinished tasks but have
        // no recent activity, so a coordinator sees who may be stalled.
        const now = Date.now();
        const tail = (await board.rawTail(200)).reverse();
        const parsed = tail
          .map((line) => parseActivityLine(line))
          .filter((entry): entry is ActivityEntry => entry !== undefined);
        const presence = derivePresence(parsed, details.view.tasks, now);
        const idleOwners = presence.filter(
          (line) =>
            line.idle &&
            line.ownerOf.some(
              (key) =>
                details.view.tasks.find((task) => task.key === key)?.status !==
                "completed",
            ),
        );
        const base = formatChange(details.view, caller, details.change);
        const footnote =
          idleOwners.length === 0
            ? ""
            : `\n\nidle: ${idleOwners
                .map(
                  (line) =>
                    `${line.identity} (owns ${line.ownerOf.join(", ")})`,
                )
                .join(
                  ", ",
                )} — message them or re-claim via tower (tower_do_talk)`;
        return {
          content: [{ type: "text", text: base + footnote }],
          details: {
            caller,
            revision: details.view.revision,
            change: details.change,
          },
        };
      });
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
      const owner =
        typeof args.as === "string" && args.as ? ` as ${args.as}` : "";
      const lines = [
        theme.fg(
          "toolTitle",
          theme.bold(`tower_do ${count} task${count === 1 ? "" : "s"}`),
        ) +
          (owner ? theme.fg("muted", owner) : "") +
          (typeof args.baseRevision === "number"
            ? theme.fg("dim", ` base ${args.baseRevision}`)
            : ""),
      ];
      for (const task of Array.isArray(args.tasks) ? args.tasks : []) {
        if (typeof task.key !== "string" || typeof task.subject !== "string")
          continue;
        const status = isTowerDoStatus(task.status) ? task.status : "pending";
        const glyph = STATUS_GLYPH[status];
        const color = statusColor(status);
        const owner2 =
          typeof task.owner === "string" && task.owner
            ? theme.fg("dim", ` @${task.owner}`)
            : "";
        const deps =
          Array.isArray(task.dependsOn) && task.dependsOn.length
            ? theme.fg("dim", ` ← ${task.dependsOn.join(",")}`)
            : "";
        lines.push(
          `${theme.fg(color, glyph)} ${theme.fg("text", task.subject)}${owner2}${deps}`,
        );
      }
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Validating shared board..."));
        return text;
      }
      const details = (result.details ?? {}) as Record<string, unknown>;
      if (typeof details.revision !== "number") {
        const output = result.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text",
          )
          .map((item) => item.text)
          .join("\n");
        text.setText(
          output
            ? theme.fg(context.isError ? "error" : "toolOutput", output)
            : "",
        );
        return text;
      }
      // The completed call above already contains the final task list.
      text.setText(theme.fg("dim", `rev ${String(details.revision)}`));
      return text;
    },
  });

  // -------------------------------------------------------------------------
  // tower_do_talk — addressed messages + structured findings
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TALK_TOOL_NAME,
    label: "TowerDo Talk",
    description:
      'Cross-agent communication on the shared tower-do board. action=send delivers an inbox message to "all", the orchestrator identity "tower", or a task owner (self-send rejected). action=inbox lists messages addressed to you or "all", newest first. action=finding files a structured out-of-scope finding (bug|improve|vuln|idea) with severity/location/suggestedFix, or updates a finding\'s status via findingId + status. Use findings instead of silently editing other-owned tasks.',
    promptSnippet:
      "Send addressed messages or file findings on the shared multi-agent board",
    promptGuidelines: [
      'Use tower_do_talk to communicate with task owners on the shared board instead of editing owned tasks directly; the recipient must be "all", "tower", or a known task owner.',
      "Use action=finding (not direct edits) when you discover an out-of-scope problem — file it with kind/severity/summary/suggestedFix so the owning agent and reviewers can route it.",
      "Keep message bodies brief and reference files by path; the board persists everything, so pointer-style notes keep context lean.",
    ],
    parameters: TalkParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("TowerDo talk cancelled");
      }
      const { board, caller, view } = await prepare(ctx, params.as);
      const now = Date.now();

      if (params.action === "send") {
        const to = params.to?.trim();
        if (!to)
          throw new TowerDoValidationError(
            'send requires a recipient: "all" or a task owner',
          );
        if (/[\r\n\u2028\u2029]/.test(to)) {
          throw new TowerDoValidationError(
            "send recipient must be a single line",
          );
        }
        if (to === caller)
          throw new TowerDoValidationError(
            "cannot send an inbox message to yourself",
          );
        const subject = params.subject?.trim();
        if (!subject)
          throw new TowerDoValidationError("send requires a subject");
        if (/[\r\n\u2028\u2029]/.test(subject)) {
          throw new TowerDoValidationError(
            "send subject must be a single line",
          );
        }
        const body = params.body?.trim();
        if (!body) throw new TowerDoValidationError("send requires a body");
        if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
          throw new TowerDoValidationError(
            `message body too large (${(Buffer.byteLength(body, "utf8") / 1024).toFixed(0)} KiB > ${(MAX_MESSAGE_BYTES / 1024).toFixed(0)} KiB) — split it into multiple messages`,
          );
        }
        if (
          params.taskKey !== undefined &&
          !view.tasks.some((task) => task.key === params.taskKey)
        ) {
          throw new TowerDoValidationError(
            `taskKey references unknown task ${params.taskKey}`,
          );
        }
        const messageId = `m-${randomUUID().slice(0, 12)}`;
        const messageBase = {
          id: messageId,
          to,
          from: caller,
          subject,
          body,
          at: now,
          ...(params.taskKey === undefined ? {} : { taskKey: params.taskKey }),
        };
        await withFileMutationQueue(board.file, async () => {
          const fresh = await foldRetained(ctx.cwd);
          ensureKnown(fresh, to);
          // Snapshot the broadcast audience (owners at send time, sender
          // excluded) so full-read / retirement uses the people who were
          // actually addressed — an owner joining later never read it and
          // must not keep the broadcast alive forever.
          const audience =
            to === "all"
              ? fresh.tasks
                  .map((task) => task.owner)
                  .filter(
                    (owner): owner is string =>
                      owner !== undefined && owner !== caller,
                  )
              : undefined;
          const message: TowerDoMessage = {
            ...messageBase,
            ...(audience === undefined || audience.length === 0
              ? {}
              : { audience }),
          };
          await board.append([
            { kind: "message", message, by: caller, at: now },
          ]);
          currentView = cloneBoard({
            ...fresh,
            messages: [...fresh.messages, message],
          });
          llmCallsSinceReminder = 0;
          updateWidget(ctx);
        });
        return {
          content: [
            {
              type: "text",
              text: `TowerDo message sent ${to === "all" ? "to everyone" : `to ${to}`}: ${subject}`,
            },
          ],
          details: { caller, messageId },
        };
      }

      if (params.action === "inbox") {
        const limit = params.limit ?? 20;
        const now2 = Date.now();
        // Reading your inbox acks the messages shown (LWW readBy update): the
        // sender learns you saw them, and fully-read history can be retired.
        return withFileMutationQueue(board.file, async () => {
          const fresh = await foldRetained(ctx.cwd);
          const mine = messagesToMe(fresh, caller)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit);
          if (mine.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `TowerDo inbox empty for ${caller}.`,
                },
              ],
              details: { caller, inbox: [] },
            };
          }
          const unacked = mine.filter(
            (message) => !(message.readBy ?? []).includes(caller),
          );
          if (unacked.length > 0) {
            await board.append(
              unacked.map((message) => ({
                kind: "message" as const,
                message: {
                  ...message,
                  readBy: [...(message.readBy ?? []), caller],
                },
                by: caller,
                at: now2,
              })),
            );
          }
          const updatedMessages = mine.map((message) =>
            (message.readBy ?? []).includes(caller)
              ? message
              : { ...message, readBy: [...(message.readBy ?? []), caller] },
          );
          currentView = cloneBoard({
            ...fresh,
            messages: fresh.messages.map((message) =>
              unacked.some((unackedMessage) => unackedMessage.id === message.id)
                ? {
                    ...message,
                    readBy: [...(message.readBy ?? []), caller],
                  }
                : message,
            ),
          });
          llmCallsSinceReminder = 0;
          updateWidget(ctx);
          const lines = updatedMessages.map(
            (message) =>
              `- [${message.id}] [${(message.readBy ?? []).includes(caller) ? "read" : "UNREAD"}] ${message.from} → ${message.to}${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject}\n  ${message.body.split("\n")[0]}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `TowerDo inbox for ${caller} (${mine.length}${unacked.length > 0 ? `, ${unacked.length} newly acked` : ""}):\n${lines.join("\n")}`,
              },
            ],
            details: { caller, inbox: updatedMessages },
          };
        });
      }

      // action === finding
      if (params.findingId !== undefined) {
        const updated = await withFileMutationQueue(board.file, async () => {
          // Re-fold inside the queue: the finding may have changed since the
          // pre-queue fold in prepare().
          const fresh = await foldRetained(ctx.cwd);
          const existing = fresh.findings.find(
            (finding) => finding.id === params.findingId,
          );
          if (existing === undefined) {
            throw new TowerDoValidationError(
              `unknown finding ${params.findingId}`,
            );
          }
          if (!FINDING_STATUSES.has(params.status ?? "")) {
            throw new TowerDoValidationError(
              "finding update requires status in open|accepted|rejected|done",
            );
          }
          const next: TowerDoFinding = {
            ...existing,
            status: params.status as FindingStatus,
            at: now,
          };
          await board.append([
            { kind: "finding", finding: next, by: caller, at: now },
          ]);
          currentView = cloneBoard({
            ...fresh,
            findings: fresh.findings.map((f) => (f.id === next.id ? next : f)),
          });
          updateWidget(ctx);
          return next;
        });
        return {
          content: [
            {
              type: "text",
              text: `TowerDo finding ${updated.id} updated → ${updated.status}`,
            },
          ],
          details: { caller, findingId: updated.id, status: updated.status },
        };
      }
      const kind = params.kind as FindingKind | undefined;
      if (!kind || !FINDING_KINDS.has(kind)) {
        throw new TowerDoValidationError(
          "finding requires kind in bug|improve|vuln|idea",
        );
      }
      const severity =
        (params.severity as FindingSeverity | undefined) ?? "medium";
      if (!FINDING_SEVERITIES.has(severity)) {
        throw new TowerDoValidationError(
          "finding severity must be low|medium|high",
        );
      }
      const title = params.title?.trim();
      if (!title) throw new TowerDoValidationError("finding requires a title");
      if (/[\r\n\u2028\u2029]/.test(title)) {
        throw new TowerDoValidationError("finding title must be a single line");
      }
      const summary = params.summary?.trim();
      if (!summary)
        throw new TowerDoValidationError("finding requires a summary");
      const location = params.location?.trim();
      if (location && /[\r\n\u2028\u2029]/.test(location)) {
        throw new TowerDoValidationError(
          "finding location must be a single line",
        );
      }
      if (location && location.length > 256) {
        throw new TowerDoValidationError(
          "finding location must be at most 256 characters",
        );
      }
      const suggestedFix = params.suggestedFix?.trim();
      if (suggestedFix && /[\r\n\u2028\u2029]/.test(suggestedFix)) {
        throw new TowerDoValidationError(
          "finding suggestedFix must be a single line",
        );
      }
      if (suggestedFix && suggestedFix.length > 2_000) {
        throw new TowerDoValidationError(
          "finding suggestedFix must be at most 2000 characters",
        );
      }
      const finding: TowerDoFinding = {
        id: `f-${randomUUID().slice(0, 12)}`,
        kind,
        title,
        severity,
        status: "open",
        summary,
        ...(location ? { location } : {}),
        ...(suggestedFix ? { suggestedFix } : {}),
        from: caller,
        at: now,
      };
      await withFileMutationQueue(board.file, async () => {
        const fresh = await foldRetained(ctx.cwd);
        await board.append([{ kind: "finding", finding, by: caller, at: now }]);
        currentView = cloneBoard({
          ...fresh,
          findings: [...fresh.findings, finding],
        });
        updateWidget(ctx);
      });
      return {
        content: [
          {
            type: "text",
            text: `TowerDo finding filed: [${severity}/${kind}] ${title} (${finding.id})`,
          },
        ],
        details: { caller, findingId: finding.id },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action =
        typeof args.action === "string" && args.action ? args.action : "";
      let detail = "";
      if (action === "send") {
        detail = typeof args.to === "string" && args.to ? ` → ${args.to}` : "";
      } else if (action === "finding") {
        detail =
          typeof args.title === "string" && args.title ? `: ${args.title}` : "";
      }
      text.setText(
        theme.fg("toolTitle", theme.bold(`tower_do_talk ${action}${detail}`)),
      );
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Delivering..."));
        return text;
      }
      const details = (result.details ?? {}) as Record<string, unknown>;
      if (Array.isArray(details.inbox)) {
        text.setText(
          theme.fg("dim", `${String(details.inbox.length)} message(s)`),
        );
        return text;
      }
      if (typeof details.messageId === "string") {
        text.setText(theme.fg("success", `sent ${details.messageId}`));
        return text;
      }
      if (typeof details.findingId === "string") {
        text.setText(
          theme.fg(
            "success",
            `${details.findingId} ${typeof details.status === "string" ? details.status : "filed"}`,
          ),
        );
        return text;
      }
      const output = result.content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      text.setText(
        output
          ? theme.fg(context.isError ? "error" : "toolOutput", output)
          : "",
      );
      return text;
    },
  });

  // -------------------------------------------------------------------------
  // tower_do_status — shared dashboard (everyone's tasks)
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_STATUS_TOOL_NAME,
    label: "TowerDo Status",
    description:
      "Read the shared tower-do board: everyone's tasks (owner, status, deps, scope, blocks), messages addressed to you, open findings, and the recent activity tail. Also prints the board file path so subagents can read state directly (file-as-state). Output is truncated to 50KB.",
    promptSnippet:
      "Show the shared multi-agent task board: tasks, messages, findings, activity",
    promptGuidelines: [
      "Use tower_do_status before starting work to see who owns what on the shared board, and before finishing work to reconcile your own tasks.",
      "When a tower_do write is rejected as stale, call tower_do_status first to re-read the current revision, then merge your changes and retry with the new baseRevision.",
      "Share the board file path from tower_do_status with subagents so they can read shared state directly; have them report back instead of editing owned tasks.",
    ],
    parameters: StatusParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("TowerDo status cancelled");
      }
      const { board, caller, view } = await prepare(ctx, undefined);
      const tasks = getAllTasks(view);
      const byStatus = (status: TowerDoStatus) =>
        tasks.filter((task) => task.status === status);
      // Fetch a wider tail than the rendered window: presence (who is around,
      // who went idle) needs enough history to judge inactivity, while the
      // rendered activity feed only shows the configured activity tail.
      // The tail is also the source for the header's "last updated" line, so
      // it is parsed once and shared by all three consumers.
      const tailCount = STATUS_ACTIVITY_TAIL;
      const presenceCount = Math.max(tailCount, 200);
      const now = Date.now();
      const rawTail = (await board.rawTail(presenceCount)).reverse();
      const parsedEntries = rawTail
        .map((line) => parseActivityLine(line))
        .filter((entry): entry is ActivityEntry => entry !== undefined);
      const recentEntries = parsedEntries.slice(0, tailCount);
      const presence = derivePresence(parsedEntries, tasks, now);
      const lastWrite = latestActivity(parsedEntries);

      const myMessages = messagesToMe(view, caller)
        .sort((a, b) => b.at - a.at)
        .slice(0, 20);
      const myUnread = unreadMessagesToMe(view, caller).length;
      const openFindings = view.findings
        .filter(
          (finding) =>
            finding.status === "open" || finding.status === "accepted",
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 20);
      // P1: derived scope × changedFiles advisory. Pure read, rendered as a
      // dedicated section (not per-row suffix) so long scope lists don't
      // explode every task line.
      const scopeConflicts = findScopeConflicts(view);

      if (params.status !== undefined && !isTowerDoStatus(params.status)) {
        throw new TowerDoValidationError(
          `invalid status filter "${params.status}" — valid statuses: ${[...TOWER_DO_STATUSES].join(", ")}`,
        );
      }
      const filtered =
        params.owner !== undefined || params.status !== undefined
          ? tasks.filter(
              (task) =>
                (params.owner === undefined || task.owner === params.owner) &&
                (params.status === undefined || task.status === params.status),
            )
          : tasks;
      const limit = params.limit ?? 200;
      const shown = filtered.slice(0, limit);

      const lines: string[] = [];
      lines.push(
        `TowerDo shared board — identity ${caller}, revision ${view.revision}`,
      );
      lines.push(`Board file: ${board.file}`);
      // D4: board liveness at a glance. revision is monotonic but silent —
      // a coordinator needs to know how stale the board is and who last
      // moved it (pure read derivation from the activity tail, zero writes).
      const updated =
        lastWrite === undefined
          ? "no board writes yet"
          : `last updated ${relativeTime(now, lastWrite.at)} by ${lastWrite.by}`;
      lines.push(`Activity: ${updated}`);
      lines.push(
        `Tasks: ${tasks.length} total (${byStatus("in_progress").length} in_progress, ${byStatus("blocked").length} blocked, ${byStatus("pending").length} pending, ${byStatus("completed").length} completed)`,
      );
      lines.push("");

      // Presence head: surface owners of unfinished work (active / idle /
      // not-started) plus anyone with very recent activity, so a reader sees
      // who is driving the board. Historical-only identities (no owned work,
      // no recent action) collapse into an overflow note instead of a long
      // tail of names.
      const unfinishedKeys = new Set(
        tasks
          .filter((task) => task.status !== "completed")
          .map((task) => task.key),
      );
      const recentWindow = now - 60 * 60_000; // 1h of activity counts as present
      const relevantPresence = presence.filter(
        (person) =>
          person.ownerOf.some((key) => unfinishedKeys.has(key)) ||
          (person.lastSeenAt !== undefined &&
            person.lastSeenAt >= recentWindow),
      );
      const historicalCount = presence.length - relevantPresence.length;
      lines.push(`## Who is around (${relevantPresence.length})`);
      for (const person of relevantPresence) {
        lines.push(`- ${formatPresenceLine(person, now)}`);
      }
      if (historicalCount > 0) {
        lines.push(`- … ${historicalCount} more with only historical activity`);
      }
      lines.push("");

      const renderGroup = (status: TowerDoStatus, label: string): void => {
        const group = shown.filter((task) => task.status === status);
        if (group.length === 0) return;
        lines.push(`## ${label}`);
        for (const task of group) {
          const owner = task.owner === undefined ? "" : ` @${task.owner}`;
          const deps = task.dependsOn.length
            ? ` ← ${task.dependsOn.join(",")}`
            : "";
          const scope = task.scope?.length
            ? ` [scope: ${task.scope.join(", ")}]`
            : "";
          const blocked = taskIsBlocked(task, view) ? " [blocked]" : "";
          const unresolved = findAllUnresolvedDeps(task, view);
          let reason = "";
          if (task.status === "blocked" || task.blockedBy.length > 0) {
            reason = ` — waiting${task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(", ")})` : ""}`;
          } else if (unresolved.length > 0) {
            reason = ` — waiting for deps: ${unresolved.join(", ")}`;
          }
          lines.push(
            `- ${STATUS_GLYPH[task.status]} ${task.key}: ${task.subject}${owner}${deps}${scope}${changedFilesSuffix(task)}${blocked}${reason}`,
          );
        }
        lines.push("");
      };
      renderGroup("blocked", "Blocked");
      renderGroup("in_progress", "In progress");
      renderGroup("pending", "Pending");
      renderGroup("completed", "Completed");

      if (shown.length === 0) lines.push("(no tasks match the filter)");

      if (scopeConflicts.length > 0) {
        lines.push(`## Scope conflicts (${scopeConflicts.length}) — advisory`);
        for (const conflict of scopeConflicts) {
          const glyph = conflict.kind === "collision" ? "⚠" : "⛔";
          const label =
            conflict.kind === "collision"
              ? `collision: ${conflict.taskKey} × ${conflict.peerKey}`
              : `overlap: ${conflict.taskKey} plans to touch what ${conflict.peerKey} already changed`;
          lines.push(`- ${glyph} ${label} — ${conflict.detail}`);
        }
        lines.push(
          "  (advisory: scope is self-declared, changedFiles is self-reported — resolve by messaging the owner or re-scoping, not by gate)",
        );
        lines.push("");
      }

      lines.push(
        `## Messages for ${caller} (${myMessages.length}; ${myUnread} unread)`,
      );
      for (const message of myMessages) {
        const readMark = (message.readBy ?? []).includes(caller)
          ? "read"
          : "UNREAD";
        lines.push(
          `- [${message.id}] [${readMark}] ${message.from} → you${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject} — ${message.body.split("\n")[0]}`,
        );
      }
      if (myMessages.length === 0) lines.push("(none)");

      lines.push("");
      lines.push(`## Open findings (${openFindings.length})`);
      for (const finding of openFindings) {
        const location =
          finding.location === undefined ? "" : ` @${finding.location}`;
        const fix =
          finding.suggestedFix === undefined
            ? ""
            : ` fix: ${finding.suggestedFix}`;
        lines.push(
          `- [${finding.id}] [${finding.severity}/${finding.kind}] ${finding.title} (${finding.from})${location} — ${finding.summary.split("\n")[0]}${fix}`,
        );
      }
      if (openFindings.length === 0) lines.push("(none)");

      lines.push("");
      lines.push("## Recent activity (newest first)");
      for (const line of formatActivityFeed(recentEntries, now)) {
        lines.push(line);
      }
      if (recentEntries.length === 0) lines.push("(no recent activity)");

      const truncated = truncateTail(`${lines.join("\n")}\n`, {
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const text = truncated.content;
      return {
        content: [{ type: "text", text }],
        details: {
          caller,
          revision: view.revision,
          board: board.file,
          identity: caller,
        },
      };
    },

    renderCall(_args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        theme.fg("toolTitle", theme.bold("tower_do_status")) +
          theme.fg("dim", ` rev ${currentView.revision}`),
      );
      return text;
    },

    renderResult(result, { isPartial, expanded }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Folding shared board..."));
        return text;
      }
      const output = result.content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      if (!output) {
        if (result.details) text.setText("");
        return text;
      }
      const lines = output.split("\n");
      const keep = expanded ? lines.length : Math.min(lines.length, 14);
      let rendered = theme.fg(
        context.isError ? "error" : "toolOutput",
        lines.slice(0, keep).join("\n"),
      );
      if (lines.length > keep) {
        rendered += theme.fg(
          "dim",
          `\n… ${lines.length - keep} more (${keyHint("app.tools.expand", "expand")})`,
        );
      }
      text.setText(rendered);
      return text;
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle: restore, compact checkpoints, reminders, shutdown
  // -------------------------------------------------------------------------

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    clearWidget();
    lastContext = ctx;
    activeCwd = ctx.cwd;
    const entry = boards.entryFor(ctx.cwd);
    // Disk is authoritative. Fall back to the last session checkpoint ONLY
    // when the board file is missing (worktree cleaned / first run) — never
    // when the board exists but holds zero tasks, because that is a genuine
    // `tower_do tasks: []` clear and replaying an old checkpoint would
    // resurrect finished work in the UI.
    if (existsSync(entry.board.file)) {
      currentView = await foldRetained(ctx.cwd);
    } else {
      for (const rawEntry of ctx.sessionManager.getBranch()) {
        if (
          rawEntry.type === "custom" &&
          rawEntry.customType === TOWER_DO_BOARD_TYPE &&
          rawEntry.data !== undefined
        ) {
          const checkpoint = readBoardSnapshot(rawEntry.data);
          if (checkpoint) {
            // Replay the checkpoint as a *display* only: the disk board is
            // still empty (revision 0). Pin revision to 0 so the widget and
            // reminders never advertise a stale baseRevision that the disk
            // gate would reject.
            currentView = cloneBoard({ ...checkpoint, revision: 0 });
            break;
          }
        }
      }
      if (currentView.tasks.length === 0) {
        currentView = createEmptyBoard();
      }
    }
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    uiContext = ctx;
    updateWidget(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx);
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) =>
        !(
          message.role === "custom" &&
          message.customType === TOWER_DO_REMINDER_TYPE
        ),
    );
    if (activeCwd === undefined) {
      return messages.length === event.messages.length
        ? undefined
        : { messages };
    }
    const identity = sessionIdentity(activeCwd, pi);
    const tasks = getAllTasks(currentView);
    const hasUnfinished = tasks.some((task) => task.status !== "completed");
    const hasInbox = unreadMessagesToMe(currentView, identity).length > 0;
    if (!hasUnfinished && !hasInbox) {
      llmCallsSinceReminder = 0;
      return messages.length === event.messages.length
        ? undefined
        : { messages };
    }
    llmCallsSinceReminder += 1;
    if (llmCallsSinceReminder < REMINDER_INTERVAL) {
      return messages.length === event.messages.length
        ? undefined
        : { messages };
    }
    llmCallsSinceReminder = 0;
    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: TOWER_DO_REMINDER_TYPE,
          content: formatBoardReminder(currentView, identity),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    pi.appendEntry(TOWER_DO_BOARD_TYPE, cloneBoard(currentView));
    if (event.willRetry || ctx.hasPendingMessages()) {
      contextCheckpointNeeded = false;
      llmCallsSinceReminder = 0;
      pi.sendMessage(
        {
          customType: TOWER_DO_BOARD_TYPE,
          content: formatBoardReminder(
            currentView,
            sessionIdentity(ctx.cwd, pi),
          ),
          display: false,
          details: cloneBoard(currentView),
        },
        { deliverAs: "steer" },
      );
    } else {
      contextCheckpointNeeded = true;
    }
  });

  pi.on("before_agent_start", () => {
    if (!contextCheckpointNeeded) return;
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    return {
      message: {
        customType: TOWER_DO_BOARD_TYPE,
        content: formatBoardReminder(
          currentView,
          sessionIdentity(activeCwd, pi),
        ),
        display: false,
        details: cloneBoard(currentView),
      },
    };
  });

  pi.on("session_shutdown", () => {
    clearWidget();
    uiContext = undefined;
    lastContext = undefined;
    activeCwd = undefined;
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    // Re-resolve project roots next session: the filesystem may have gained
    // or lost a `.git` boundary since this session started (e.g. `git init`
    // mid-session). Within a session the cache is deliberately stable — moving
    // the board file mid-session would orphan earlier events (split-brain).
    projectRootCache.clear();
  });
}
