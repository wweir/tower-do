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
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";

import {
  normalizeBoardConfig,
  TowerBoard,
  type TowerDoConfig,
} from "./board.ts";
import {
  ABSENT_HASH,
  formatGitSegment,
  headMoveIsExternal,
  parseDiffNames,
  parsePorcelain,
  sessionTouchedDelta,
  zipHashObject,
} from "./git-count.ts";
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
  formatBoardProgress,
  formatBoardReminder,
  findScopeConflicts,
  orderTasksMineFirst,
  formatLiveSegment,
  formatPresenceLine,
  getAllTasks,
  isCallerLine,
  isTowerDoStatus,
  knownIdentities,
  latestActivity,
  latestBoardCheckpoint,
  LIVE_HEARTBEAT_MS,
  LIVE_PRUNE_MS,
  LIVE_WINDOW_MS,
  liveOwnerIdentities,
  liveSessionCount,
  parseLiveRecord,
  MAX_FINDING_SUMMARY_CHARS,
  MAX_FINDING_TITLE_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_TOWER_DO_TASKS,
  messagesToMe,
  parseActivityLine,
  relativeTime,
  retainMessages,
  staleTaskOwners,
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
  type LiveRecord,
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
        "Current task status; required for a new key, omitted to preserve. Use blocked when waiting on a dependency or a peer — blocked is exempt from the dependsOn gate, while in_progress/completed require every dependsOn entry to be completed.",
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
        "Dependency keys; each must exist on the shared board or in this call, and the graph must stay acyclic. Omitted to preserve, empty array to clear. in_progress/completed require every dependency to be completed first (blocked is exempt).",
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
        'Delivery receipt: files the owner actually changed, repo-relative. Only settable when status is "completed" — pass it in the same call that completes the task. Reopening the task (status back to pending/in_progress/blocked) without an explicit changedFiles voids the inherited receipt; changedFiles: [] clears it while staying completed. A worker may set it once; its owner or "tower" may amend later (the owner guard rejects other workers).',
      maxItems: 100,
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Free-form blocker ids this task waits on — task, message, or finding ids; not validated against the board. Non-empty renders a non-completed task as blocked (task-status gating goes through dependsOn instead).",
      maxItems: 20,
    }),
  ),
});

const TowerDoParamsSchema = Type.Object({
  tasks: Type.Array(TowerDoTaskSchema, {
    description:
      "Complete authoritative task list to retain: every key you want kept must appear here, because any current key omitted from the list is removed. An omitted task owned by another agent (and not stale) makes the write fail rather than dropping it; replay peers' and unowned tasks you did not mean to remove. Existing keys may omit unchanged fields (they are preserved per field); new keys require subject and status.",
    maxItems: MAX_TOWER_DO_TASKS,
  }),
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
        'Identity to act as (default: your session identity); the call is then owner-guarded as that identity. Pass a subagent id to record work on its behalf. Must be a single line, at most 64 characters, and not the reserved broadcast recipient "all".',
      maxLength: 64,
    }),
  ),
});

const TalkParamsSchema = Type.Object({
  action: StringEnum(["send", "inbox", "finding"] as const, {
    description:
      "send delivers a message (requires to + subject + body); inbox lists AND acknowledges your messages (optional limit); finding files a structured finding (requires kind + title + summary) or updates one (requires findingId + status).",
  }),
  to: Type.Optional(
    Type.String({
      description:
        'send: recipient identity — "all" (broadcast), "tower" (orchestrator), a current task owner, or anyone with recent board activity. Self-send is rejected.',
      maxLength: 64,
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
      description: `send or finding: the message body (required for send) or finding summary (required when filing a finding); send body max ${Math.round(MAX_MESSAGE_BYTES / 1024)} KiB — split oversized content into multiple messages`,
    }),
  ),
  taskKey: Type.Optional(
    Type.String({
      description:
        "send only: task key this message threads under (must exist on the board). Passing it with inbox/finding is an error — findings are board-level and carry no task link.",
      minLength: 1,
      maxLength: 40,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
    }),
  ),
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
      description: "inbox: max messages to return (default 20)",
      minimum: 1,
      maximum: 100,
    }),
  ),
  as: Type.Optional(
    Type.String({
      description:
        'Identity to act as (default: your session identity); the call is then attributed to that identity. Pass a subagent id to send or file as it. Must be a single line, at most 64 characters, and not the reserved broadcast recipient "all".',
      maxLength: 64,
    }),
  ),
});

const StatusParamsSchema = Type.Object({
  taskKey: Type.Optional(
    Type.String({
      description:
        "When set, return the FULL detail of this single task (description, scope, changedFiles, updatedAt) instead of the whole dashboard; owner/status/limit are ignored in this mode. Error if the key does not exist.",
      minLength: 1,
      maxLength: 40,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
    }),
  ),
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
  // No-op first — an identical full-list replay (even of an empty board) is
  // NOT a clear: nothing was removed, so reporting "board cleared" would
  // mislead a caller that replayed an already-empty board.
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
        `[added] ${STATUS_GLYPH[task.status]} ${taskLine(task, true)}`,
      );
    }
  }
  return `TowerDo board revision ${view.revision} (${view.tasks.length} task(s)) by ${caller}:\n${lines.join("\n")}`;
}

