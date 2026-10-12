/**
 * tower-do — a shared multi-agent task board for pi.
 *
 * Fuses the coordination design of Kimi Tower's multi-worker orchestration
 * into a todo-style extension:
 *
 *  - file-as-state: the board lives in `~/.pi/tower-do/<project>/board.jsonl`
 *    (append-only JSONL; folding events yields the current view). Every agent
 *    session — or a subagent pointed at the board path — sees the same tasks.
 *  - ownership: tasks may carry an `owner`; only the owner or the reserved
 *    orchestrator identity "tower" may change an owned task's fields
 *    (workers touch only their own missions).
 *  - negotiated handoff, not blind clobber: tower_do_talk delivers addressed
 *    messages (recipient must be "all", the orchestrator "tower", a current
 *    task owner, or an identity with recent board activity; self-send rejected);
 *    tower_do_status is the shared dashboard.
 *  - merge gate, simplified: the monotonic board `revision` is read from the
 *    file (tool-read, never self-reported) and backs the baseRevision guard —
 *    a stale write is rejected instead of silently overwriting a peer's work.
 *
 * Usage:
 *   tower_do           — plan / claim / update / complete / block shared tasks
 *   tower_do_talk      — send an inbox message to a task owner / read your
 *                        inbox
 *   tower_do_status    — shared dashboard: everyone's tasks, blocks, messages,
 *                        and the activity tail
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
  DEFAULT_MAX_LINES,
  keyHint,
  truncateTail,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  findAllUnresolvedDeps,
  formatActivityFeed,
  formatBoardProgress,
  formatBoardReminder,
  formatTakeoverWindow,
  getAllTasks,
  isCallerLine,
  isTowerDoStatus,
  knownIdentities,
  latestActivity,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_TASK_BLOCKERS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TASK_KEY_CHARS,
  MAX_TASK_SUBJECT_CHARS,
  MAX_TOWER_DO_OPEN_TASKS,
  messagesToMe,
  OPEN_TASK_BUDGET_HINT,
  normalizeIdentity,
  parseActivityLine,
  relativeTime,
  retainMessages,
  staleTaskClaims,
  taskIsBlocked,
  readByWith,
  TASK_KEY_PATTERN,
  textLength,
  transportLimit,
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
  type TowerBoardView,
  type TowerDoMessage,
  type TowerDoStatus,
  type TowerDoTask,
} from "./state.ts";

const WIDGET_KEY = "pi-tower-do-widget";

// Internal tuning constants — deliberately NOT user config (DECISIONS.md:
// no user evidence ever justified tuning them, and every knob is permanent
// schema+docs+test surface).
const REMINDER_INTERVAL = 3; // inject a board reminder every N LLM calls
const DASHBOARD_ROW_BUDGET = 200; // default task rows rendered by tower_do_status
const WIDGET_TASK_LIMIT = 3; // unfinished tasks shown in the above-editor line
const STATUS_ACTIVITY_TAIL = 8; // activity feed lines in tower_do_status
/** Rows the dashboard renders per messages section. The section headers
 * state the total when the page is smaller, so this is never a silent cap. */
const DASHBOARD_LIST_LIMIT = 20;
const MESSAGE_RETENTION = 50; // max fully-read messages kept in the view
/** Default `tower_do_talk inbox` page size: the schema description and the
 * handler must agree, so the number lives once. */
const DEFAULT_INBOX_LIMIT = 20;