function ensureKnown(
  view: TowerBoardView,
  recipient: string,
  /** Identities from recent board activity (see knownIdentities). */
  activity = new Set<string>(),
): void {
  // "all" broadcasts; the orchestrator identity is always addressable.
  if (recipient === "all" || recipient === TOWER_IDENTITY) return;
  const known = new Set([
    ...view.tasks
      .filter((task) => task.owner !== undefined)
      .map((task) => task.owner),
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

  // Git dirty/session counts for the widget header. Populated asynchronously
  // (session_start snapshot + agent_settled refresh); render stays sync and
  // only reads this cache. "disabled" means cwd is not a git worktree — the
  // segment stays hidden instead of erroring.
  type LiveGitCounts = {
    disabled: false;
    root: string; // git toplevel; porcelain paths are relative to this
    startHashes: Map<string, string> | undefined; // undefined = baseline hashing failed/paused; dirty-only display
    lastHead: string | undefined; // attribution window start; the empty tree when unborn; undefined only while paused
    lastDirty: Set<string>;
    touched: Set<string>;
    dirty: number;
    session: number;
  };
  /** A live state with a usable content baseline and attribution window. */
  const isSeeded = (
    counts: LiveGitCounts | undefined,
  ): counts is LiveGitCounts & {
    startHashes: Map<string, string>;
    lastHead: string;
  } =>
    counts !== undefined &&
    counts.startHashes !== undefined &&
    counts.lastHead !== undefined;
  let gitCounts: { disabled: true } | LiveGitCounts | undefined;
  // Captured by the widget factory so async refreshes can force a repaint —
  // render() is only invoked on TUI-driven redraws otherwise.
  let widgetTui: TUI | undefined;
  // Live-session count for the widget header: distinct identities fresh in
  // the per-session liveness sidecar (live/<session>.json, heartbeat-driven),
  // plus this session (see liveSessionCount). Kept fresh by fs.watch (peer
  // enter/exit/write) and agent_settled; render stays sync and only reads
  // this cache. Undefined until the first refresh lands.
  let liveSessions: { count: number } | undefined;
  // Liveness sidecar wiring — session-scoped, all (re)set in restore() and
  // torn down in session_shutdown.
  let liveHeartbeat: ReturnType<typeof setInterval> | undefined;
  let liveWatchers: FSWatcher[] = [];
  let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Set when a watcher event asked for a board re-fold during the debounce
  // window (OR-merged across sources); cleared when the refresh runs.
  let liveRefreshNeedsFold = false;
  // Owner labels this session has written as (`as`). Session-scoped, like
  // the single sidecar file the session owns (selfLivePath is fixed once
  // live wiring starts).
  const liveAliases = new Set<string>();
  // This session's liveness file path — computed ONCE in restore(). The
  // empty-session-id fallback is a fresh random UUID and identity can change
  // mid-session, so recomputing per call would churn the filename every
  // heartbeat and strand the record past clean exit.
  let selfLivePath: string | undefined;
  // Sequence token guarding refreshGitCounts write-backs (see above).
  let gitRefreshSeq = 0;

  const git = (cwd: string, args: string[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => resolve(error === null ? stdout : undefined),
      );
    });

  const gitStdin = (
    cwd: string,
    args: string[],
    stdin: string,
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      const child = execFile(
        "git",
        args,
        { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => resolve(error === null ? stdout : undefined),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    });

  // git's canonical empty tree — startHead stand-in for an unborn HEAD.
  const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  // Hashing cost must stay bounded: the widget refreshes after every settled
  // agent run, so a huge untracked tree must not be stat'ed + hashed each
  // time. Past the cap the session viewpoint pauses (keeps its last count)
  // while dirty stays correct.
  const MAX_HASHED_PATHS = 2000;

  // `git hash-object --stdin-paths` splits stdin on newlines and C-unquotes
  // lines starting with `"` — encode such paths so they survive round-trip.
  const hashStdinLine = (path: string): string =>
    path.startsWith('"')
      ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : path;

  const hashPaths = async (
    root: string,
    paths: string[],
  ): Promise<Map<string, string> | undefined> => {
    const hashes = new Map<string, string>();
    if (paths.length > MAX_HASHED_PATHS) return undefined;
    const files: string[] = [];
    const lines: string[] = [];
    for (const path of paths) {
      try {
        if (statSync(join(root, path)).isFile()) {
          if (path.includes("\n")) {
            // cannot cross the line-based stdin-paths protocol; baseline and
            // current both see ABSENT, so it just never counts
            hashes.set(path, ABSENT_HASH);
          } else {
            files.push(path);
            lines.push(hashStdinLine(path));
          }
        } else {
          hashes.set(path, ABSENT_HASH);
        }
      } catch {
        hashes.set(path, ABSENT_HASH);
      }
    }
    if (files.length === 0) return hashes;
    const out = await gitStdin(
      root,
      ["hash-object", "--stdin-paths"],
      `${lines.join("\n")}\n`,
    );
    if (out === undefined) return undefined;
    const zipped = zipHashObject(files, out);
    if (zipped === undefined) return undefined;
    for (const [path, hash] of zipped) hashes.set(path, hash);
    return hashes;
  };

  /** HEAD blob names for committed paths; a missing blob becomes ABSENT. */
  const headBlobHashes = async (
    root: string,
    paths: string[],
  ): Promise<Map<string, string> | undefined> => {
    const hashes = new Map<string, string>();
    const send: string[] = [];
    for (const path of paths) {
      if (path.includes("\n")) hashes.set(path, ABSENT_HASH);
      else send.push(path);
    }
    if (send.length === 0) return hashes;
    const out = await gitStdin(
      root,
      ["cat-file", "--batch-check=%(objectname)"],
      `${send.map((path) => `HEAD:${path}`).join("\n")}\n`,
    );
    if (out === undefined) return undefined;
    const lines = out === "" ? [] : out.replace(/\n$/, "").split("\n");
    if (lines.length !== send.length) return undefined;
    for (let i = 0; i < send.length; i++) {
      // missing entries echo "<request> missing" instead of an object name
      hashes.set(
        send[i],
        lines[i].startsWith("HEAD:") ? ABSENT_HASH : lines[i],
      );
    }
    return hashes;
  };

  const writeLive = (
    root: string,
    startHashes: Map<string, string>,
    lastHead: string,
    lastDirty: Set<string>,
    touched: Set<string>,
    dirty: number,
  ): void => {
    gitCounts = {
      disabled: false,
      root,
      startHashes,
      lastHead,
      lastDirty,
      touched,
      dirty,
      session: touched.size,
    };
  };

  const headMovedExternally = async (
    root: string,
    from: string,
    to: string,
  ): Promise<boolean> => {
    // Non-ancestor move (diverged pull / rebase / branch switch) first: when
    // `from` is not an ancestor of `to`, nothing in from..to is this
    // session's own forward progress. A small *diverged* switch (no merge,
    // few commits) has no merge/count signal — only ancestry exposes it.
    // `git merge-base --is-ancestor` exits 1 (not an ancestor) without
    // stdout, so our git() wrapper yields undefined → external (re-anchor),
    // as does a real git error. A *descendant* branch switch (from is an
    // ancestor) with few commits is the accepted blind spot — same signal
    // profile as a fast-forward pull, and ref-tracking would mislabel a
    // session-created branch as external.
    //
    // Unborn baseline: `from` is the empty tree, not a commit.
    // `merge-base --is-ancestor` exits 128 and would drop this session's
    // first commit from `mine`. Skip ancestry only; merge/count still
    // distinguish a large pull into a fresh repo from a single first commit.
    if (from !== EMPTY_TREE_HASH) {
      const ancestor = await git(root, [
        "merge-base",
        "--is-ancestor",
        from,
        to,
      ]);
      if (ancestor === undefined) return true;
    }
    const merges = await git(root, [
      "rev-list",
      "--merges",
      "--count",
      `${from}..${to}`,
    ]);
    if (merges === undefined) return true;
    const count = await git(root, ["rev-list", "--count", `${from}..${to}`]);
    if (count === undefined) return true;
    return headMoveIsExternal({
      ancestor: true, // ancestry succeeded, or from is the empty tree
      merges: Number.parseInt(merges.trim(), 10),
      commits: Number.parseInt(count.trim(), 10),
    });
  };

  /** First observation (or re-seed after a paused state): hash the dirty
   * worktree, freeze the attribution window at the current HEAD (unborn →
   * the empty tree). On hash failure/cap keep the dirty count visible and
   * retry the baseline on a later refresh. */
  const seedGitCounts = async (
    root: string,
    seq: number,
    dirtyPaths: string[],
    existing?: LiveGitCounts,
  ): Promise<void> => {
    const currentHashes = await hashPaths(root, dirtyPaths);
    if (seq !== gitRefreshSeq) return;
    if (currentHashes === undefined) {
      if (existing === undefined) {
        gitCounts = {
          disabled: false,
          root,
          startHashes: undefined,
          lastHead: undefined,
          lastDirty: new Set(dirtyPaths),
          touched: new Set(),
          dirty: dirtyPaths.length,
          session: 0,
        };
      } else {
        gitCounts = { ...existing, dirty: dirtyPaths.length };
      }
      return;
    }
    const lastHead =
      (await git(root, ["rev-parse", "--verify", "HEAD"]))?.trim() ??
      EMPTY_TREE_HASH;
    if (seq !== gitRefreshSeq) return;
    writeLive(
      root,
      currentHashes,
      lastHead,
      new Set(dirtyPaths),
      new Set(),
      dirtyPaths.length,
    );
  };

  const refreshGitCounts = async (cwd: string): Promise<void> => {
    if (gitCounts?.disabled) return;
    const seq = ++gitRefreshSeq;
    const existing =
      gitCounts === undefined || gitCounts.disabled ? undefined : gitCounts;
    const root =
      existing?.root ??
      (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
    if (seq !== gitRefreshSeq) return;
    if (!root) {
      // Transient failure — retry on the next refresh; only a non-worktree
      // cwd disables the segment.
      const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (seq !== gitRefreshSeq) return;
      if (inside?.trim() !== "true") gitCounts = { disabled: true };
      return;
    }
    // Run from the toplevel so paths are root-relative regardless of the
    // status.relativePaths config; -z keeps raw path bytes (no C-quoting) and
    // -uall expands untracked directories to file granularity.
    const porcelain = await git(root, ["status", "--porcelain", "-z", "-uall"]);
    if (seq !== gitRefreshSeq) return;
    if (porcelain === undefined) {
      if (existing !== undefined) return;
      const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
      if (seq !== gitRefreshSeq) return;
      if (inside?.trim() !== "true") gitCounts = { disabled: true };
      return;
    }
    const { changed, untracked } = parsePorcelain(porcelain);
    const dirtyPaths = [...changed, ...untracked];
    if (!isSeeded(existing)) {
      await seedGitCounts(root, seq, dirtyPaths, existing);
      return;
    }
    await attributeGitCounts(root, seq, existing, dirtyPaths);
  };

  /** Steady state: fold worktree hash deltas and the commit window
   * lastHead..HEAD into the persistent touched set. */
  const attributeGitCounts = async (
    root: string,
    seq: number,
    existing: LiveGitCounts & {
      startHashes: Map<string, string>;
      lastHead: string;
    },
    dirtyPaths: string[],
  ): Promise<void> => {
    const currentSet = new Set(dirtyPaths);
    const currentHashes = await hashPaths(root, dirtyPaths);
    if (seq !== gitRefreshSeq) return;
    if (currentHashes === undefined) {
      gitCounts = { ...existing, dirty: dirtyPaths.length };
      return;
    }
    const left = [...existing.lastDirty].filter(
      (path) => !currentSet.has(path),
    );
    const leftHashes =
      left.length === 0
        ? new Map<string, string>()
        : await hashPaths(root, left);
    if (seq !== gitRefreshSeq) return;
    if (leftHashes === undefined) {
      gitCounts = { ...existing, dirty: dirtyPaths.length };
      return;
    }
    // Fold commits since the last refresh: catches content changed *and*
    // committed between two refreshes (never visible in lastDirty).
    const head = (await git(root, ["rev-parse", "--verify", "HEAD"]))?.trim();
    if (seq !== gitRefreshSeq) return;
    const window = await commitWindow(root, existing.lastHead, head);
    if (seq !== gitRefreshSeq) return;
    if (window === undefined) {
      gitCounts = { ...existing, dirty: dirtyPaths.length };
      return;
    }
    // Worktree hashes for paths that left the dirty set (deleted, or
    // committed and untouched since) join the HEAD roster.
    for (const [path, hash] of leftHashes) {
      if (!window.hashes.has(path)) window.hashes.set(path, hash);
    }
    const touched = new Set(existing.touched);
    for (const path of sessionTouchedDelta(
      currentHashes,
      existing.startHashes,
      window.hashes,
    )) {
      touched.add(path);
    }
    writeLive(
      root,
      existing.startHashes,
      window.head,
      currentSet,
      touched,
      dirtyPaths.length,
    );
  };

  /** Resolve the roster of commits since the last refresh. External HEAD
   * movement (pull / rebase / branch switch) re-anchors the window instead
   * of folding foreign work into sess. */
  const commitWindow = async (
    root: string,
    lastHead: string,
    head: string | undefined,
  ): Promise<{ hashes: Map<string, string>; head: string } | undefined> => {
    if (head === undefined || head === lastHead) {
      return { hashes: new Map(), head: lastHead };
    }
    if (await headMovedExternally(root, lastHead, head)) {
      return { hashes: new Map(), head };
    }
    const diffOut = await git(root, [
      "diff",
      "--name-only",
      "-z",
      lastHead,
      head,
    ]);
    if (diffOut === undefined) return undefined;
    const hashes = await headBlobHashes(root, parseDiffNames(diffOut));
    if (hashes === undefined) return undefined;
    return { hashes, head };
  };

  /** Reset the git viewpoint (new session / shutdown); supersedes in-flight refreshes. */
  const resetGitCounts = (): void => {
    gitRefreshSeq += 1;
    gitCounts = undefined;
    // Same lifecycle as the git viewpoint: a stale count from the previous
    // session must not outlive the restore that recomputes it.
    liveSessions = undefined;
  };

  // --- Liveness sidecar (per-session files + heartbeat + fs.watch) ---------
  //
  // Liveness is a different signal from board activity ("process running"
  // vs "touched the board"), so it lives in its own channel: each session
  // owns exactly one file `~/.pi/tower-do/<project>/live/<identity>.<sessionId>.json`
  // rewritten on a heartbeat cadence and deleted on clean exit. Own-file
  // writes never contend cross-process; exit is a delete, a crash expires
  // via LIVE_WINDOW_MS. fs.watch makes peer enter/exit/write visible within
  // one debounce tick instead of at our next settle.

  const liveDirFor = (cwd: string): string =>
    join(dirname(boards.entryFor(cwd).board.file), "live");

  /** Filename-safe component (identities/session ids are human-chosen). */
  const sanitizeLiveName = (s: string): string =>
    s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "x";

  const selfSessionId = (ctx?: ExtensionContext): string => {
    const manager = ctx?.sessionManager ?? lastContext?.sessionManager;
    // Call the method BOUND to the manager: extracting it into a local first
    // (unbound call) makes `this` undefined inside pi's SessionManager and
    // crashes with "undefined is not an object (evaluating 'this.sessionId')".
    const id =
      typeof manager?.getSessionId === "function"
        ? (manager.getSessionId() ?? "")
        : "";
    return id === "" ? randomUUID().slice(0, 8) : id;
  };

  /** Rewrite this session's liveness record (temp + rename, own file at the
   * stable selfLivePath). Best-effort: a failed write degrades to self-only
   * counting via the liveSessionCount `self` union, never a wrong peer
   * count. Serialized below: the heartbeat and a fresh `as` alias write can
   * be in flight together, and an older snapshot's rename landing last would
   * silently drop the alias — an alive owner could then look stale to the
   * takeover gate. */
  const writeSelfLiveOnce = async (cwd: string): Promise<void> => {
    if (selfLivePath === undefined) return;
    try {
      await mkdir(dirname(selfLivePath), { recursive: true });
      const tmp = `${selfLivePath}.${randomUUID()}.tmp`;
      await writeFile(
        tmp,
        JSON.stringify({
          identity: sessionIdentity(cwd, pi),
          at: Date.now(),
          ...(liveAliases.size > 0 ? { aliases: [...liveAliases] } : {}),
        }),
      );
      await rename(tmp, selfLivePath);
    } catch {
      // Best-effort by design (see above).
    }
  };

  // One promise chain per session: own-file writes never overlap, so the
  // last queued snapshot (the newest alias set) is the one that lands.
  let liveWriteChain: Promise<void> = Promise.resolve();
  const writeSelfLive = (cwd: string): void => {
    liveWriteChain = liveWriteChain
      .then(() => writeSelfLiveOnce(cwd))
      .catch(() => {});
  };

  const rememberLiveAlias = (cwd: string, caller: string): void => {
    const self = sessionIdentity(cwd, pi);
    if (caller === self || caller === "" || caller === "all") return;
    if (liveAliases.has(caller)) return;
    if (liveAliases.size >= MAX_TOWER_DO_TASKS) {
      throw new TowerDoValidationError(
        `as identities this session can remember at most ${String(MAX_TOWER_DO_TASKS)} aliases for liveness (got "${caller}")`,
      );
    }
    liveAliases.add(caller);
    writeSelfLive(cwd);
  };

  /** Live-session count from the liveness sidecar: distinct identities with
   * a record no older than LIVE_WINDOW_MS, plus this session. Boardless
   * directories have nothing to be live about — the segment stays hidden
   * there instead of showing a meaningless `live 1` everywhere. */
  const refreshLiveSessions = async (cwd: string): Promise<void> => {
    const boardEntry = boards.entryFor(cwd);
    if (!existsSync(boardEntry.board.file)) {
      liveSessions = undefined;
      return;
    }
    const records: LiveRecord[] = [];
    try {
      const dir = liveDirFor(cwd);
      const now = Date.now();
      for (const name of await readdir(dir)) {
        // Only .json counts: skips .tmp rename intermediates of peers.
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const record = parseLiveRecord(await readFile(path, "utf8"));
          if (record === undefined) continue;
          if (record.at < now - LIVE_PRUNE_MS) {
            // Crashed-session residue. Unlink far beyond the window so a
            // slow heartbeat or modest clock skew cannot prune a live peer;
            // never our own file.
            if (path !== selfLivePath) void unlink(path).catch(() => {});
            continue;
          }
          records.push(record);
        } catch {
          // Unreadable file: skip it.
        }
      }
    } catch {
      // No live dir yet (first session in this project): only self.
    }
    // Restore may have switched projects while this refresh was in flight;
    // a stale count from another board must not land.
    if (activeCwd !== cwd) return;
    liveSessions = {
      count: liveSessionCount(records, sessionIdentity(cwd, pi), Date.now()),
    };
  };

  const stopLiveWatchers = (): void => {
    if (liveRefreshTimer !== undefined) {
      clearTimeout(liveRefreshTimer);
      liveRefreshTimer = undefined;
    }
    if (liveHeartbeat !== undefined) {
      clearInterval(liveHeartbeat);
      liveHeartbeat = undefined;
    }
    for (const watcher of liveWatchers) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    liveWatchers = [];
    liveRefreshNeedsFold = false;
    selfLivePath = undefined;
  };

  /** Coalesce fs.watch bursts into one refresh. `foldBoard` requests a
   * board re-fold (peer task writes); live-dir events (heartbeats, peer
   * enter/exit) only refresh the count — folding a growing board on every
   * 30s heartbeat of every peer would be pure churn. */
  const scheduleLiveRefresh = (foldBoard: boolean): void => {
    if (foldBoard) liveRefreshNeedsFold = true;
    if (liveRefreshTimer !== undefined) return;
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = undefined;
      const needsFold = liveRefreshNeedsFold;
      liveRefreshNeedsFold = false;
      if (activeCwd === undefined) return;
      void (async () => {
        const entry = boards.entryFor(activeCwd);
        if (needsFold && existsSync(entry.board.file)) {
          try {
            currentView = await foldRetained(activeCwd);
          } catch {
            // Display cache only: keep the previous view on a failed fold.
          }
        }
        await refreshLiveSessions(activeCwd);
        updateWidget();
        widgetTui?.requestRender();
      })();
    }, 250);
  };

  const startLiveWatchers = (cwd: string): void => {
    const towerDir = dirname(boards.entryFor(cwd).board.file);
    const watchDir = (
      target: string,
      foldBoard: boolean,
      filter?: (name: string) => boolean,
    ): void => {
      try {
        const watcher = watch(target, (_event, filename) => {
          const name = filename === null ? undefined : filename.toString();
          if (name !== undefined && filter && !filter(name)) return;
          scheduleLiveRefresh(foldBoard);
        });
        watcher.on("error", () => {
          // Best-effort: a failed watcher falls back to the old
          // settle-driven refresh cadence.
          try {
            watcher.close();
          } catch {
            // Already closed.
          }
        });
        liveWatchers.push(watcher);
      } catch {
        // Missing dir (first session) or unsupported platform: same fallback.
      }
    };
    watchDir(liveDirFor(cwd), false);
    watchDir(towerDir, true, (name) => name === "board.jsonl");
  };

  const startLiveHeartbeat = (cwd: string): void => {
    writeSelfLive(cwd);
    if (liveHeartbeat !== undefined) clearInterval(liveHeartbeat);
    liveHeartbeat = setInterval(() => {
      if (activeCwd === undefined) return;
      writeSelfLive(activeCwd);
    }, LIVE_HEARTBEAT_MS);
    liveHeartbeat.unref?.();
  };

  /** Set up the session-scoped liveness wiring once, and only against a
   * board that exists: without a board there is no live segment, and
   * heartbeat files would pollute non-tower projects. Re-invoked from
   * agent_settled so a board created mid-session (first tower_do call in a
   * fresh project) still joins the live channel. */
  const startLiveWiring = (cwd: string, ctx?: ExtensionContext): void => {
    if (selfLivePath !== undefined) return;
    if (!existsSync(boards.entryFor(cwd).board.file)) return;
    selfLivePath = join(
      liveDirFor(cwd),
      `${sanitizeLiveName(sessionIdentity(cwd, pi))}.${sanitizeLiveName(selfSessionId(ctx))}.json`,
    );
    // The live dir must exist before watch(): the first session in a project
    // would otherwise miss its watcher forever (ENOENT swallowed, never
    // retried). Not writable: skip the whole channel (best-effort liveness —
    // peers still count us via the liveSessionCount self union).
    try {
      mkdirSync(liveDirFor(cwd), { recursive: true });
    } catch {
      selfLivePath = undefined;
      return;
    }
    startLiveHeartbeat(cwd);
    startLiveWatchers(cwd);
  };

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
    // The widget survives an empty board: the git and live segments are
    // independent of board content and should stay visible. Only when there
    // is nothing to render in any segment is there no widget at all.
    // Gate every segment on its rendered string, not data availability: a
    // completed-only board or a clean repo both yield an empty string and
    // would otherwise register a permanently blank widget.
    const tasks = getAllTasks(currentView);
    const unfinished = tasks.filter((task) => task.status !== "completed");
    const blocked = unfinished.filter((task) =>
      taskIsBlocked(task, currentView),
    );
    const unread = unreadMessagesToMe(
      currentView,
      sessionIdentity(activeCwd, pi),
    ).length;
    const boardSegment = formatBoardProgress(
      unfinished.length,
      blocked.length,
      unread,
    );
    const gitSegment =
      gitCounts !== undefined && !gitCounts.disabled
        ? formatGitSegment(gitCounts.dirty, gitCounts.session)
        : "";
    const liveSegment =
      liveSessions === undefined ? "" : formatLiveSegment(liveSessions.count);
    if (boardSegment === "" && gitSegment === "" && liveSegment === "") {
      clearWidget();
      return;
    }
    if (!widgetRegistered) {
      widgetRegistered = true;
      uiContext.ui.setWidget(
        WIDGET_KEY,
        (tui: TUI, theme: Theme) => {
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
              const gitSegment =
                gitCounts !== undefined && !gitCounts.disabled
                  ? formatGitSegment(
                      gitCounts.dirty,
                      gitCounts.session,
                      (n, which) =>
                        theme.fg(
                          which === "dirty" ? "warning" : "accent",
                          theme.bold(String(n)),
                        ),
                      (s) => theme.fg("dim", s),
                    )
                  : "";
              const liveSegment =
                liveSessions === undefined
                  ? ""
                  : formatLiveSegment(
                      liveSessions.count,
                      (n) => theme.fg("success", theme.bold(String(n))),
                      (s) => theme.fg("dim", s),
                    );
              const identity = sessionIdentity(activeCwd, pi);
              const inboxForMe = unreadMessagesToMe(
                currentView,
                identity,
              ).length;
              // Progress counts remaining work only: completed rows (often
              // pinned by the owner guard / dependsOn) never appear in the
              // glance, and neither does the monotonic CAS revision.
              let header = formatBoardProgress(
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
              if (liveSegment !== "") {
                header +=
                  (header === "" ? "" : theme.fg("dim", " │ ")) + liveSegment;
              }
              if (gitSegment !== "") {
                header +=
                  (header === "" ? "" : theme.fg("dim", " │ ")) + gitSegment;
              }
              const lines = [header];
              // WIDGET_TASK_LIMIT caps how many unfinished tasks the
              // above-editor line shows; the rest fold into an overflow note.
              // Rows are mine-first so the cap does not hide the caller's
              // work behind older peer/unowned tasks. Counts stay board-wide.
              const cap =
                activeCwd === undefined ? unfinished.length : WIDGET_TASK_LIMIT;
              const shown = orderTasksMineFirst(unfinished, identity).slice(
                0,
                cap,
              );
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
              if (unfinished.length > shown.length) {
                lines.push(
                  theme.fg(
                    "dim",
                    `… +${unfinished.length - shown.length} more`,
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
        },
        { placement: "aboveEditor" },
      );
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
    rememberLiveAlias(ctx.cwd, caller);
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
- Full replacement at the task level: include every key to keep; any current key omitted from the list is removed (an omitted task owned by another agent is rejected instead of dropped — replay peers' and unowned tasks you did not mean to lose). Fields are per-field: omitted optional fields on an existing key are preserved, and new keys require subject and status.
- Owner guard: a task with an owner can only be changed (any field) or removed by its owner or the "tower" identity. Exception: an owner idle for 30+ min (OWNER_TAKEOVER_MS) may be displaced on a non-completed task — adopt it by setting owner to yourself and changing nothing else in that write (any content edit in the same write is rejected; re-plan in a second write), or remove it; completed tasks stay guarded.
- Dependencies gate status: in_progress/completed require every dependsOn entry to be completed, dependsOn keys must exist on the board or in this call, and cycles are rejected (blocked is exempt).
- Set changedFiles only in the same write that completes a task; reopening a task without changedFiles voids the inherited receipt.
- Always pass baseRevision from tower_do_status; omitting it disables the stale-write check.
- Up to ${MAX_TOWER_DO_TASKS} tasks. Optional per-task fields: dependsOn (see above), scope (file globs the task may touch), blockedBy (free-form ids — non-empty renders a non-completed task as blocked).`,
    promptSnippet:
      "Maintain the shared multi-agent task board with one atomic update",
    promptGuidelines: [
      "Use tower_do for the task plan instead of direct file edits when multiple agents or sessions share the work; it is the shared board, not a private todo list.",
      "tower_do replaces the entire task list: read tower_do_status first and replay every key you want to keep, changing only the tasks you mean to change.",
      "When a task needs a plan of 3+ steps, define it yourself and call tower_do with subject + status before beginning substantive work.",
      "Include baseRevision (from tower_do_status) in every tower_do call; a stale revision is rejected so you never silently overwrite a peer's update.",
      "Mark a task completed only after implementation and verification succeed, attaching changedFiles (files you actually changed, repo-relative) in the same call. Use status blocked with a blockedBy note instead of leaving it hanging.",
      "Claim shared tasks by setting owner and in_progress together. Only the owner or the orchestrator identity tower may change an owned task's fields or remove it — to remove or reassign another agent's task, message the owner via tower_do_talk instead of editing it directly. If a task's owner has been idle for 30+ minutes, you may adopt it (set owner to yourself and change nothing else in that write) or remove it while it is not completed; completed tasks stay with their owner.",
      "Reconcile actual progress with the shared board before your final response, and do not issue a no-op tower_do call only to acknowledge a reminder.",
    ],
    parameters: TowerDoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo update");
      const { board, caller } = await prepare(ctx, params.as);
      return withFileMutationQueue(board.file, async () => {
        // Re-fold INSIDE the mutation queue: the revision guard and diff must
        // see the freshest events, or a same-process call that appended
        // between prepare() and the queue would be silently clobbered.
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
          // Unreadable log → empty activity, which `staleTaskOwners` maps to
          // "no stale owners" (strict guard); the write must still land.
        }
        // Liveness tiebreaker: an owner whose process still heartbeats is
        // never stale, however quiet on the board. Read failure → treat
        // EVERY owner as live (strict guard), mirroring the activity read
        // above. Cheap local scan — refreshLiveSessions owns the widget's
        // count, not the identities this gate needs.
        let liveOwners = new Set(
          freshView.tasks
            .map((task) => task.owner)
            .filter((owner): owner is string => owner !== undefined),
        );
        try {
          const nowMs = Date.now();
          const parsed = new Set<string>();
          const dir = liveDirFor(ctx.cwd);
          for (const name of await readdir(dir)) {
            // Only .json counts: skips .tmp rename intermediates of peers.
            if (!name.endsWith(".json")) continue;
            const record = parseLiveRecord(
              await readFile(join(dir, name), "utf8"),
            );
            if (record !== undefined && record.at >= nowMs - LIVE_WINDOW_MS) {
              for (const id of liveOwnerIdentities(record)) parsed.add(id);
            }
          }
          // Assign only after the ENTIRE scan succeeded: a mid-scan failure
          // (peer exit race, permission error) must keep the all-owners set —
          // a partial set would loosen the guard exactly when data is broken.
          liveOwners = parsed;
        } catch {
          // No/unreadable live dir → no liveness data → no takeover.
        }
        // An empty activity list (unreadable / empty log) already means "no
        // stale owners" inside the derivation — strict guard, never loosened.
        const staleOwners = staleTaskOwners(
          activity,
          freshView.tasks,
          Date.now(),
          undefined,
          liveOwners,
        );
        const details = writeBoardSnapshot(
          freshView,
          { tasks: params.tasks, baseRevision: params.baseRevision },
          caller,
          staleOwners,
        );
        throwIfAborted(signal, "TowerDo update");
        await board.append(details.taskEvents);
        currentView = cloneBoard(details.view);
        llmCallsSinceReminder = 0;
        updateWidget(ctx);
        // Presence footnote: surface owners who own unfinished tasks but have
        // no recent activity, so a coordinator sees who may be stalled. The
        // Same parsed activity as the takeover check above — full history
        // makes the idle mark strictly more accurate than the old 200-line
        // tail.
        const now = Date.now();
        const presence = derivePresence(activity, details.view.tasks, now);
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
                )} — message them (tower_do_talk), adopt their task via tower_do (set owner to yourself, 30+ min idle), or re-claim via tower`;
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
        // `as` overrides the session identity for this call; trimmed to
        // match resolveCaller on the execute side.
        const asArg = typeof args.as === "string" ? args.as.trim() : "";
        const acting = asArg || sessionIdentity(activeCwd, pi);
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
  // tower_do_talk — addressed messages + structured findings
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TALK_TOOL_NAME,
    label: "TowerDo Talk",
    description:
      'Cross-agent communication on the shared tower-do board. action=send delivers an inbox message to "all", the orchestrator identity "tower", a current task owner, or anyone with recent board activity (self-send rejected); taskKey optionally threads it under a task. action=inbox lists messages addressed to you or "all", newest first, and ACKS the ones it shows (marks them read; acked messages can be retired) — use tower_do_status to read messages without acking. action=finding files a structured out-of-scope finding (bug|improve|vuln|idea) with severity/location/suggestedFix, or updates a finding\'s status via findingId + status. Use findings instead of silently editing other-owned tasks.',
    promptSnippet:
      "Send addressed messages or file findings on the shared multi-agent board",
    promptGuidelines: [
      'Use tower_do_talk to communicate with task owners on the shared board instead of editing owned tasks directly; the recipient must be "all", "tower", a current task owner, or someone with recent board activity (e.g. a peer whose tasks are all completed).',
      "Use action=finding (not direct edits) when you discover an out-of-scope problem — file it with kind/severity/summary/suggestedFix so the owning agent and reviewers can route it.",
      "Keep message bodies brief and reference files by path; the board persists everything, so pointer-style notes keep context lean.",
      "Prefer tower_do_status over action=inbox when you only need to read messages: inbox acknowledges what it shows, status does not.",
    ],
    parameters: TalkParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo talk");
      const { board, caller, view } = await prepare(ctx, params.as);
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
          throwIfAborted(signal, "TowerDo talk");
          const fresh = await foldRetained(ctx.cwd);
          throwIfAborted(signal, "TowerDo talk");
          // Reachable recipients: current owners PLUS anyone with recent board
          // activity — a peer whose tasks are all completed is no longer an
          // owner but exactly who hand-off coordination needs to reach.
          let recentActivity = new Set<string>();
          try {
            const raw = await board.rawTail(200);
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
          throwIfAborted(signal, "TowerDo talk");
          const fresh = await foldRetained(ctx.cwd);
          throwIfAborted(signal, "TowerDo talk");
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
            throwIfAborted(signal, "TowerDo talk");
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
          throwIfAborted(signal, "TowerDo talk");
          // Re-fold inside the queue: the finding may have changed since the
          // pre-queue fold in prepare().
          const fresh = await foldRetained(ctx.cwd);
          throwIfAborted(signal, "TowerDo talk");
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
          throwIfAborted(signal, "TowerDo talk");
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
        throwIfAborted(signal, "TowerDo talk");
        const fresh = await foldRetained(ctx.cwd);
        throwIfAborted(signal, "TowerDo talk");
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
    description: `Read the shared tower-do board: everyone's tasks (owner, status, deps, scope, blocks), messages addressed to you, open findings, and the recent activity tail. Also prints the board file path and the current revision (pass it back as baseRevision) so subagents can read state directly (file-as-state). Reading here does NOT ack messages (tower_do_talk action=inbox does). Pass taskKey to get the FULL detail of one task instead. Output is truncated to ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB.`,
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
                (params.status === undefined ||
                  displayStatus(task) === params.status),
            )
          : tasks;
      const limit = params.limit ?? 200;
      // Slice is still fold order (default 200 never binds below
      // MAX_TOWER_DO_TASKS). Mine-first runs per status group on that
      // already-sliced list — it must not steal the global limit budget.
      const shown = filtered.slice(0, limit);

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
        if (task.scope !== undefined && task.scope.length > 0) {
          detail.push(`- scope: ${task.scope.join(", ")}`);
        }
        if (task.changedFiles !== undefined && task.changedFiles.length > 0) {
          detail.push(`- changedFiles: ${task.changedFiles.join(", ")}`);
        }
        if (task.description === undefined) {
          detail.push("- description: (none)");
        } else {
          detail.push("- description:");
          for (const row of task.description.split("\n")) {
            detail.push(`  ${row}`);
          }
        }
        const detailText = detail.join("\n");
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
      // D4: board liveness at a glance. revision is monotonic but silent —
      // a coordinator needs to know how stale the board is and who last
      // moved it (pure read derivation from the activity tail, zero writes).
      const updated =
        lastWrite === undefined
          ? "no board writes yet"
          : `last updated ${relativeTime(now, lastWrite.at)} by ${lastWrite.by}`;
      lines.push(`Activity: ${updated}`);
      lines.push(
        `Tasks: ${tasks.length} total (${inProgressCount} in_progress, ${blockedCount} blocked, ${pendingCount} pending, ${completedCount} completed)`,
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
        // Marker hugs the identity: "←" already means "depends on" on task
        // lines, so keep a single meaning per symbol.
        const label =
          person.identity === caller
            ? `${person.identity} (me)`
            : person.identity;
        lines.push(
          `- ${formatPresenceLine({ ...person, identity: label }, now)}`,
        );
      }
      if (historicalCount > 0) {
        lines.push(`- … ${historicalCount} more with only historical activity`);
      }
      lines.push("");

      const renderGroup = (
        label: string,
        pick: (task: TowerDoTask) => boolean,
      ): void => {
        const group = orderTasksMineFirst(shown.filter(pick), caller);
        if (group.length === 0) return;
        lines.push(`## ${label}`);
        for (const task of group) {
          const owner =
            task.owner === undefined
              ? ""
              : ` @${task.owner}${task.owner === caller ? " (me)" : ""}`;
          const deps = task.dependsOn.length
            ? ` ← ${task.dependsOn.join(",")}`
            : "";
          const scope = task.scope?.length
            ? ` [scope: ${task.scope.join(", ")}]`
            : "";
          const blocked = taskIsBlocked(task, view);
          // Same contract as the board reminder: the marker must carry the
          // WHY (blockedBy ∪ unresolved deps), never a bare duplicate of the
          // status glyph. Completed rows never show waiting reasons.
          const blockers =
            task.status === "completed"
              ? []
              : [
                  ...new Set([
                    ...task.blockedBy,
                    ...findAllUnresolvedDeps(task, view),
                  ]),
                ];
          const blockedSuffix = blocked
            ? blockers.length > 0
              ? ` [blocked by: ${blockers.join(",")}]`
              : " [blocked]"
            : "";
          lines.push(
            `- ${STATUS_GLYPH[task.status]} ${task.key}: ${task.subject}${owner}${deps}${scope}${changedFilesSuffix(task)}${blockedSuffix}`,
          );
        }
        lines.push("");
      };
      renderGroup("Blocked", (task) => displayStatus(task) === "blocked");
      renderGroup(
        "In progress",
        (task) => displayStatus(task) === "in_progress",
      );
      renderGroup("Pending", (task) => displayStatus(task) === "pending");
      renderGroup("Completed", (task) => displayStatus(task) === "completed");

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
          `- [${message.id}] [${readMark}] ${message.from} → me${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject} — ${message.body.split("\n")[0]}`,
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
      const output = toolResultText(result);
      if (!output) {
        if (result.details) text.setText("");
        return text;
      }
      const lines = output.split("\n");
      const keep = expanded ? lines.length : Math.min(lines.length, 14);
      // Caller-owned lines stand out: accent + bold vs plain toolOutput. The
      // execute side already resolved the caller; prefer it over re-deriving.
      const details = (result.details ?? {}) as Record<string, unknown>;
      const caller =
        typeof details.identity === "string"
          ? details.identity
          : sessionIdentity(activeCwd, pi);
      let rendered = lines
        .slice(0, keep)
        .map((line) =>
          !context.isError && isCallerLine(line, caller)
            ? theme.fg("accent", theme.bold(line))
            : theme.fg(context.isError ? "error" : "toolOutput", line),
        )
        .join("\n");
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
      // Always replace the in-memory view: a previous session's currentView
      // must not leak into this one when the board file is gone. getBranch
      // is root-to-leaf, so take the last valid checkpoint (see
      // latestBoardCheckpoint), not the first.
      const checkpoint = latestBoardCheckpoint(ctx.sessionManager.getBranch());
      currentView =
        checkpoint === undefined
          ? createEmptyBoard()
          : cloneBoard({ ...checkpoint, revision: 0 });
    }
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    uiContext = ctx;
    // New session ⇒ new viewpoint: drop the previous session's counts
    // *before* the first paint so /tree cannot flash a stale git segment.
    // Also restart the liveness sidecar wiring: pi fires session_shutdown
    // for the old instance before session_start/session_tree, but a
    // defensive stop keeps double-restore idempotent.
    stopLiveWatchers();
    resetGitCounts();
    updateWidget(ctx);
    void Promise.all([
      refreshGitCounts(ctx.cwd),
      refreshLiveSessions(ctx.cwd),
    ]).then(() => {
      updateWidget();
      widgetTui?.requestRender();
    });
    // Announce self and stay fresh: the heartbeat makes this session visible
    // to peers regardless of board activity; the watchers make peer
    // enter/exit/write visible to us within one debounce tick. Gated on an
    // existing board — see startLiveWiring.
    startLiveWiring(ctx.cwd, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx);
  });

  // Refresh dirty/session counts after each settled agent run (post-retry,
  // cheaper and steadier than per-turn). TUI mode only — print/RPC never has
  // a widget. Runs even when the widget is not (yet) registered: the git
  // segment must initialize on an empty board too.
  pi.on("agent_settled", async () => {
    // Late wiring: a board created mid-session (first tower_do call) still
    // joins the live channel — cheap no-op once wired.
    if (activeCwd !== undefined) startLiveWiring(activeCwd);
    if (
      uiContext?.mode !== "tui" ||
      !uiContext?.hasUI ||
      activeCwd === undefined
    )
      return;
    // Peer cancels must show up without waiting for a tool call.
    const settledEntry = boards.entryFor(activeCwd);
    if (existsSync(settledEntry.board.file)) {
      currentView = await foldRetained(activeCwd);
    }
    await refreshGitCounts(activeCwd);
    await refreshLiveSessions(activeCwd);
    updateWidget();
    widgetTui?.requestRender();
  });

  pi.on("context", async (event, ctx) => {
    // Compact / before_agent_start inject TOWER_DO_BOARD_TYPE snapshots that
    // persist in the session transcript. They must not keep cancelled todos
    // in the LLM context after a peer writes; strip and replace from disk.
    const isBoardContext = (message: {
      role?: string;
      customType?: string;
    }): boolean =>
      message.role === "custom" &&
      (message.customType === TOWER_DO_REMINDER_TYPE ||
        message.customType === TOWER_DO_BOARD_TYPE);
    const hadBoardContext = event.messages.some(isBoardContext);
    const messages = event.messages.filter(
      (message) => !isBoardContext(message),
    );
    const cwd = ctx?.cwd ?? activeCwd;
    if (cwd === undefined) {
      return hadBoardContext || messages.length !== event.messages.length
        ? { messages }
        : undefined;
    }
    const contextEntry = boards.entryFor(cwd);
    if (existsSync(contextEntry.board.file)) {
      currentView = await foldRetained(cwd);
    }
    const identity = sessionIdentity(cwd, pi);
    const tasks = getAllTasks(currentView);
    const hasUnfinished = tasks.some((task) => task.status !== "completed");
    const hasInbox = unreadMessagesToMe(currentView, identity).length > 0;
    if (!hasUnfinished && !hasInbox) {
      llmCallsSinceReminder = 0;
      return hadBoardContext || messages.length !== event.messages.length
        ? { messages }
        : undefined;
    }
    if (!hadBoardContext) {
      llmCallsSinceReminder += 1;
      if (llmCallsSinceReminder < REMINDER_INTERVAL) {
        return messages.length === event.messages.length
          ? undefined
          : { messages };
      }
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
    // Fold + checkpoint under the same mutation queue as tower_do so a
    // concurrent cancel cannot land between the snapshot and appendEntry.
    const compactEntry = boards.entryFor(ctx.cwd);
    let snapshot = cloneBoard(currentView);
    if (existsSync(compactEntry.board.file)) {
      await withFileMutationQueue(compactEntry.board.file, async () => {
        currentView = await foldRetained(ctx.cwd);
        snapshot = cloneBoard(currentView);
        pi.appendEntry(TOWER_DO_BOARD_TYPE, snapshot);
      });
    } else {
      pi.appendEntry(TOWER_DO_BOARD_TYPE, snapshot);
    }
    if (event.willRetry || ctx.hasPendingMessages()) {
      contextCheckpointNeeded = false;
      llmCallsSinceReminder = 0;
      pi.sendMessage(
        {
          customType: TOWER_DO_BOARD_TYPE,
          content: formatBoardReminder(snapshot, sessionIdentity(ctx.cwd, pi)),
          display: false,
          details: snapshot,
        },
        { deliverAs: "steer" },
      );
    } else {
      contextCheckpointNeeded = true;
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!contextCheckpointNeeded) return;
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    const cwd = ctx?.cwd ?? activeCwd;
    if (cwd !== undefined) {
      const entry = boards.entryFor(cwd);
      if (existsSync(entry.board.file)) {
        await withFileMutationQueue(entry.board.file, async () => {
          currentView = await foldRetained(cwd);
        });
      }
    }
    return {
      message: {
        customType: TOWER_DO_BOARD_TYPE,
        content: formatBoardReminder(currentView, sessionIdentity(cwd, pi)),
        display: false,
        details: cloneBoard(currentView),
      },
    };
  });

  pi.on("session_shutdown", () => {
    // Exit signal first (delete while selfLivePath is still known), then
    // tear down the session-scoped wiring.
    if (selfLivePath !== undefined) {
      void unlink(selfLivePath).catch(() => {});
    }
    stopLiveWatchers();
    clearWidget();
    uiContext = undefined;
    lastContext = undefined;
    activeCwd = undefined;
    currentView = createEmptyBoard();
    resetGitCounts();
    contextCheckpointNeeded = false;
    llmCallsSinceReminder = 0;
    // Re-resolve project roots next session: the filesystem may have gained
    // or lost a `.git` boundary since this session started (e.g. `git init`
    // mid-session). Within a session the cache is deliberately stable — moving
    // the board file mid-session would orphan earlier events (split-brain).
    projectRootCache.clear();
    liveAliases.clear();
  });
}