// ---------------------------------------------------------------------------
// Config (global, HOME-scoped, fail-loud JSON)
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
function projectRoot(cwd: string): string {
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

/** Per-project state root under the global records home `~/.pi/tower-do/`:
 * session records (board.jsonl, live sidecars) never ride inside a repo. The
 * slug keeps the directory readable; the path hash guarantees uniqueness
 * (`/a/b` vs `/a_b` would slug identically). */
export function stateDirFor(cwd: string): string {
  const root = projectRoot(cwd);
  const slug =
    root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(homeDir(), ".pi", "tower-do", `${slug}-${hash}`);
}

export function boardFileFor(cwd: string): string {
  return join(stateDirFor(cwd), "board.jsonl");
}

/** $HOME resolved explicitly (POSIX semantics) instead of os.homedir(): Bun's
 * homedir() ignores the HOME override, which makes HOME-scoped tests
 * nondeterministic and silently reads the real user config. */
function homeDir(): string {
  return (
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir()
  );
}

/** Config lives beside pi's own config under `~/.pi/agent/`: a pinned
 * identity is a personal choice that applies across every board the user
 * touches, and keeping it out of the repo avoids leaking it through committed
 * files and per-project drift. */
function configFile(): string {
  return join(homeDir(), ".pi", "agent", "tower-do", "config.json");
}

function loadConfig(): TowerDoConfig {
  const path = configFile();
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

/** One-time migration from the retired per-project layout: move the legacy
 * state dir wholesale into the global records home so no task/history data
 * is silently abandoned and no session gets bricked by a leftover. A pinned
 * identity rides along to the global config path unless the user already has
 * one there — BEFORE any board logic, so a config-only leftover still
 * reaches the global path even when the state dir was already migrated (the
 * retired layout documented config.json as safe to commit, so it can
 * reappear from git). If the target already exists, leftover project dirs
 * are ignored: the global records home is authoritative. */
function migrateLegacyState(cwd: string): void {
  const legacy = join(projectRoot(cwd), CONFIG_DIR_NAME, "tower-do");
  if (resolve(legacy) === resolve(homeDir(), ".pi", "tower-do")) return;
  if (!existsSync(legacy)) return;
  const legacyConfig = join(legacy, "config.json");
  const globalConfig = configFile();
  if (existsSync(legacyConfig) && !existsSync(globalConfig)) {
    mkdirSync(dirname(globalConfig), { recursive: true });
    try {
      moveDir(legacyConfig, globalConfig);
    } catch (error) {
      throw new Error(
        `tower-do config ${legacyConfig} could not be migrated to ${globalConfig}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const target = stateDirFor(cwd);
  if (existsSync(target)) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    moveDir(legacy, target);
  } catch (error) {
    // Silent abandonment would drop a pinned identity / task history — the
    // exact silent-wrong class this extension exists to prevent. Fail loud
    // with both paths; the user can fix the filesystem issue and retry.
    throw new Error(
      `tower-do state ${legacy} could not be migrated to ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Move a file or directory across the migration boundary. rename(2) is
 * atomic but fails with EXDEV when the project and $HOME live on different
 * filesystems; fall back to copy + remove only for that case. If `to`
 * already exists (lost the race with another session), leave the source
 * unread — the global path is authoritative and leftover project dirs
 * must not brick or overwrite. */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (existsSync(to)) return;
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

class BoardCache {
  private readonly entries = new Map<string, BoardEntry>();

  entryFor(cwd: string): BoardEntry {
    const file = boardFileFor(cwd);
    let entry = this.entries.get(file);
    if (entry === undefined) {
      migrateLegacyState(cwd);
      entry = {
        board: new TowerBoard(file),
        config: loadConfig(),
      };
      this.entries.set(file, entry);
    }
    return entry;
  }
}

const boards = new BoardCache();

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Resolve the acting identity: config > session name > session id.
 *
 * `ctx` MUST be the calling session's own context. This used to read a
 * module-level `lastContext` that every `towerDoExtension(pi)` call in the
 * process overwrote, so a nested session (a subagent task session, which pi
 * runs in-process) silently re-labelled its PARENT: the parent's heartbeat
 * wrote the child's identity, the board reminder announced the child's
 * identity, `as`-less writes were attributed to the child, and the parent's
 * own tasks lost their liveness protection (a live owner looked idle and
 * became displaceable). Session-scoped state must never live in a module
 * global.
 */
function sessionIdentity(
  cwd: string | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
): string {
  const entry = cwd === undefined ? undefined : boards.entryFor(cwd);
  const configured = entry?.config.identity?.trim();
  if (configured) return configured;
  const sessionName =
    typeof pi.getSessionName === "function"
      ? pi.getSessionName()?.trim()
      : undefined;
  if (sessionName) {
    try {
      return normalizeIdentity(sessionName, "session name");
    } catch {
      // Fall through to the session id.
    }
  }
  const sessionId =
    typeof ctx?.sessionManager.getSessionId === "function"
      ? (ctx.sessionManager.getSessionId() ?? "")
      : "";
  if (sessionId) return sessionId;
  return DEFAULT_IDENTITY;
}

function resolveCaller(
  as: string | undefined,
  cwd: string | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
): string {
  const caller = as?.trim();
  if (!caller) return sessionIdentity(cwd, pi, ctx);
  if (/[\r\n\u2028\u2029]/.test(caller)) {
    throw new TowerDoValidationError("as must be a single line");
  }
  const callerLength = textLength(caller);
  if (callerLength > MAX_IDENTITY_CHARS) {
    throw new TowerDoValidationError(
      `as is ${callerLength} characters (max ${MAX_IDENTITY_CHARS}) — shorten it`,
    );
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
    `Stable 1-${MAX_TASK_KEY_CHARS} character lowercase task key, e.g. auth-refactor or feat-gemm`,
  minLength: 1,
  maxLength: MAX_TASK_KEY_CHARS,
  pattern: TASK_KEY_PATTERN.source,
});

// Task fields are ARRAY ELEMENTS: a schema rejection can name only
// `tasks.84.*`, so every element-level bound declared here is
// `transportLimit(...)` (a strictly looser payload guard) and the extension —
// fold or execute — owns the error and names the task. Top-level scalar limits
// (as/to/message subject fields) keep the business value — the host
// error names those fields itself, and the extension's own checks there are
// backstops. See CONTRACTS.md "arg schema vs the fold".
const TowerDoTaskSchema = Type.Object({
  key: TaskKeySchema,
  subject: Type.Optional(
    Type.String({
      description:
        `Short imperative task subject, at most ${MAX_TASK_SUBJECT_CHARS} characters; required for a new key, omitted to preserve an existing value`,
      // No `minLength`: emptiness is a content rule the fold owns, so an empty
      // subject is reported as `tasks[N].subject (key) is required` instead of
      // a preflight `/tasks/N/subject must not have fewer than 1 characters`
      // that would abort the whole write without naming the task.
      // Transport guard only: the fold enforces the limit so its error can
      // name the task (see transportLimit).
      maxLength: transportLimit(MAX_TASK_SUBJECT_CHARS),
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        `Long-form task description, at most ${MAX_TASK_DESCRIPTION_CHARS} characters; omitted to preserve, empty string to clear. Keep it a durable statement of the task — evidence and logs belong in a tower_do_talk message, not in every task-list write.`,
      maxLength: transportLimit(MAX_TASK_DESCRIPTION_CHARS),
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
      description:
        "Current task status; required for a new key, omitted to preserve. Use blocked when waiting on a dependency or a peer — blocked is exempt from the dependsOn gate, while in_progress/completed require every dependsOn entry to be completed.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        'Agent/session identity that owns this task. Only the owner or the orchestrator identity "tower" may change its fields (status/owner/subject/description/dependsOn/blockedBy).',
      maxLength: transportLimit(MAX_IDENTITY_CHARS),
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Dependency keys; each must exist on the shared board or in this call, and the graph must stay acyclic. Omitted to preserve, empty array to clear. in_progress/completed require every dependency to be completed first (blocked is exempt).",
      maxItems: transportLimit(MAX_TASK_DEPENDENCIES),
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Free-form blocker ids this task waits on — task or message ids; not validated against the board. Non-empty renders a non-completed task as blocked (task-status gating goes through dependsOn instead).",
      maxItems: transportLimit(MAX_TASK_BLOCKERS),
    }),
  ),
});

const TowerDoParamsSchema = Type.Object({
  tasks: Type.Array(TowerDoTaskSchema, {
    description:
      `Tasks to create or update (upsert). Each entry is created when its key is new, otherwise merged as a patch: omitted optional fields keep their stored value. A key you do NOT list is left untouched — deletion is explicit via \`remove\`, so a partial list can never drop a peer's row. New keys require subject and status. Capacity: at most ${MAX_TOWER_DO_OPEN_TASKS} non-completed tasks on the board after the write; one write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} NEW completed rows (updating a row the board already holds is free). Optional per-task fields: dependsOn, blockedBy.`,
  }),
  remove: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: MAX_TASK_KEY_CHARS,
        pattern: TASK_KEY_PATTERN.source,
      }),
      {
        description:
          'Explicit deletions: task keys to remove. A key not listed here is never deleted. The owner guard applies (owner or "tower"; a non-completed claim idle past the takeover window may be removed by anyone).',
      },
    ),
  ),
  baseRevision: Type.Optional(
    Type.Integer({
      description:
        "Board revision you last observed (from tower_do_status, or the revision printed by your previous tower_do write). Rejects stale writes when a peer changed the board since; omitting it disables the stale-write check.",
      minimum: 0,
    }),
  ),
  as: Type.Optional(
    Type.String({
      description:
        `Identity to act as (default: your session identity); the call is then owner-guarded as that identity. Pass a subagent id to record work on its behalf. Must be a single line, at most ${MAX_IDENTITY_CHARS} characters, and not the reserved broadcast recipient "all". Identities are self-declared labels (cooperative trust, no authentication), so the reserved "${TOWER_IDENTITY}" label carries the owner guard's orchestrator authority by convention, not by verification.`,
      maxLength: MAX_IDENTITY_CHARS,
    }),
  ),
});

const TalkParamsSchema = Type.Object({
  action: StringEnum(["send", "inbox"] as const, {
    description:
      "send delivers a message (requires to + subject + body); inbox lists AND acknowledges your messages (optional limit; all=true reads view-retired messages too).",
  }),
  to: Type.Optional(
    Type.String({
      description:
        'send: recipient identity — "all" (broadcast), "tower" (orchestrator), a current task owner, or anyone with recent board activity. Self-send is rejected.',
      maxLength: MAX_IDENTITY_CHARS,
    }),
  ),
  subject: Type.Optional(
    Type.String({
      description: "send: short single-line subject (required for send)",
      maxLength: MAX_MESSAGE_SUBJECT_CHARS,
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: `send: the message body (required for send), max ${Math.round(MAX_MESSAGE_BYTES / 1024)} KiB — split oversized content into multiple messages.`,
    }),
  ),
  taskKey: Type.Optional(
    Type.String({
      description:
        "send only: task key this message threads under (must exist on the board). Passing it with inbox is an error.",
      minLength: 1,
      maxLength: MAX_TASK_KEY_CHARS,
      pattern: TASK_KEY_PATTERN.source,
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        "inbox only: include messages retired from the default view (fully-read past the budget, or unread past the age valve). The default view hides them; the board never deletes them.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `inbox: max messages to return (default ${DEFAULT_INBOX_LIMIT})`,
      minimum: 1,
      maximum: 100,
    }),
  ),
  as: Type.Optional(
    Type.String({
      description:
        `Identity to act as (default: your session identity); the call is then attributed to that identity. Pass a subagent id to send or file as it. Must be a single line, at most ${MAX_IDENTITY_CHARS} characters, and not the reserved broadcast recipient "all". Identities are self-declared labels (cooperative trust, no authentication).`,
      maxLength: MAX_IDENTITY_CHARS,
    }),
  ),
});

const StatusParamsSchema = Type.Object({
  taskKey: Type.Optional(
    Type.String({
      description:
        "When set, return the FULL detail of this single task (description, deps, blockedBy, updatedAt) instead of the whole dashboard; owner/status/limit are ignored in this mode. Error if the key does not exist.",
      minLength: 1,
      maxLength: MAX_TASK_KEY_CHARS,
      pattern: TASK_KEY_PATTERN.source,
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description: "Filter tasks by owner identity (combined AND with status)",
      maxLength: MAX_IDENTITY_CHARS,
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
      description: "Filter tasks by a single status",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description:
        `Max task lines (default ${DASHBOARD_ROW_BUDGET}). The default budget is won by open (non-completed) rows, so a long completed history can never hide unfinished work; an explicit limit is honoured in fold order. Hidden rows are reported in the output.`,
      minimum: 1,
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

function taskLine(task: TowerDoTask): string {
  const owner = task.owner !== undefined ? ` @${task.owner}` : "";
  const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
  return `${task.key}: ${task.subject}${owner}${deps}`;
}

/** Flatten a tool result's text content into one string — the shared tail of
 * every renderResult handler. Content items may be text or image parts; only
 * text parts carry a usable string. */
function toolResultText(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function formatChange(
  view: TowerBoardView,
  caller: string,
  change: { added: string[]; updated: string[]; removed: string[] },
): string {
  // No-op first — an identical replay of the rows the caller already sent (even
  // of an empty board) is NOT a clear: nothing was removed, so reporting "board
  // cleared" would mislead a caller that replayed an already-empty board.
  if (
    change.added.length === 0 &&
    change.updated.length === 0 &&
    change.removed.length === 0
  ) {
    return `TowerDo board unchanged (revision ${view.revision}, ${view.tasks.length} task(s)) by ${caller} — no field on any task changed.`;
  }
  if (view.tasks.length === 0) {
    // A write that ends with zero tasks only removes (an added task would
    // survive) — name what the caller actually removed.
    return `TowerDo board cleared (revision ${view.revision}) by ${caller}: removed ${change.removed.join(", ")}.`;
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
        `[added] ${STATUS_GLYPH[task.status]} ${taskLine(task)}`,
      );
    }
  }
  return `TowerDo board revision ${view.revision} (${view.tasks.length} task(s)) by ${caller}:\n${lines.join("\n")}`;
}

function ensureKnown(
  view: TowerBoardView,
  recipient: string,
  /** Identities from recent board activity (see knownIdentities). */
  activity: ReadonlySet<string>,
): void {
  // "all" broadcasts; the orchestrator identity is always addressable.
  if (recipient === "all" || recipient === TOWER_IDENTITY) return;
  const known = new Set([
    ...view.tasks
      .map((task) => task.owner)
      .filter((owner): owner is string => owner !== undefined),
    ...activity,
  ]);
  if (!known.has(recipient)) {
    const knownNames = [...known].join(", ");
    throw new TowerDoValidationError(
      `unknown recipient "${recipient}" — address "all", ${TOWER_IDENTITY}, a current task owner, or someone with recent board activity (known: ${knownNames || "(none)"})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function towerDoExtension(pi: ExtensionAPI): void {
  let currentView: TowerBoardView = createEmptyBoard();
  let llmCallsSinceReminder = 0;
  let widgetRegistered = false;
  let uiContext: ExtensionContext | undefined;
  let activeCwd: string | undefined;
  // This instance's own session context (per `towerDoExtension` call), for the
  // identity fallback and the paths that run without a ctx in hand (heartbeat
  // timer, context hook). Instance-scoped on purpose — see sessionIdentity.
  let selfCtx: ExtensionContext | undefined;

  // -------------------------------------------------------------------------
  // Widget (above-editor status line)
  // -------------------------------------------------------------------------

  // Captured by the widget factory so async refreshes can force a repaint —
  // render() is only invoked on TUI-driven redraws otherwise.
  let widgetTui: TUI | undefined;

  const clearWidget = (): void => {
    if (widgetRegistered && uiContext?.hasUI) {
      try {
        uiContext.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // best-effort: widget teardown must never throw during shutdown
      }
    }
    widgetRegistered = false;
    widgetTui = undefined;
  };

  const updateWidget = (ctx?: ExtensionContext): void => {
    if (ctx) uiContext = ctx;
    if (!uiContext?.hasUI || uiContext.mode !== "tui") return;
    // The widget shows the current workload only. Gate it on the rendered
    // string, not on data availability: an empty board (and a completed-only
    // board) yields an empty segment and must not register a blank widget.
    const tasks = getAllTasks(currentView);
    const unfinished = tasks.filter((task) => task.status !== "completed");
    const blocked = unfinished.filter((task) =>
      taskIsBlocked(task, currentView),
    );
    const unread = unreadMessagesToMe(
      currentView,
      sessionIdentity(activeCwd, pi, selfCtx),
    ).length;
    const boardSegment = formatBoardProgress(
      unfinished.length,
      blocked.length,
      unread,
    );
    if (boardSegment === "") {
      clearWidget();
      return;
    }
    if (!widgetRegistered) {
      const factory = (tui: TUI, theme: Theme) => {
          widgetTui = tui;
          return {
            render: (width: number) => {
              const tasks = getAllTasks(currentView);
              const unfinished = tasks.filter(
                (task) => task.status !== "completed",
              );
              const blocked = unfinished.filter((task) =>
                taskIsBlocked(task, currentView),
              );
              const identity = sessionIdentity(activeCwd, pi, selfCtx);
              const inboxForMe = unreadMessagesToMe(
                currentView,
                identity,
              ).length;
              // Progress counts remaining work only: completed rows (often
              // pinned by the owner guard / dependsOn) never appear in the
              // glance, and neither does the monotonic CAS revision.
              const header = formatBoardProgress(
                unfinished.length,
                blocked.length,
                inboxForMe,
                (n, which) =>
                  theme.fg(
                    which === "blocked"
                      ? "error"
                      : which === "unread"
                        ? "warning"
                        : "accent",
                    theme.bold(String(n)),
                  ),
                (s, which) =>
                  which === "title"
                    ? theme.fg("accent", theme.bold(s))
                    : theme.fg("dim", s),
              );
              const lines = [header];
              // WIDGET_TASK_LIMIT caps how many unfinished tasks the
              // above-editor line shows; the rest fold into one overflow line
              // that still names their keys.
              const ordered = [...unfinished].sort(
                (a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1),
              );
              const cap =
                activeCwd === undefined ? ordered.length : WIDGET_TASK_LIMIT;
              const shown = ordered.slice(0, cap);
              for (const task of shown) {
                const glyph = STATUS_GLYPH[task.status];
                const color = statusColor(task.status);
                const owner =
                  task.owner === undefined
                    ? ""
                    : task.owner === identity
                      ? theme.fg("accent", theme.bold(` @${task.owner}`))
                      : theme.fg("dim", ` @${task.owner}`);
                lines.push(
                  `${theme.fg(color, glyph)} ${theme.fg("dim", `${task.key}:`)} ${theme.fg("text", task.subject)}${owner}`,
                );
              }
              if (ordered.length > shown.length) {
                lines.push(
                  theme.fg(
                    "dim",
                    `… and ${String(ordered.length - shown.length)} more open task(s): ${ordered
                      .slice(shown.length)
                      .map((task) => task.key)
                      .join(", ")}`,
                  ),
                );
              }
              return lines
                .filter((line) => line.length > 0)
                .map((line) => truncateToWidth(line, width, "…"));
            },
            invalidate: () => {},
            dispose: () => {},
          };
        };
      try {
        // UI failure must never surface as a board-write failure: every caller
        // reaches here after the write committed, and a thrown error would
        // make the caller retry a write the board already accepted. Leaving the
        // flag false lets a later refresh retry the registration.
        uiContext.ui.setWidget(WIDGET_KEY, factory, {
          placement: "aboveEditor",
        });
        widgetRegistered = true;
      } catch {
        widgetRegistered = false;
      }
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
    selfCtx = ctx;
    activeCwd = ctx.cwd;
    currentView = view;
    uiContext = ctx;
    const caller = resolveCaller(as, ctx.cwd, pi, ctx);
    return { board: entry.board, caller, view };
  };

  const throwIfAborted = (
    signal: AbortSignal | undefined,
    label: string,
  ): void => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`${label} cancelled`);
  };

  // -------------------------------------------------------------------------
  // tower_do — plan / claim / update / complete / block shared tasks
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TOOL_NAME,
    label: "TowerDo",
    description: `Maintain the shared multi-agent task board with one atomic update.
- Upsert semantics: list only the tasks you create or change. Omitted optional fields on an existing key are preserved, and new keys require subject and status. A key you do not list is left untouched (there is no implicit removal) — delete with the explicit 'remove' field.
- Owner guard: a task with an owner can only be changed (any field) or removed by its owner or the "tower" identity. Exception: a non-completed task whose OWN activity is older than ${formatTakeoverWindow()} (TASK_CLAIM_STALE_MS; unrelated board chatter does not protect a row, and an owner's activity on another task never protects this one) may be displaced row by row — adopt it by setting owner to yourself and changing nothing else in that write (any content edit in the same write is rejected; re-plan in a second write), or remove it; completed tasks stay guarded.
- Dependencies gate status: in_progress/completed require every dependsOn entry to be completed, dependsOn keys must exist on the board or in this call, and cycles are rejected (blocked is exempt).
- Content limits (subject ${MAX_TASK_SUBJECT_CHARS} / description ${MAX_TASK_DESCRIPTION_CHARS} characters) are enforced per task and a violation names the task key, so fix that one row instead of resending everything. An omitted field on an existing task is preserved (send only what changes); long-form evidence belongs in a tower_do_talk message, not in description.
- Always pass baseRevision from tower_do_status; omitting it disables the stale-write check.
- Capacity: up to ${MAX_TOWER_DO_OPEN_TASKS} non-completed tasks. Completed rows are receipts — they replay free, do not count, and can only be dropped by their owner or "tower", so a board of finished work never blocks a new plan. One write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} NEW completed rows (replaying an existing receipt is free; split a larger batch of deliveries across successive writes). When the open budget is full, remove or complete an existing open task first. Optional per-task fields: dependsOn (see above), blockedBy (free-form ids — non-empty renders a non-completed task as blocked).`,
    promptSnippet:
      "Maintain the shared multi-agent task board with one atomic update",
    promptGuidelines: [
      "Use tower_do for the task plan instead of direct file edits when multiple agents or sessions share the work; it is the shared board, not a private todo list.",
      "tower_do upserts only the tasks you list: read tower_do_status first, then send just the rows you create or change (delete with `remove`).",
      "When a task needs a plan of 3+ steps, define it yourself and call tower_do with subject + status before beginning substantive work.",
      "Include baseRevision (from tower_do_status) in every tower_do call; a stale revision is rejected so you never silently overwrite a peer's update.",
      "Mark a task completed only after implementation and verification succeed. Use status blocked with a blockedBy note instead of leaving it hanging.",
      "Claim shared tasks by setting owner and in_progress together. Only the owner or the orchestrator identity tower may change an owned task's fields or remove it — to remove or reassign another agent's task, message the owner via tower_do_talk instead of editing it directly. If a task's owner has been idle on THAT task for " + formatTakeoverWindow() + "+ (unrelated board activity does not count), you may adopt it (set owner to yourself and change nothing else in that write) or remove it while it is not completed; completed tasks stay with their owner.",
      "Reconcile actual progress with the shared board before your final response, and do not issue a no-op tower_do call only to acknowledge a reminder.",
    ],
    parameters: TowerDoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo update");
      const { board, caller } = await prepare(ctx, params.as);
      return withFileMutationQueue(board.file, async () => {
        const { details } = await board.withWrite(async (appendLocked) => {
        // Re-fold inside both queues: the revision guard must observe peer
        // appends before it decides whether the write is stale.
        throwIfAborted(signal, "TowerDo update");
        const freshView = await foldRetained(ctx.cwd);
        throwIfAborted(signal, "TowerDo update");
        // Stale-owner eligibility needs board-wide last-activity and is a
        // PERMISSION gate, so it reads the FULL log (rawLines) — a bounded
        // tail could truncate an active owner's recent events in a churny
        // fleet and let a peer displace them. fold() already reads the whole
        // file, so the full scan adds no asymptotic cost. A missing log
        // disables the takeover exception (no stale owners) rather than
        // loosening the guard.
        let activity: ActivityEntry[] = [];
        try {
          activity = (await board.rawLines())
            .reverse()
            .map((line) => parseActivityLine(line))
            .filter((entry): entry is ActivityEntry => entry !== undefined);
        } catch {
          // Unreadable log → empty activity, which `staleTaskClaims` maps to
          // "no stale claims" (strict guard); the write must still land.
        }
        // An empty activity list (unreadable / empty log) already means "no
        // stale claims" inside the derivation — strict guard, never loosened.
        const staleClaims = staleTaskClaims(
          activity,
          freshView.tasks,
          Date.now(),
        );
        const details = writeBoardSnapshot(
          freshView,
          {
            tasks: params.tasks,
            ...(params.remove === undefined ? {} : { remove: params.remove }),
            baseRevision: params.baseRevision,
          },
          caller,
          staleClaims,
        );
        throwIfAborted(signal, "TowerDo update");
        await appendLocked(details.taskEvents);
        return { details, activity };
        });
        currentView = cloneBoard(details.view);
        llmCallsSinceReminder = 0;
        updateWidget(ctx);
        const base = formatChange(details.view, caller, details.change);
        return {
          content: [{ type: "text", text: base }],
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
        // `as` overrides the session identity for this call; trimmed to
        // match resolveCaller on the execute side.
        const asArg = typeof args.as === "string" ? args.as.trim() : "";
        const acting = asArg || sessionIdentity(activeCwd, pi, selfCtx);
        const owner2 =
          typeof task.owner === "string" && task.owner
            ? task.owner === acting
              ? theme.fg("accent", theme.bold(` @${task.owner}`))
              : theme.fg("dim", ` @${task.owner}`)
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
        const output = toolResultText(result);
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
  // tower_do_talk — addressed messages
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TALK_TOOL_NAME,
    label: "TowerDo Talk",
    description:
      `Cross-agent communication on the shared tower-do board. action=send delivers an inbox message to "all", the orchestrator identity "tower", a current task owner, or anyone with recent board activity (self-send rejected); taskKey optionally threads it under a task. action=inbox lists messages addressed to you or "all", newest first, and ACKS the ones it shows (marks them read; acked messages can be retired) — use tower_do_status to read messages without acking.`,
    promptSnippet:
      "Send addressed messages on the shared multi-agent board",
    promptGuidelines: [
      'Use tower_do_talk to communicate with task owners on the shared board instead of editing owned tasks directly; the recipient must be "all", "tower", a current task owner, or someone with recent board activity (e.g. a peer whose tasks are all completed).',
      "Keep message bodies brief and reference files by path; the board persists everything, so pointer-style notes keep context lean.",
      "Prefer tower_do_status over action=inbox when you only need to read messages: inbox acknowledges what it shows, status does not.",
    ],
    parameters: TalkParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo talk");
      const { board, caller } = await prepare(ctx, params.as);
      const now = Date.now();

      if (params.action !== "send" && params.taskKey !== undefined) {
        throw new TowerDoValidationError(
          `taskKey applies to action=send only (got action=${params.action})`,
        );
      }

      if (params.action === "send") {
        const to = params.to?.trim();
        if (!to)
          throw new TowerDoValidationError(
            'send requires a recipient: "all", "tower", a task owner, or someone with recent board activity',
          );
        if (/[\r\n\u2028\u2029]/.test(to)) {
          throw new TowerDoValidationError(
            "send recipient must be a single line",
          );
        }
        // Same agent, not just the same string: a session that migrated from a
        // legacy label must not be able to address itself.
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
        // `withWrite` holds the in-process write chain across the fold, the
        // existence/recipient checks, the audience snapshot and the append, so
        // no local write can land in between and the persisted message cannot
        // carry a taskKey that was removed beside it (cross-process races are
        // covered by folding the fresh view here plus append atomicity). The
        // same reason tower_do uses withWrite.
        await board.withWrite(async (appendLocked) => {
          throwIfAborted(signal, "TowerDo talk");
          const fresh = await foldRetained(ctx.cwd);
          throwIfAborted(signal, "TowerDo talk");
          // Existence is checked against THIS fold, not the pre-queue view:
          // the task can be removed in between, and the persisted message must
          // not carry a dangling taskKey.
          if (
            params.taskKey !== undefined &&
            !fresh.tasks.some((task) => task.key === params.taskKey)
          ) {
            throw new TowerDoValidationError(
              `taskKey references unknown task ${params.taskKey}`,
            );
          }
          // Reachable recipients: current owners PLUS anyone with recent board
          // activity — a peer whose tasks are all completed is no longer an
          // owner but exactly who hand-off coordination needs to reach.
          let recentActivity = new Set<string>();
          try {
            // FULL log, not a bounded tail: a 200-line window can fall behind
            // a churny fleet and turn a recently active peer into an "unknown
            // recipient" — the same reason the takeover gate reads rawLines().
            const raw = await board.rawLines();
            const parsed: ActivityEntry[] = [];
            for (const line of raw) {
              const entry = parseActivityLine(line);
              if (entry !== undefined) parsed.push(entry);
            }
            recentActivity = knownIdentities(fresh, parsed);
          } catch {
            // No/unreadable activity log: owners only.
          }
          ensureKnown(fresh, to, recentActivity);
          // Snapshot the broadcast audience (owners at send time, sender
          // excluded) so full-read / retirement uses the people who were
          // actually addressed — an owner joining later never read it and
          // must not keep the broadcast alive forever. Deduped: an owner
          // holding several tasks would otherwise repeat in the persisted
          // audience.
          const audience =
            to === "all"
              ? [
                  ...new Set(
                    fresh.tasks
                      .map((task) => task.owner)
                      .filter(
                        (owner): owner is string =>
                          owner !== undefined && owner !== caller,
                      ),
                  ),
                ]
              : undefined;
          const message: TowerDoMessage = {
            ...messageBase,
            ...(audience === undefined || audience.length === 0
              ? {}
              : { audience }),
          };
          throwIfAborted(signal, "TowerDo talk");
          await appendLocked([
            { kind: "message", message, by: caller, at: now },
          ]);
          currentView = cloneBoard({
            ...fresh,
            messages: [...fresh.messages, message],
          });
          llmCallsSinceReminder = 0;
          updateWidget(ctx);
        });
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
        const limit = params.limit ?? DEFAULT_INBOX_LIMIT;
        const now2 = Date.now();
        // Reading your inbox acks the messages shown (LWW readBy update): the
        // sender learns you saw them, and fully-read history can be retired.
        return withFileMutationQueue(board.file, async () => {
        throwIfAborted(signal, "TowerDo talk");
        // `all` reads the full fold (view-retired messages included); the
        // default reads the retained view, so an inbox never resurfaces what
        // the board deliberately retired from the display layer.
        const readFold = async (): Promise<TowerBoardView> =>
          params.all ? await board.fold() : await foldRetained(ctx.cwd);
        const myInbox = (view: TowerBoardView): TowerDoMessage[] =>
          messagesToMe(view, caller)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit);
        const inboxResult = (
          fresh: TowerBoardView,
          mine: TowerDoMessage[],
          ackedIds: ReadonlySet<string>,
        ): {
          content: { type: "text"; text: string }[];
          details: { caller: string; inbox: TowerDoMessage[] };
        } => {
          if (mine.length === 0) {
            return {
              content: [
                { type: "text" as const, text: `TowerDo inbox empty for ${caller}.` },
              ],
              details: { caller, inbox: [] },
            };
          }
          const withAcks = (message: TowerDoMessage): TowerDoMessage =>
            ackedIds.has(message.id) && !(message.readBy ?? []).includes(caller)
              ? { ...message, readBy: readByWith(message.readBy, caller) }
              : message;
          const updatedMessages = mine.map(withAcks);
          currentView = cloneBoard({
            ...fresh,
            // `all` must not leak retired history back into the shared view:
            // re-apply the retention projection before publishing it to the
            // widget/status/reminder paths.
            messages: retainMessages(
              fresh.messages.map(withAcks),
              fresh,
              MESSAGE_RETENTION,
              now2,
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
                type: "text" as const,
                text: `TowerDo inbox for ${caller} (${String(mine.length)}${ackedIds.size > 0 ? `, ${String(ackedIds.size)} newly acked` : ""}):\n${lines.join("\n")}`,
              },
            ],
            details: { caller, inbox: updatedMessages },
          };
        };
        // Fast path: with nothing of mine unacked this is a PURE READ — it
        // appends nothing, so a read-only state dir still serves an inbox.
        const peek = await readFold();
        throwIfAborted(signal, "TowerDo talk");
        const peekMine = myInbox(peek);
        if (
          !peekMine.some((message) => !(message.readBy ?? []).includes(caller))
        ) {
          return inboxResult(peek, peekMine, new Set());
        }
        // There IS something to ack: the fold, the ack set and the append must
        // be one atomic step across processes, or two peers acking the same
        // message lose one `readBy` entry to last-write-wins.
        return board.withWrite(async (appendLocked) => {
          throwIfAborted(signal, "TowerDo talk");
          const fresh = await readFold();
          throwIfAborted(signal, "TowerDo talk");
          const unacked = myInbox(fresh).filter(
            (message) => !(message.readBy ?? []).includes(caller),
          );
          if (unacked.length > 0) {
            throwIfAborted(signal, "TowerDo talk");
            await appendLocked(
              unacked.map((message) => ({
                kind: "message" as const,
                message: {
                  ...message,
                  readBy: readByWith(message.readBy, caller),
                },
                by: caller,
                at: now2,
              })),
            );
          }
          return inboxResult(
            fresh,
            myInbox(fresh),
            new Set(unacked.map((message) => message.id)),
          );
        });
        });
      }

      // Unreachable: the arg schema allows only send|inbox. Kept so the
      // exhaustiveness is explicit rather than an implicit `undefined` return.
      throw new TowerDoValidationError(
        `unsupported tower_do_talk action: ${String(params.action)}`,
      );
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action =
        typeof args.action === "string" && args.action ? args.action : "";
      let detail = "";
      if (action === "send") {
        detail = typeof args.to === "string" && args.to ? ` → ${args.to}` : "";
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
      const output = toolResultText(result);
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
    description: `Read the shared tower-do board: everyone's tasks (owner, status, deps, blocks), messages addressed to you, and the recent activity tail. Open tasks render in full, recency-first; completed rows render as a compact key ledger (their detail is one taskKey lookup away). Still bounded by the byte/line caps, which disclose what they cut. Also prints the board file path and the current revision (pass it back as baseRevision) so subagents can read state directly (file-as-state). Reading here does NOT ack messages (tower_do_talk action=inbox does). Pass taskKey for the FULL detail of one task. Output is bounded to ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB / ${String(DEFAULT_MAX_LINES)} lines from the TAIL (the head — header, revision, board file path and open-task rows — is dropped first) and says so in a footer when that happens.`,
    promptSnippet:
      "Show the shared multi-agent task board: tasks, messages, activity",
    promptGuidelines: [
      "Use tower_do_status before starting work to see who owns what on the shared board, and before finishing work to reconcile your own tasks.",
      "When a tower_do write is rejected as stale, call tower_do_status first to re-read the current revision, then merge your changes and retry with the new baseRevision.",
      "Share the board file path from tower_do_status with subagents so they can read shared state directly; have them report back instead of editing owned tasks.",
      "Read the board (tower_do_status) before a tower_do write: it is an upsert — a key you do not list is left untouched, and deleting needs the explicit remove list.",
    ],
    parameters: StatusParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo status");
      const { board, caller, view } = await prepare(ctx, undefined);
      const tasks = getAllTasks(view);
      // Blocked is DERIVED (taskIsBlocked), matching the reminder header and
      // row suffixes. displayStatus is the single rendering contract: the
      // summary counts, the status filter, and the sections below all go
      // through it, so a gated pending task is found, counted, and grouped
      // as blocked everywhere.
      const displayStatus = (task: TowerDoTask): TowerDoStatus =>
        task.status !== "completed" && taskIsBlocked(task, view)
          ? "blocked"
          : task.status;
      const statusCount = (status: TowerDoStatus): number =>
        tasks.filter((task) => displayStatus(task) === status).length;
      const inProgressCount = statusCount("in_progress");
      const pendingCount = statusCount("pending");
      const completedCount = statusCount("completed");
      const blockedCount = statusCount("blocked");
      // Write-side capacity is stored status, not display status (a gated
      // pending row still occupies an open slot): open = non-completed.
      const openCount = tasks.length - completedCount;
      // Fetch a wider tail than the rendered window: presence (who is around,
      // who went idle) needs enough history to judge inactivity, while the
      // rendered activity feed only shows the configured activity tail.
      // The tail is also the source for the header's "last updated" line, so
      // it is parsed once and shared by all three consumers.
      const tailCount = STATUS_ACTIVITY_TAIL;
      const presenceCount = Math.max(tailCount, 200);
      const now = Date.now();
      let rawTail: string[] = [];
      try {
        rawTail = (await board.rawTail(presenceCount)).reverse();
      } catch {
        // Missing/unreadable log → empty activity; the folded view still renders.
      }
      const parsedEntries = rawTail
        .map((line) => parseActivityLine(line))
        .filter((entry): entry is ActivityEntry => entry !== undefined);
      const recentEntries = parsedEntries.slice(0, tailCount);
      const lastWrite = latestActivity(parsedEntries);

      // Totals BEFORE the page slice: the section headers must not report a
      // silently capped count as if it were the whole list (the task rows get
      // a hidden-rows note for exactly this reason).
      const allMyMessages = messagesToMe(view, caller).sort((a, b) => b.at - a.at);
      const myMessages = allMyMessages.slice(0, DASHBOARD_LIST_LIMIT);
      const myUnread = unreadMessagesToMe(view, caller).length;

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
                (params.status === undefined ||
                  displayStatus(task) === params.status),
            )
          : tasks;
      const limit = params.limit;
      // Open rows win the default budget (stable partition, so the slice keeps
      // fold order); an explicit `limit` is honoured in fold order verbatim.
      const budget = limit ?? DASHBOARD_ROW_BUDGET;
      const ordered = [
        ...filtered.filter((task) => task.status !== "completed"),
        ...filtered.filter((task) => task.status === "completed"),
      ];
      const shown = ordered.slice(0, budget);
      const hidden = ordered.length - shown.length;

      // A taskKey detail read is bounded like the dashboard: a long
      // description can render thousands of lines, and the tool description
      // promises the cut is disclosed.
      const boundedDetail = (body: string, label: string): string => {
        const cut = truncateTail(body, { maxBytes: DEFAULT_MAX_BYTES });
        if (!cut.truncated) return cut.content;
        const reserved =
          `… ${label} truncated: showing the last ${String(cut.outputLines)} of ${String(cut.totalLines)} lines. ` +
          `Revision ${String(view.revision)} · board file ${board.file}`;
        const kept = truncateTail(body, {
          maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(reserved) - 1,
          maxLines: DEFAULT_MAX_LINES - 1,
        });
        // The footer reports the second cut's real line count, not the first
        // cut's: the second cut also applies the line cap, so `kept` can be
        // shorter than `cut`. `kept.outputLines <= cut.outputLines`, so this
        // footer never exceeds the `reserved` byte budget above.
        const footer =
          `… ${label} truncated: showing the last ${String(kept.outputLines)} of ${String(cut.totalLines)} lines. ` +
          `Revision ${String(view.revision)} · board file ${board.file}`;
        return `${kept.content}\n${footer}`;
      };

      // Single-task detail mode: taskKey takes precedence over the dashboard
      // filters — the caller asked for one task's full record (description is
      // never rendered in the grouped view), not another filtered listing.
      if (params.taskKey !== undefined) {
        const task = tasks.find((t) => t.key === params.taskKey);
        if (task === undefined) {
          throw new TowerDoValidationError(
            `no task with key "${params.taskKey}" on the board (revision ${view.revision})`,
          );
        }
        const ownerNote =
          task.owner === undefined
            ? ""
            : ` (owner: ${task.owner}${task.owner === caller ? ", me" : ""})`;
        const detail: string[] = [
          `TowerDo task ${task.key} — revision ${view.revision} (board file: ${board.file})`,
          `- subject: ${task.subject}`,
          `- status: ${task.status}${ownerNote}`,
          `- updatedAt: ${relativeTime(now, task.updatedAt)} (${new Date(task.updatedAt).toISOString()})`,
        ];
        if (task.dependsOn.length > 0) {
          const unresolved = findAllUnresolvedDeps(task, view);
          detail.push(
            `- dependsOn: ${task.dependsOn.join(", ")}${unresolved.length > 0 ? ` (unresolved: ${unresolved.join(", ")})` : " (all completed)"}`,
          );
        }
        if (task.blockedBy.length > 0) {
          detail.push(`- blockedBy: ${task.blockedBy.join(", ")}`);
        }
        if (taskIsBlocked(task, view)) detail.push("- blocked: yes");
        if (task.description === undefined) {
          detail.push("- description: (none)");
        } else {
          detail.push("- description:");
          for (const row of task.description.split("\n")) {
            detail.push(`  ${row}`);
          }
        }
        const detailText = boundedDetail(
          `${detail.join("\n")}\n`,
          "task detail",
        );
        return {
          content: [{ type: "text", text: detailText }],
          details: {
            caller,
            revision: view.revision,
            board: board.file,
            identity: caller,
            taskKey: task.key,
            // task already comes from getAllTasks (deep clone) — hand it out
            // directly; no board-wide clone needed.
            task,
          },
        };
      }

      const lines: string[] = [];
      lines.push(
        `TowerDo shared board — identity ${caller}, revision ${view.revision}`,
      );
      lines.push(`Board file: ${board.file}`);
      if (!existsSync(board.file)) {
        lines.push(
          "⚠ the board file is missing — this is an empty fold. Writes treat the missing file as an empty board.",
        );
      }
      // Board exit / log observability (Layer C): make "which board is growing"
      // a fact instead of something the user has to find in ~/.pi/tower-do.
      let logLines = 0;
      let logBytes = 0;
      let compactRev: number | undefined;
      try {
        const size = statSync(board.file).size;
        const allLines = await board.rawLines();
        logLines = allLines.length;
        logBytes = size;
        try {
          const head: unknown = JSON.parse(allLines[0] ?? "null");
          if (
            head !== null &&
            typeof head === "object" &&
            (head as { kind?: unknown }).kind === "compact" &&
            typeof (head as { revision?: unknown }).revision === "number"
          ) {
            compactRev = (head as { revision: number }).revision;
          }
        } catch {
          // Legacy log without a compact header.
        }
      } catch {
        // Missing/unreadable board: leave the counters at zero.
      }
      if (logLines > 0 || logBytes > 0) {
        lines.push(
          `State: ${basename(dirname(board.file))} · log ${String(logLines)} line(s) / ${(logBytes / 1024).toFixed(0)}KB` +
            (compactRev === undefined
              ? ""
              : ` · compact rev ${String(compactRev)}`),
        );
      }
      // Compaction is gone, so a large log is expected — only unfoldable
      // lines are worth surfacing (data the board holds and nobody can see).
      if (view.skipped > 0) {
        lines.push(
          `Log holds unfoldable data: ${String(view.skipped)} line(s) cannot be folded (of ${String(logLines)} lines, ${(logBytes / (1024 * 1024)).toFixed(1)}MB)`,
        );
      }
      // D4: board liveness at a glance. revision is monotonic but silent —
      // a coordinator needs to know how stale the board is and who last
      // moved it (pure read derivation from the activity tail, zero writes).
      const updated =
        lastWrite === undefined
          ? "no board writes yet"
          : `last updated ${relativeTime(now, lastWrite.at)} by ${lastWrite.by}`;
      lines.push(`Activity: ${updated}`);
      lines.push(
        `Tasks: ${tasks.length} total (${inProgressCount} in_progress, ${blockedCount} blocked, ${pendingCount} pending, ${completedCount} completed) · open ${openCount}/${MAX_TOWER_DO_OPEN_TASKS}`,
      );
      if (view.skipped > 0) {
        lines.push(
          `⚠ ${view.skipped} board log line(s) could not be folded (corrupt, foreign, or no longer valid under the current limits) — the board still holds them; read ${board.file} to recover them.`,
        );
      }
      if (openCount >= MAX_TOWER_DO_OPEN_TASKS) {
        lines.push(
          `Open-task budget full: completed rows do not count${OPEN_TASK_BUDGET_HINT}`,
        );
      }
      lines.push("");

      const taskRow = (task: TowerDoTask): string => {
        const owner =
          task.owner === undefined
            ? ""
            : ` @${task.owner}${task.owner === caller ? " (me)" : ""}`;
        const deps = task.dependsOn.length
          ? ` ← ${task.dependsOn.join(",")}`
          : "";
        // Derived status: a gated pending row must not render as `○` while
        // the header counts it blocked.
        const shownStatus = displayStatus(task);
        const blockers =
          shownStatus === "blocked"
            ? [
                ...new Set([
                  ...task.blockedBy,
                  ...findAllUnresolvedDeps(task, view),
                ]),
              ]
            : [];
        const blockedSuffix =
          blockers.length > 0 ? ` [blocked by: ${blockers.join(",")}]` : "";
        return `- ${STATUS_GLYPH[shownStatus]} ${task.key}: ${task.subject}${owner}${deps}${blockedSuffix}`;
      };
      // Open tasks first, then a compact ledger of completed receipts: their
      // subject is one `taskKey` lookup away, and rendering them per row would
      // spend the first screen on history.
      const openShown = shown.filter((task) => task.status !== "completed");
      const completedShown = shown.filter(
        (task) => task.status === "completed",
      );
      if (openShown.length > 0) {
        lines.push(`## Open (${String(openShown.length)})`);
        for (const task of openShown) lines.push(taskRow(task));
        lines.push("");
      }
      if (completedShown.length > 0) {
        lines.push(`## Completed (${String(completedShown.length)}, keys)`);
        lines.push(`- ${completedShown.map((task) => task.key).join(", ")}`);
        lines.push("");
      }
      if (shown.length === 0) lines.push("(no tasks match the filter)");
      if (hidden > 0) {
        lines.push(
          `… ${String(hidden)} more task row(s) hidden by the ${String(budget)}-row budget — pass a larger limit or narrow the filter.`,
        );
      }
      lines.push(
        `## Messages for ${caller} (${myMessages.length}${
          allMyMessages.length > myMessages.length
            ? ` of ${allMyMessages.length}`
            : ""
        }; ${myUnread} unread)`,
      );
      for (const message of myMessages) {
        const readMark = (message.readBy ?? []).includes(caller)
          ? "read"
          : "UNREAD";
        lines.push(
          `- [${message.id}] [${readMark}] ${message.from} → me${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject} — ${message.body.split("\n")[0]}`,
        );
      }
      if (myMessages.length === 0) lines.push("(none)");

      lines.push("");
      lines.push("## Recent activity (newest first)");
      for (const line of formatActivityFeed(recentEntries, now)) {
        lines.push(line);
      }
      if (recentEntries.length === 0) lines.push("(no recent activity)");

      const full = `${lines.join("\n")}\n`;
      const cut = truncateTail(full, { maxBytes: DEFAULT_MAX_BYTES });
      // truncateTail keeps the TAIL and drops the head — which is exactly where
      // the revision, the board file path and the open-task rows live (open
      // groups render first). An unmarked cut would silently cost the caller
      // rows it must name in its next full-replacement write, so the surviving
      // tail carries the essentials plus an explicit warning. The warning is
      // part of the same budget: the body is re-cut with room reserved for it
      // in BOTH bounds (bytes and one line), so the note can never be the row
      // that pushes the result past what this call promised.
      const truncationNote = (shown: number, total: number): string =>
        `… dashboard truncated: showing the last ${String(shown)} of ${String(total)} lines (the head was dropped — the open-task listing and the header may be missing). Revision ${String(view.revision)} · board file ${board.file} — read that file for the full fold, or narrow this call with limit/owner=/status=.`;
      let text = cut.content;
      if (cut.truncated) {
        const reserved = truncationNote(cut.outputLines, cut.totalLines);
        const head = truncateTail(full, {
          maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(reserved) - 1,
          maxLines: DEFAULT_MAX_LINES - 1,
        });
        // The re-cut can only show fewer lines than `cut`, and the line totals
        // it reports are the same, so the final note cannot outgrow `reserved`.
        text = `${head.content}\n${truncationNote(head.outputLines, head.totalLines)}`;
      }
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

    renderResult(result, { isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Folding shared board..."));
        return text;
      }
      const output = toolResultText(result);
      if (!output) {
        if (result.details) text.setText("");
        return text;
      }
      const lines = output.split("\n");
      // Caller-owned lines stand out: accent + bold vs plain toolOutput. The
      // execute side already resolved the caller; prefer it over re-deriving.
      const details = (result.details ?? {}) as Record<string, unknown>;
      const caller =
        typeof details.identity === "string"
          ? details.identity
          : sessionIdentity(activeCwd, pi, selfCtx);
      const visible = lines;
      let rendered = visible
        .map((line) =>
          !context.isError && isCallerLine(line, caller)
            ? theme.fg("accent", theme.bold(line))
            : theme.fg(context.isError ? "error" : "toolOutput", line),
        )
        .join("\n");
      if (visible.length < lines.length) {
        rendered += theme.fg(
          "dim",
          `\n… ${lines.length - visible.length} more (${keyHint("app.tools.expand", "expand")})`,
        );
      }
      text.setText(rendered);
      return text;
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle: restore, reminders, shutdown
  // -------------------------------------------------------------------------


  const restore = async (ctx: ExtensionContext): Promise<void> => {
    clearWidget();
    // Only this instance's own context — a nested session's restore must not
    // re-label this one (see sessionIdentity).
    selfCtx = ctx;
    activeCwd = ctx.cwd;
    // Disk is authoritative; a missing board file is an empty board. Writes
    // fold the real file, so no in-memory fallback can hand a caller a
    // baseRevision the write gate would reject.
    currentView = await foldRetained(ctx.cwd);
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

  // Repaint after each settled agent run so peer board writes show up in the
  // widget. TUI mode only — print/RPC never has a widget.
  pi.on("agent_settled", async () => {
    if (
      uiContext?.mode !== "tui" ||
      !uiContext?.hasUI ||
      activeCwd === undefined
    )
      return;
    const settledEntry = boards.entryFor(activeCwd);
    if (existsSync(settledEntry.board.file)) {
      currentView = await foldRetained(activeCwd);
    }
    updateWidget();
    widgetTui?.requestRender();
  });

  pi.on("context", async (event, ctx) => {
    // A board reminder persisted in the transcript must not keep cancelled
    // todos in the LLM context after a peer writes; always strip it.
    // Replacing with a fresh reminder is a separate cadence
    // (REMINDER_INTERVAL) — a leftover reminder must not skip the counter and
    // re-inject every call.
    const isBoardContext = (message: {
      role?: string;
      customType?: string;
    }): boolean =>
      message.role === "custom" &&
      message.customType === TOWER_DO_REMINDER_TYPE;
    const messages = event.messages.filter(
      (message) => !isBoardContext(message),
    );
    const stripped = messages.length !== event.messages.length;
    const cwd = ctx?.cwd ?? activeCwd;
    if (cwd === undefined) {
      return stripped ? { messages } : undefined;
    }
    const contextEntry = boards.entryFor(cwd);
    if (existsSync(contextEntry.board.file)) {
      currentView = await foldRetained(cwd);
    }
    const identity = sessionIdentity(cwd, pi, selfCtx);
    const tasks = getAllTasks(currentView);
    const hasUnfinished = tasks.some((task) => task.status !== "completed");
    const hasInbox = unreadMessagesToMe(currentView, identity).length > 0;
    if (!hasUnfinished && !hasInbox) {
      llmCallsSinceReminder = 0;
      return stripped ? { messages } : undefined;
    }
    llmCallsSinceReminder += 1;
    if (llmCallsSinceReminder < REMINDER_INTERVAL) {
      return stripped ? { messages } : undefined;
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

  pi.on("session_shutdown", () => {
    clearWidget();
    uiContext = undefined;
    selfCtx = undefined;
    activeCwd = undefined;
    currentView = createEmptyBoard();
    llmCallsSinceReminder = 0;
    // Re-resolve project roots next session: the filesystem may have gained
    // or lost a `.git` boundary since this session started (e.g. `git init`
    // mid-session). Within a session the cache is deliberately stable — moving
    // the board file mid-session would orphan earlier events (split-brain).
    projectRootCache.clear();
  });
}
