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
 *    messages (recipient must be "all", the orchestrator "tower", a current
 *    task owner, or an identity with recent board activity; self-send rejected)
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
  DEFAULT_MAX_LINES,
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
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";

import {
  normalizeBoardConfig,
  TowerBoard,
  type BoardEvent,
  type TowerDoConfig,
} from "./board.ts";
import {
  ABSENT_HASH,
  formatGitSegment,
  headMoveIsExternal,
  leftDirtyPaths,
  parseDiffNames,
  parsePorcelain,
  sessionTouchedDelta,
  zipHashObject,
} from "./git-count.ts";
import {
  BOARD_COMPACT_HINT_BYTES,
  BOARD_COMPACT_HINT_LINES,
  classifyTaskLayers,
  checkpointDigest,
  cloneBoard,
  createEmptyBoard,
  DASHBOARD_FINDING_LINE_CHARS,
  DASHBOARD_ROW_BUDGET,
  DASHBOARD_SCOPE_CONFLICT_LINES,
  DEFAULT_IDENTITY,
  deriveFindingState,
  derivePresence,
  findAllUnresolvedDeps,
  findingBudgetRejection,
  findingPressureOrder,
  FINDING_CLOSE_GRACE_MS,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  FINDING_SNOOZE_MAX_MS,
  FINDING_STATUSES,
  formatActivityFeed,
  formatBoardProgress,
  formatBoardReminder,
  foldDashboardSections,
  formatDashboardHiddenNote,
  findScopeConflicts,
  formatKeyListLine,
  formatLayerSummary,
  formatLedgerKeyRows,
  formatLedgerRow,
  formatLiveSegment,
  formatOtherKeysLine,
  formatTakeoverWindow,
  formatPresenceLine,
  getAllTasks,
  isCallerLine,
  isTowerDoStatus,
  truncateChars,
  knownIdentities,
  latestActivity,
  latestBoardCheckpoint,
  LIVE_HEARTBEAT_MS,
  LIVE_PRUNE_MS,
  LIVE_WINDOW_MS,
  liveOwnerIdentities,
  liveSessionCount,
  parseLiveRecord,
  MAX_CHANGED_FILES,
  MAX_BOARD_ARCHIVES,
  MAX_FINDING_LOCATION_CHARS,
  MAX_FINDING_REASON_CHARS,
  MAX_FINDING_SUGGESTED_FIX_CHARS,
  MAX_FINDING_SUMMARY_CHARS,
  MAX_FINDING_TITLE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_SCOPE_GLOBS,
  MAX_TASK_BLOCKERS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TASK_KEY_CHARS,
  MAX_TASK_SUBJECT_CHARS,
  MAX_TOWER_DO_ALIASES,
  MAX_TOWER_DO_OPEN_FINDINGS,
  MAX_TOWER_DO_OPEN_TASKS,
  messagesToMe,
  openFindingCount,
  parseActivityLine,
  relativeTime,
  retainFindings,
  retainMessages,
  sliceScopeConflicts,
  sliceTaskDashboard,
  staleTaskClaims,
  findingCountsFor,
  taskIsBlocked,
  identityListHas,
  identitySetHas,
  readByWith,
  sameAgent,
  sessionLabel,
  shouldAutoCompactBoard,
  TASK_KEY_PATTERN,
  textLength,
  transportLimit,
  TOWER_DO_BOARD_DIGEST_TYPE,
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
  type TowerDoCheckpointDigest,
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
// A forced checkpoint (compact steer / before_agent_start) injects its own
// board snapshot, but the context hook strips that snapshot before the LLM
// sees it (it is a persisted custom message). Arm the counter so the next
// context event replaces it immediately; the steady-state cadence resumes
// from there. Without this arming the checkpoint's snapshot never reaches
// the LLM. See DECISIONS.md (reminder cadence vs snapshot strip).
const REMINDER_ARMED = REMINDER_INTERVAL - 1;
const WIDGET_TASK_LIMIT = 3; // unfinished tasks shown in the above-editor line
const STATUS_ACTIVITY_TAIL = 8; // activity feed lines in tower_do_status
/** Rows the dashboard renders per message/finding section. The section headers
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
  if (sessionName) return sessionName;
  const sessionId =
    typeof ctx?.sessionManager.getSessionId === "function"
      ? (ctx.sessionManager.getSessionId() ?? "")
      : "";
  // `sessionLabel` is the one place that maps a session id to a board identity
  // (see its doc: the ≤ 0.4.0 form was pure timestamp and collided for every
  // session started inside one 65.5 s bucket).
  if (sessionId) return sessionLabel(sessionId);
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
// (as/to/message subject/finding fields) keep the business value — the host
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
        `Long-form task description, at most ${MAX_TASK_DESCRIPTION_CHARS} characters; omitted to preserve, empty string to clear. Keep it a durable statement of the task — evidence and logs belong in a tower_do_talk message or finding, not in every task-list write.`,
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
        'Agent/session identity that owns this task. Only the owner or the orchestrator identity "tower" may change its fields (status/owner/scope/changedFiles/subject/description/dependsOn/blockedBy).',
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
  scope: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional file-glob list describing what paths this task may touch (Tower mission scope). Only owner/tower may change it.",
      maxItems: transportLimit(MAX_SCOPE_GLOBS),
    }),
  ),
  changedFiles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Delivery receipt: files the owner actually changed, repo-relative. Only settable when status is "completed" — pass it in the same call that completes the task. Reopening the task (status back to pending/in_progress/blocked) without an explicit changedFiles voids the inherited receipt; changedFiles: [] clears it while staying completed. A worker may set it once; its owner or "tower" may amend later (the owner guard rejects other workers).',
      maxItems: transportLimit(MAX_CHANGED_FILES),
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Free-form blocker ids this task waits on — task, message, or finding ids; not validated against the board. Non-empty renders a non-completed task as blocked (task-status gating goes through dependsOn instead).",
      maxItems: transportLimit(MAX_TASK_BLOCKERS),
    }),
  ),
});

const TowerDoParamsSchema = Type.Object({
  action: Type.Optional(
    StringEnum(["gc"] as const, {
      description:
        'Explicit log compaction (Layer 3). Requires the orchestrator identity "tower" and an empty tasks list. Rewrites board.jsonl as one compact header plus last-wins snapshot events under a content CAS (a concurrent peer append aborts it); the previous log is archived under archive/ after the first content check and before the hard link/final CAS, so an aborted compact leaves no archive. The extension also runs the SAME compact automatically when a board log crosses its size threshold (never periodic); this action compacts now. Unfoldable legacy lines no longer block it because the pre-compact log is archived — the count moved there is reported. Revision is preserved so baseRevision stays valid.',
    }),
  ),
  dropSkipped: Type.Optional(
    Type.Boolean({
      description:
        "gc only: drop log lines the fold cannot turn into events (a legacy row past a retuned limit) instead of refusing. Defaults to true for the gc action because it always archives the verbatim pre-compact log and reports how many lines moved there. Pass false to keep the strict refusal — inspect the raw lines first.",
    }),
  ),
  tasks: Type.Array(TowerDoTaskSchema, {
    description:
      `Complete authoritative task list to retain: every key you want kept must appear here, because any current key omitted from the list is removed. An omitted task owned by another agent (and not stale) makes the write fail rather than dropping it; replay peers' and unowned tasks you did not mean to remove. Existing keys may omit unchanged fields (they are preserved per field), so send only what changes — a rejected payload is echoed back verbatim by the host, and a small replay keeps that echo cheap. New keys require subject and status. Capacity: at most ${MAX_TOWER_DO_OPEN_TASKS} non-completed tasks — completed rows are receipts, they replay free and never block a new plan; one write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} NEW completed rows (replaying an existing receipt is free, split larger batches across successive writes).`,
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
        `Identity to act as (default: your session identity); the call is then owner-guarded as that identity. Pass a subagent id to record work on its behalf. Must be a single line, at most ${MAX_IDENTITY_CHARS} characters, and not the reserved broadcast recipient "all". Identities are self-declared labels (cooperative trust, no authentication), so the reserved "${TOWER_IDENTITY}" label gates compaction by convention, not by verification.`,
      maxLength: MAX_IDENTITY_CHARS,
    }),
  ),
});

const TalkParamsSchema = Type.Object({
  action: StringEnum(["send", "inbox", "finding"] as const, {
    description:
      "send delivers a message (requires to + subject + body); inbox lists AND acknowledges your messages (optional limit; all=true reads view-retired messages too); finding files a structured finding (requires kind + title + summary), updates one or many (findingId or findingIds + status), and requires a reason to close or snooze.",
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
      description: `send: the message body (required for send), max ${Math.round(MAX_MESSAGE_BYTES / 1024)} KiB — split oversized content into multiple messages. Findings use the separate summary/suggestedFix fields, not body.`,
    }),
  ),
  taskKey: Type.Optional(
    Type.String({
      description:
        "send only: task key this message threads under (must exist on the board). Passing it with inbox/finding is an error — findings are board-level and carry no task link.",
      minLength: 1,
      maxLength: MAX_TASK_KEY_CHARS,
      pattern: TASK_KEY_PATTERN.source,
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
      maxLength: MAX_FINDING_LOCATION_CHARS,
    }),
  ),
  suggestedFix: Type.Optional(
    Type.String({
      description: "finding: suggested fix",
      maxLength: MAX_FINDING_SUGGESTED_FIX_CHARS,
    }),
  ),
  findingId: Type.Optional(
    Type.String({
      description:
        "finding: id to update (with status). Mutually exclusive with findingIds.",
    }),
  ),
  findingIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "finding: ids to update in one atomic batch (each appends its own event). Mutually exclusive with findingId; status/reason/snoozeUntil apply to every id.",
      maxItems: transportLimit(MAX_TOWER_DO_OPEN_FINDINGS),
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        "finding: accountability owner. Set together with status=accepted to claim; omitted on a claim defaults to you. A non-tower caller may pass only its OWN identity (only tower may name a different owner); a stale, non-live claim stays adoptable by another agent through status=accepted without owner.",
      maxLength: transportLimit(MAX_IDENTITY_CHARS),
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        `finding: single-line reason. Required for status=done|rejected|snoozed — closing without a reason is the silent-wrong class this board prevents.`,
      maxLength: transportLimit(MAX_FINDING_REASON_CHARS),
    }),
  ),
  snoozeUntil: Type.Optional(
    Type.Integer({
      description:
        `finding: epoch ms when status=snoozed returns to actionable. Must be in the future and at most ${Math.round(FINDING_SNOOZE_MAX_MS / 86_400_000)}d ahead.`,
      minimum: 0,
    }),
  ),
  status: Type.Optional(
    StringEnum(["open", "accepted", "snoozed", "rejected", "done"] as const, {
      description:
        "finding update: new status; requires findingId or findingIds. done|rejected|snoozed require a reason; accepted claims (owner defaults to you); open reopens.",
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
        "When set, return the FULL detail of this single task (description, scope, changedFiles, updatedAt) instead of the whole dashboard; owner/status/limit are ignored in this mode. Error if the key does not exist.",
      minLength: 1,
      maxLength: MAX_TASK_KEY_CHARS,
      pattern: TASK_KEY_PATTERN.source,
    }),
  ),
  findingId: Type.Optional(
    Type.String({
      description:
        "When set, return the FULL text of this single finding (summary + suggestedFix) instead of the dashboard — the list renders at most a truncated first line; takes precedence over taskKey. Error if the id is unknown.",
      minLength: 1,
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
  view: Type.Optional(
    StringEnum(["layers", "mine", "needs", "all"] as const, {
      description:
        "How much of the unfinished board renders as full rows. `layers` (default) renders your own work and the peer work you are coupled to, folding everything else into a one-line shape summary plus a compact `key status @owner` ledger — the keys stay enumerable for a full-replacement write. `all` expands every unfinished row, `mine` renders only your own rows in full, and `needs` is an alias for `layers`.",
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
      .map((task) => task.owner)
      .filter((owner): owner is string => owner !== undefined),
    ...activity,
  ]);
  if (!identitySetHas(known, recipient)) {
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
    skipped: 0,
  };
  let contextCheckpointNeeded = false;
  let llmCallsSinceReminder = 0;
  // Display-only fallback restored from a bounded digest when the board file is
  // missing (Layer 4). Never used for writes: the write path folds the real
  // file (missing = empty, revision 0), so no ghost baseRevision can pass the
  // gate. Cleared as soon as the board file exists again.
  let checkpointFallback: TowerBoardView | undefined;
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
  // Automatic log compaction (Layer 3): one in-flight compact per board file,
  // so a burst of writes cannot stack compactions; `lastAttempt` is a
  // failure/contention cooldown so `agent_settled` does not retry a board a
  // peer keeps busy on every run; `blockedAt` remembers the size of a board
  // the unattended path refused (unfoldable lines) so an unchanged log is not
  // re-lease/re-folded on every settle.
  const autoCompactsInFlight = new Set<string>();
  const autoCompactCooldown = new Map<string, number>();
  const autoCompactBlockedAt = new Map<string, number>();

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
    const { changed, untracked, renamed } = parsePorcelain(porcelain);
    const dirtyPaths = [...changed, ...untracked];
    if (!isSeeded(existing)) {
      await seedGitCounts(root, seq, dirtyPaths, existing);
      return;
    }
    await attributeGitCounts(root, seq, existing, dirtyPaths, renamed);
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
    renamed: ReadonlyMap<string, string>,
  ): Promise<void> => {
    const currentSet = new Set(dirtyPaths);
    const currentHashes = await hashPaths(root, dirtyPaths);
    if (seq !== gitRefreshSeq) return;
    if (currentHashes === undefined) {
      gitCounts = { ...existing, dirty: dirtyPaths.length };
      return;
    }
    const left = leftDirtyPaths(existing.lastDirty, currentSet, renamed);
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

  /** Identities with a fresh liveness record (Layer 1 routing), plus whether
   * the scan was COMPLETE. A read failure (missing dir, mid-scan error) must
   * not be read as "that owner is dead": callers treat an incomplete scan as
   * "every known owner is live", mirroring the task guard's strict fallback.
   * Liveness can only ever give a claim MORE standing, never resolve it. */
  const readLiveOwners = async (
    cwd: string,
  ): Promise<{ owners: Set<string>; complete: boolean }> => {
    const owners = new Set<string>();
    try {
      const dir = liveDirFor(cwd);
      const nowMs = Date.now();
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".json")) continue;
        const record = parseLiveRecord(
          await readFile(join(dir, name), "utf8"),
        );
        if (record === undefined) continue;
        if (record.at < nowMs - LIVE_WINDOW_MS) continue;
        for (const id of liveOwnerIdentities(record)) owners.add(id);
      }
      return { owners, complete: true };
    } catch {
      // No live dir yet, or an unreadable one: incomplete, so callers keep
      // every claim protected rather than treating silence as death.
      return { owners, complete: false };
    }
  };

  /** Effective live set for derivation: on an incomplete scan every owner that
   * appears on the board counts as live (strict guard, never loosened). */
  const effectiveLiveOwners = (
    view: TowerBoardView,
    live: { owners: Set<string>; complete: boolean },
  ): Set<string> => {
    if (live.complete) return live.owners;
    const all = new Set(live.owners);
    for (const task of view.tasks) {
      if (task.owner !== undefined) all.add(task.owner);
    }
    for (const finding of view.findings) {
      if (finding.owner !== undefined) all.add(finding.owner);
    }
    return all;
  };

  /** Filename-safe component (identities/session ids are human-chosen). */
  const sanitizeLiveName = (s: string): string =>
    s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_IDENTITY_CHARS) || "x";

  const selfSessionId = (ctx?: ExtensionContext): string => {
    const manager = ctx?.sessionManager ?? selfCtx?.sessionManager;
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
          identity: sessionIdentity(cwd, pi, selfCtx),
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
    const self = sessionIdentity(cwd, pi, selfCtx);
    if (caller === self || caller === "" || caller === "all") return;
    if (liveAliases.has(caller)) return;
    if (liveAliases.size >= MAX_TOWER_DO_ALIASES) {
      throw new TowerDoValidationError(
        `as identities this session can remember at most ${String(MAX_TOWER_DO_ALIASES)} aliases for liveness (got "${caller}")`,
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
      count: liveSessionCount(records, sessionIdentity(cwd, pi, selfCtx), Date.now()),
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
      `${sanitizeLiveName(sessionIdentity(cwd, pi, selfCtx))}.${sanitizeLiveName(selfSessionId(ctx))}.json`,
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
      sessionIdentity(activeCwd, pi, selfCtx),
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
              const identity = sessionIdentity(activeCwd, pi, selfCtx);
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
              // Rows are layered (mine → needs → other) and recency-first, so
              // the cap shows the work the caller is in before peers. Counts
              // stay board-wide.
              // The glance spends its rows on the caller's own work and the
              // peer work it is coupled to; unrelated unfinished tasks fold to
              // one count line. Their keys stay one `tower_do_status` away,
              // which any full-replacement write has to read anyway.
              const layers = classifyTaskLayers(
                unfinished,
                currentView,
                identity,
              );
              const needsKeys = new Set(
                layers.needs.map((entry) => entry.task.key),
              );
              const attention = [
                ...layers.mine,
                ...layers.needs.map((entry) => entry.task),
              ];
              const cap =
                activeCwd === undefined ? attention.length : WIDGET_TASK_LIMIT;
              const shown = attention.slice(0, cap);
              for (const task of shown) {
                const glyph = STATUS_GLYPH[task.status];
                const color = statusColor(task.status);
                const owner =
                  task.owner === undefined
                    ? ""
                    : task.owner === identity
                      ? theme.fg("accent", theme.bold(` @${task.owner}`))
                      : theme.fg("dim", ` @${task.owner}`);
                const needsTag = needsKeys.has(task.key)
                  ? theme.fg("dim", " [needs you]")
                  : "";
                lines.push(
                  `${theme.fg(color, glyph)} ${theme.fg("dim", `${task.key}:`)} ${theme.fg("text", task.subject)}${owner}${needsTag}`,
                );
              }
              if (attention.length > shown.length) {
                // Both layers feed `attention`, so "yours" would mislabel the
                // coupled peer rows; name what the caller has to do with
                // them — the dropped keys must stay enumerable for a
                // full-replacement write. Narrow widgets truncate the tail
                // (`truncateToWidth` below), which is fine: the leading keys
                // still render.
                lines.push(
                  theme.fg(
                    "dim",
                    formatKeyListLine(
                      `… and ${String(attention.length - shown.length)} more task(s) you need to see: `,
                      attention.slice(shown.length).map((task) => task.key),
                    ),
                  ),
                );
              }
              if (layers.other.length > 0) {
                // Same contract as the attention-overflow line above: the
                // folded layer's keys stay enumerable for a full-replacement
                // write; a narrow widget truncates the key tail, not the fact
                // that the keys are named.
                lines.push(
                  theme.fg(
                    "dim",
                    formatOtherKeysLine(
                      layers.other.map((task) => task.key),
                    ),
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
    const folded = await foldRetained(ctx.cwd);
    // Read paths show the last bounded checkpoint when the board file is gone;
    // the fold of a missing file is an empty board and would hide the digest's
    // open tasks. Writes ignore this view and re-fold the real file.
    const boardFileExists = existsSync(entry.board.file);
    if (boardFileExists) checkpointFallback = undefined;
    const view =
      !boardFileExists && checkpointFallback !== undefined
        ? cloneBoard(checkpointFallback)
        : folded;
    selfCtx = ctx;
    activeCwd = ctx.cwd;
    currentView = view;
    uiContext = ctx;
    const caller = resolveCaller(as, ctx.cwd, pi, ctx);
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
- Owner guard: a task with an owner can only be changed (any field) or removed by its owner or the "tower" identity. Exception: a non-completed task whose OWN activity is older than ${formatTakeoverWindow()} (TASK_CLAIM_STALE_MS; unrelated board chatter does not protect a row, and an owner's activity on another task never protects this one) may be displaced row by row — adopt it by setting owner to yourself and changing nothing else in that write (any content edit in the same write is rejected; re-plan in a second write), or remove it; completed tasks stay guarded.
- Dependencies gate status: in_progress/completed require every dependsOn entry to be completed, dependsOn keys must exist on the board or in this call, and cycles are rejected (blocked is exempt).
- Set changedFiles only in the same write that completes a task; reopening a task without changedFiles voids the inherited receipt.
- Content limits (subject ${MAX_TASK_SUBJECT_CHARS} / description ${MAX_TASK_DESCRIPTION_CHARS} characters) are enforced per task and a violation names the task key, so fix that one row instead of resending everything. An omitted field on an existing task is preserved (send only what changes); long-form evidence belongs in a tower_do_talk message or a finding, not in description.
- Always pass baseRevision from tower_do_status; omitting it disables the stale-write check.
- Capacity: up to ${MAX_TOWER_DO_OPEN_TASKS} non-completed tasks. Completed rows are receipts — they replay free, do not count, and can only be dropped by their owner or "tower", so a board of finished work never blocks a new plan. One write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} NEW completed rows (replaying an existing receipt is free; split a larger batch of deliveries across successive writes). When the open budget is full, omit your own or an unowned task; a board holding only completed rows is compacted by an as: "tower" write replaying just the rows to keep. Optional per-task fields: dependsOn (see above), scope (file globs the task may touch), blockedBy (free-form ids — non-empty renders a non-completed task as blocked).`,
    promptSnippet:
      "Maintain the shared multi-agent task board with one atomic update",
    promptGuidelines: [
      "Use tower_do for the task plan instead of direct file edits when multiple agents or sessions share the work; it is the shared board, not a private todo list.",
      "tower_do replaces the entire task list: read tower_do_status first and replay every key you want to keep, changing only the tasks you mean to change.",
      "When a task needs a plan of 3+ steps, define it yourself and call tower_do with subject + status before beginning substantive work.",
      "Include baseRevision (from tower_do_status) in every tower_do call; a stale revision is rejected so you never silently overwrite a peer's update.",
      "Mark a task completed only after implementation and verification succeed, attaching changedFiles (files you actually changed, repo-relative) in the same call. Use status blocked with a blockedBy note instead of leaving it hanging.",
      "Claim shared tasks by setting owner and in_progress together. Only the owner or the orchestrator identity tower may change an owned task's fields or remove it — to remove or reassign another agent's task, message the owner via tower_do_talk instead of editing it directly. If a task's owner has been idle on THAT task for " + formatTakeoverWindow() + "+ (unrelated board activity does not count), you may adopt it (set owner to yourself and change nothing else in that write) or remove it while it is not completed; completed tasks stay with their owner.",
      "Reconcile actual progress with the shared board before your final response, and do not issue a no-op tower_do call only to acknowledge a reminder.",
    ],
    parameters: TowerDoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal, "TowerDo update");
      if (params.action === "gc") {
        // Explicit, never periodic: the explicit path is orchestrator-gated and
        // must not carry task rows. (The extension also auto-compacts a
        // board log that crosses the size threshold at session/settle
        // boundaries; that path is lease/CAS/archive-guarded too and never
        // drops unfoldable lines — see `scheduleAutoCompact`.)
        const gc = await prepare(ctx, params.as);
        if (params.tasks.length > 0) {
          throw new TowerDoValidationError(
            'action="gc" compacts the log and takes no task rows — pass tasks: []',
          );
        }
        if (gc.caller !== TOWER_IDENTITY) {
          throw new TowerDoValidationError(
            `action="gc" requires the orchestrator identity "${TOWER_IDENTITY}" (got "${gc.caller}") — compaction rewrites the shared log`,
          );
        }
        // The only destructive path without an abort check until now: a
        // cancelled call must not rewrite and archive the shared log. Checked
        // again once the in-process queue is actually held (the wait for it
        // can be long).
        throwIfAborted(signal, "TowerDo gc");
        const result = await withFileMutationQueue(gc.board.file, () => {
          throwIfAborted(signal, "TowerDo gc");
          return gc.board.compact({
            by: gc.caller,
            archive: true,
            // gc ALWAYS archives the verbatim pre-compact log, so an unfoldable
            // legacy line is preserved there. Refusing by default left exactly
            // the boards whose hint asked for a gc un-cleanable (a retuned
            // field limit makes old rows partial/foreign to the fold). The
            // strict behaviour stays reachable with `dropSkipped: false`.
            dropSkipped: params.dropSkipped !== false,
          });
        });
        currentView = await foldRetained(ctx.cwd);
        updateWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text:
                `TowerDo log compacted at revision ${String(result.revision)} — ` +
                `${String(result.kept.tasks)} task(s), ${String(result.kept.messages)} message(s), ${String(result.kept.findings)} finding(s) kept; ` +
                `${(result.bytesBefore / 1024).toFixed(0)}KB → ${(result.bytesAfter / 1024).toFixed(0)}KB` +
                (result.archived === undefined
                  ? ""
                  : `\narchived: ${result.archived}`) +
                (result.skipped === 0
                  ? ""
                  : `\n${String(result.skipped)} unfoldable legacy line(s) moved to the archive (the live board no longer holds them; the archive survives only the next ${String(MAX_BOARD_ARCHIVES)} compact(s) — read it now if you need them)`) +
                (result.prunedArchives === undefined
                  ? ""
                  : `\npruned ${String(result.prunedArchives.length)} older archive(s) (keeping the newest ${String(MAX_BOARD_ARCHIVES)})`),
            },
          ],
          details: { caller: gc.caller, gc: result },
        };
      }
      // `dropSkipped` is a gc-only knob; a full-replacement write never
      // compacts, so silently ignoring it would surprise the caller (the talk
      // tool rejects taskKey on non-send for the same reason).
      if (params.dropSkipped !== undefined) {
        throw new TowerDoValidationError(
          'dropSkipped applies to action:"gc" only — a task write never compacts the log',
        );
      }
      const { board, caller } = await prepare(ctx, params.as);
      return withFileMutationQueue(board.file, async () => {
        const { details, activity } = await board.withWriteLock(async (appendLocked) => {
        // Re-fold inside both queues: the revision guard must observe peer
        // appends before it decides whether the full replacement is stale.
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
        // stale claims" inside the derivation — strict guard, never loosened.
        const staleClaims = staleTaskClaims(
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
          staleClaims,
        );
        throwIfAborted(signal, "TowerDo update");
        await appendLocked(details.taskEvents);
        return { details, activity };
        });
        currentView = cloneBoard(details.view);
        llmCallsSinceReminder = 0;
        updateWidget(ctx);
        // Presence footnote: surface owners who own unfinished tasks but have
        // no recent activity, so a coordinator sees who may be stalled. The
        // same parsed activity as the takeover check above — full history
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
                )} — message them (tower_do_talk), adopt their task via tower_do (set owner to yourself after ${formatTakeoverWindow()} of per-task inactivity), or re-claim via tower`;
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
  // tower_do_talk — addressed messages + structured findings
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: TOWER_DO_TALK_TOOL_NAME,
    label: "TowerDo Talk",
    description:
      'Cross-agent communication on the shared tower-do board. action=send delivers an inbox message to "all", the orchestrator identity "tower", a current task owner, or anyone with recent board activity (self-send rejected); taskKey optionally threads it under a task. action=inbox lists messages addressed to you or "all", newest first, and ACKS the ones it shows (marks them read; acked messages can be retired) — use tower_do_status to read messages without acking. action=finding files a structured out-of-scope finding (bug|improve|vuln|idea) with severity/location/suggestedFix, or updates one or many (findingId or findingIds + status): accepted claims it (owner defaults to you), done|rejected|snoozed require a reason, snoozed needs a future snoozeUntil, and open reopens. Non-closed findings are budgeted (50); a snooze still occupies a slot, so close (done|rejected) to free one before filing past the cap. Every open finding is listed oldest-debt-first. Use findings instead of silently editing other-owned tasks.',
    promptSnippet:
      "Send addressed messages or file findings on the shared multi-agent board",
    promptGuidelines: [
      'Use tower_do_talk to communicate with task owners on the shared board instead of editing owned tasks directly; the recipient must be "all", "tower", a current task owner, or someone with recent board activity (e.g. a peer whose tasks are all completed).',
      "Use action=finding (not direct edits) when you discover an out-of-scope problem — file it with kind/severity/summary/suggestedFix so the owning agent and reviewers can route it.",
      "Findings have a lifecycle, not just a create: claim one you take on (status=accepted, owner defaults to you), and close it (done/rejected) or snooze it with a reason when you are finished — a live owner sitting on a claimed finding past the grace period is blocked from filing new ones, and the non-closed budget is 50.",
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
        if (sameAgent(to, caller))
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
        // The lease spans the fold, the existence/recipient checks, the
        // audience snapshot and the append: `append` alone takes the lease
        // AFTER those checks, so a peer could delete the task in between and
        // the persisted message would carry a dangling taskKey (the same
        // reason tower_do and the finding paths use withWriteLock).
        await board.withWriteLock(async (appendLocked) => {
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
            ackedIds.has(message.id) && !identityListHas(message.readBy, caller)
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
              `- [${message.id}] [${identityListHas(message.readBy, caller) ? "read" : "UNREAD"}] ${message.from} → ${message.to}${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject}\n  ${message.body.split("\n")[0]}`,
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
        // Fast path: with nothing of mine unacked this is a PURE READ, so it
        // must not take the cross-process write lease — a read-only state dir
        // still has to serve an inbox, and a peer mid-compact must not stall a
        // read for up to LOCK_WAIT_MS.
        const peek = await readFold();
        throwIfAborted(signal, "TowerDo talk");
        const peekMine = myInbox(peek);
        if (
          !peekMine.some((message) => !identityListHas(message.readBy, caller))
        ) {
          return inboxResult(peek, peekMine, new Set());
        }
        // There IS something to ack: the fold, the ack set and the append must
        // be one atomic step across processes, or two peers acking the same
        // message lose one `readBy` entry to last-write-wins.
        return board.withWriteLock(async (appendLocked) => {
          throwIfAborted(signal, "TowerDo talk");
          const fresh = await readFold();
          throwIfAborted(signal, "TowerDo talk");
          const unacked = myInbox(fresh).filter(
            (message) => !identityListHas(message.readBy, caller),
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

      // action === finding (update one or a batch)
      if (params.findingId !== undefined && params.findingIds !== undefined) {
        throw new TowerDoValidationError(
          "finding update accepts either findingId or findingIds, not both",
        );
      }
      const targetIds =
        params.findingIds !== undefined
          ? [
              ...new Set(
                params.findingIds.map((id) => id.trim()).filter(Boolean),
              ),
            ]
          : params.findingId !== undefined
            ? [params.findingId]
            : undefined;
      if (targetIds !== undefined) {
        if (targetIds.length === 0) {
          throw new TowerDoValidationError(
            "findingIds must name at least one finding",
          );
        }
        if (targetIds.length > MAX_TOWER_DO_OPEN_FINDINGS) {
          throw new TowerDoValidationError(
            `findingIds names ${String(targetIds.length)} findings (max ${String(MAX_TOWER_DO_OPEN_FINDINGS)}) — split the batch across successive calls`,
          );
        }
        if (!FINDING_STATUSES.has(params.status ?? "")) {
          throw new TowerDoValidationError(
            "finding update requires status in open|accepted|snoozed|rejected|done",
          );
        }
        const nextStatus = params.status as FindingStatus;
        const reason = params.reason?.trim();
        // Closing/held without a reason is the silent-wrong class the board
        // exists to prevent: the transition must say why.
        if (
          (nextStatus === "done" ||
            nextStatus === "rejected" ||
            nextStatus === "snoozed") &&
          !reason
        ) {
          throw new TowerDoValidationError(
            `finding status=${nextStatus} requires a reason (single line, max ${MAX_FINDING_REASON_CHARS} chars)`,
          );
        }
        if (reason && /[\r\n\u2028\u2029]/.test(reason)) {
          throw new TowerDoValidationError(
            "finding reason must be a single line",
          );
        }
        if (reason && textLength(reason) > MAX_FINDING_REASON_CHARS) {
          throw new TowerDoValidationError(
            `finding reason is ${textLength(reason)} characters (max ${MAX_FINDING_REASON_CHARS}) — shorten it`,
          );
        }
        let snoozeUntil: number | undefined;
        if (nextStatus === "snoozed") {
          snoozeUntil = params.snoozeUntil ?? now + FINDING_SNOOZE_MAX_MS;
          if (!Number.isSafeInteger(snoozeUntil) || snoozeUntil <= now) {
            throw new TowerDoValidationError(
              "finding snoozeUntil must be a future epoch-ms value",
            );
          }
          if (snoozeUntil > now + FINDING_SNOOZE_MAX_MS) {
            throw new TowerDoValidationError(
              `finding snoozeUntil is more than ${String(Math.round(FINDING_SNOOZE_MAX_MS / 86_400_000))}d ahead — a snooze defers a finding, it never resolves it`,
            );
          }
        }
        const explicitOwner = params.owner?.trim();
        if (explicitOwner && /[\r\n\u2028\u2029]/.test(explicitOwner)) {
          throw new TowerDoValidationError(
            "finding owner must be a single line",
          );
        }
        if (explicitOwner && textLength(explicitOwner) > MAX_IDENTITY_CHARS) {
          throw new TowerDoValidationError(
            `finding owner is ${textLength(explicitOwner)} characters (max ${MAX_IDENTITY_CHARS}) — shorten it`,
          );
        }
        if (
          explicitOwner &&
          // Permission is EXACT, never aliased: `sameAgent` would hand a
          // bucket sibling (a different session inside the same 65.5s label
          // bucket) authority over someone else's claim.
          explicitOwner !== caller &&
          caller !== TOWER_IDENTITY
        ) {
          throw new TowerDoValidationError(
            `finding owner may only be reassigned by ${TOWER_IDENTITY} (got "${explicitOwner}")`,
          );
        }
        const updatedFindings = await board.withWriteLock(
          async (appendLocked) => {
            throwIfAborted(signal, "TowerDo talk");
            // Re-fold inside the lease: the findings may have changed since
            // the pre-queue fold in prepare(). The lease spans the fold, the
            // budget check and the append, so a concurrent process cannot
            // slip an extra non-closed finding between them.
            const fresh = await foldRetained(ctx.cwd);
            throwIfAborted(signal, "TowerDo talk");
            const byId = new Map(
              fresh.findings.map((finding) => [finding.id, finding]),
            );
            const missing = targetIds.filter((id) => !byId.has(id));
            if (missing.length > 0) {
              throw new TowerDoValidationError(
                `unknown finding ${missing.join(", ")}`,
              );
            }
            const liveRead = await readLiveOwners(ctx.cwd);
            const events: BoardEvent[] = [];
            const next: TowerDoFinding[] = [];
            for (const id of targetIds) {
              const existing = byId.get(id)!;
              // Accountability guard: a LIVE claim belongs to its owner (or
              // tower). A stale/dead claim is adoptable — liveness only
              // decides who may act, never whether the finding is resolved.
              // EXACT label match: CONTRACTS.md "permission is exact, only
              // delivery and display alias" — a legacy/current bucket sibling
              // must not be able to change this claim.
              if (
                existing.owner !== undefined &&
                existing.owner !== caller &&
                caller !== TOWER_IDENTITY &&
                (!liveRead.complete || liveRead.owners.has(existing.owner))
              ) {
                throw new TowerDoValidationError(
                  `finding ${id} is claimed by "${existing.owner}" (live) — only its owner or ${TOWER_IDENTITY} may change it`,
                );
              }
              const effectiveOwner =
                nextStatus === "accepted"
                  ? (explicitOwner ??
                    (existing.owner === undefined
                      ? caller
                      : existing.owner === caller ||
                          caller === TOWER_IDENTITY
                        ? existing.owner
                        : // Reaching here means the guard let a non-owner,
                          // non-tower caller through because the claim was not
                          // live: this is a takeover, so the claimer owns it.
                          caller))
                  : nextStatus === "open"
                    ? undefined
                    : existing.owner;
              const row: TowerDoFinding = {
                ...existing,
                status: nextStatus,
                at: now,
              };
              if (effectiveOwner === undefined) delete row.owner;
              else row.owner = effectiveOwner;
              if (reason === undefined) delete row.reason;
              else row.reason = reason;
              if (nextStatus === "snoozed" && snoozeUntil !== undefined) {
                row.snoozeUntil = snoozeUntil;
              } else {
                delete row.snoozeUntil;
              }
              next.push(row);
              events.push({
                kind: "finding",
                finding: row,
                by: caller,
                at: now,
              });
            }
            throwIfAborted(signal, "TowerDo talk");
            // Reopening (`status=open`) a closed finding adds a non-closed row,
            // so the update path must enforce the same budget the create path
            // does — otherwise close/reopen cycles bypass the cap.
            const byIdNextProbe = new Map(
              next.map((finding) => [finding.id, finding]),
            );
            const mergedFindings = fresh.findings.map(
              (finding) => byIdNextProbe.get(finding.id) ?? finding,
            );
            const beforeOpen = openFindingCount(fresh.findings);
            const afterOpen = openFindingCount(mergedFindings);
            // Only an increase can breach the budget — and only a reopen can
            // increase it. Blocking any over-cap update would make a legacy
            // board (e.g. the 73-open motivating case) impossible to drain:
            // closing one row from 52 leaves 51, still > 50, and must be
            // allowed.
            if (
              afterOpen > beforeOpen &&
              afterOpen > MAX_TOWER_DO_OPEN_FINDINGS
            ) {
              throw new TowerDoValidationError(
                `this update would grow non-closed findings over the budget (${String(MAX_TOWER_DO_OPEN_FINDINGS)}): ${String(beforeOpen)} -> ${String(afterOpen)}. A snooze still occupies a slot, so close one (done|rejected) first — tower_do_talk action=finding findingIds=[…] status=done|rejected reason=…`,
              );
            }
            await appendLocked(events);
            const byIdNext = new Map(
              next.map((finding) => [finding.id, finding]),
            );
            currentView = cloneBoard({
              ...fresh,
              findings: fresh.findings.map(
                (finding) => byIdNext.get(finding.id) ?? finding,
              ),
            });
            updateWidget(ctx);
            return next;
          },
        );
        const ids = updatedFindings.map((finding) => finding.id);
        return {
          content: [
            {
              type: "text",
              text:
                ids.length === 1
                  ? `TowerDo finding ${ids[0]} updated → ${nextStatus}`
                  : `TowerDo findings updated → ${nextStatus}: ${ids.join(", ")}`,
            },
          ],
          details: { caller, findingIds: ids, status: nextStatus },
        };
      }
      if (
        params.status !== undefined ||
        params.owner !== undefined ||
        params.reason !== undefined ||
        params.snoozeUntil !== undefined
      ) {
        throw new TowerDoValidationError(
          "status/owner/reason/snoozeUntil apply to a finding UPDATE (pass findingId or findingIds); a new finding is always filed open — file it, then claim it via status=accepted",
        );
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
      if (location && textLength(location) > MAX_FINDING_LOCATION_CHARS) {
        throw new TowerDoValidationError(
          `finding location is ${textLength(location)} characters (max ${MAX_FINDING_LOCATION_CHARS}) — shorten it`,
        );
      }
      const suggestedFix = params.suggestedFix?.trim();
      if (suggestedFix && /[\r\n\u2028\u2029]/.test(suggestedFix)) {
        throw new TowerDoValidationError(
          "finding suggestedFix must be a single line",
        );
      }
      if (
        suggestedFix &&
        textLength(suggestedFix) > MAX_FINDING_SUGGESTED_FIX_CHARS
      ) {
        throw new TowerDoValidationError(
          `finding suggestedFix is ${textLength(suggestedFix)} characters (max ${MAX_FINDING_SUGGESTED_FIX_CHARS}) — shorten it`,
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
      await board.withWriteLock(async (appendLocked) => {
        throwIfAborted(signal, "TowerDo talk");
        const fresh = await foldRetained(ctx.cwd);
        throwIfAborted(signal, "TowerDo talk");
        // Exit mechanism (Layer 1): the budget is charged to every non-closed
        // finding, and a live owner with an overdue claim must close it first.
        // Both bars carry an executable remedy in the message. The lease held
        // by withWriteLock makes the count-and-append atomic across processes.
        const liveOwners = effectiveLiveOwners(
          fresh,
          await readLiveOwners(ctx.cwd),
        );
        const rejection = findingBudgetRejection(
          fresh.findings,
          now,
          liveOwners,
          caller,
        );
        if (rejection !== undefined) {
          throw new TowerDoValidationError(rejection);
        }
        await appendLocked([{ kind: "finding", finding, by: caller, at: now }]);
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
    description: `Read the shared tower-do board: everyone's tasks (owner, status, deps, scope, blocks), messages addressed to you, open findings, and the recent activity tail. Unfinished work is caller-centred: your own rows and the peer rows you are coupled to (your unfinished work awaits it, it awaits yours, unread mail threads under it, or its declared scope intersects yours) render in full, recency-first, while every other unfinished row folds into one shape summary plus a \`key status @owner\` ledger — keys stay enumerable for a full-replacement write, and completed rows stay a compact key ledger (their detail is one taskKey lookup away). Still bounded by the dashboard budget and the byte/line caps, which disclose what they cut. Also prints the board file path and the current revision (pass it back as baseRevision) so subagents can read state directly (file-as-state). Reading here does NOT ack messages (tower_do_talk action=inbox does). Pass taskKey for the FULL detail of one task, findingId for the full text of one finding, view=all to expand the folded layer, or view=mine to narrow to your own rows. Output is bounded to ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB / ${String(DEFAULT_MAX_LINES)} lines from the TAIL (the head — header, revision, board file path and open-task rows — is dropped first) and says so in a footer when that happens.`,
    promptSnippet:
      "Show the shared multi-agent task board: tasks, messages, findings, activity",
    promptGuidelines: [
      "Use tower_do_status before starting work to see who owns what on the shared board, and before finishing work to reconcile your own tasks.",
      "When a tower_do write is rejected as stale, call tower_do_status first to re-read the current revision, then merge your changes and retry with the new baseRevision.",
      "Share the board file path from tower_do_status with subagents so they can read shared state directly; have them report back instead of editing owned tasks.",
      "Before a tower_do write, make sure the whole board is in view: the folded `## Others` ledger already names every open key (view=all adds their rows), and a key omitted from the write is removed — the default view's ledger is the minimum you must enumerate.",
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
      const presence = derivePresence(parsedEntries, tasks, now);
      const lastWrite = latestActivity(parsedEntries);

      // Totals BEFORE the page slice: the section headers must not report a
      // silently capped count as if it were the whole list (the task rows get
      // a hidden-rows note for exactly this reason).
      const allMyMessages = messagesToMe(view, caller).sort((a, b) => b.at - a.at);
      const myMessages = allMyMessages.slice(0, DASHBOARD_LIST_LIMIT);
      const myUnread = unreadMessagesToMe(view, caller).length;
      // Finding exit mechanism (Layer 1/2): liveness decides claimed vs
      // actionable, every non-closed row is budget, and the page is ordered by
      // PRESSURE (oldest overdue first) so the dashboard and the budget error
      // name the same rows. `view=all` widens to every row including snoozed
      // and closed-within-grace; the default list is the actionable/claimed
      // set and the rest are counts plus a disclosure.
      const liveOwners = effectiveLiveOwners(
        view,
        await readLiveOwners(ctx.cwd),
      );
      // A digest-restored view carries no closed rows, so a fresh summarize
      // would report `closed: 0 / retired: 0` as fact; the helper takes those
      // two from the checkpoint and keeps the live states fresh.
      const findingCounts = findingCountsFor(view, now, liveOwners);
      const findingOpenCount = openFindingCount(view.findings);
      // Layer 2 outer bound first (closed past the grace are retired), then the
      // default state filter (actionable/claimed). `view=all` ignores both.
      const visibleFindings = retainFindings(view.findings, now);
      const findingRows =
        params.view === "all"
          ? findingPressureOrder(view.findings, now, liveOwners)
          : findingPressureOrder(
              visibleFindings.filter((finding) => {
                const state = deriveFindingState(finding, now, liveOwners);
                return state === "actionable" || state === "claimed";
              }),
              now,
              liveOwners,
            );
      const openFindings =
        params.view === "all"
          ? findingRows
          : findingRows.slice(0, DASHBOARD_LIST_LIMIT);
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
      const limit = params.limit;
      // Open rows win the default budget (stable partition, so the slice keeps
      // fold order); an explicit `limit` is honoured in fold order verbatim.
      // The layers are computed over the whole board and the slice only decides
      // which rows render — render order inside a layer is recency-first.
      const { shown, hidden } = sliceTaskDashboard(filtered, limit);

      // Detail reads (taskKey / findingId) are bounded like the dashboard: a
      // 4000-character summary can render thousands of lines, and the tool
      // description promises the cut is disclosed.
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

      // Single-finding detail mode: a finding's summary is capped at 4000
      // characters and the dashboard list shows one truncated line, so the
      // full text needs its own read path.
      if (params.findingId !== undefined) {
        const finding = view.findings.find(
          (entry) => entry.id === params.findingId,
        );
        if (finding === undefined) {
          throw new TowerDoValidationError(
            `no finding with id "${params.findingId}" on the board (revision ${view.revision})`,
          );
        }
        const detail = [
          `TowerDo finding ${finding.id} — revision ${view.revision} (board file: ${board.file})`,
          `- id: ${finding.id}`,
          `- kind/severity: ${finding.kind} / ${finding.severity}`,
          `- status: ${finding.status}`,
        ];
        detail.push(
          view.incomplete === true
            ? "- from: unavailable (restored from a bounded checkpoint — no timestamp or author is kept)"
            : `- from: ${finding.from} (${new Date(finding.at).toISOString()})`,
        );
        if (finding.owner !== undefined) {
          detail.push(`- owner: ${finding.owner}`);
        }
        if (finding.reason !== undefined) {
          detail.push(`- reason: ${finding.reason}`);
        }
        if (finding.snoozeUntil !== undefined) {
          detail.push(
            `- snoozeUntil: ${new Date(finding.snoozeUntil).toISOString()}`,
          );
        }
        if (finding.location !== undefined) {
          detail.push(`- location: ${finding.location}`);
        }
        detail.push(`- title: ${finding.title}`);
        detail.push("- summary:");
        for (const row of finding.summary.split("\n")) detail.push(`  ${row}`);
        if (finding.suggestedFix !== undefined) {
          detail.push("- suggestedFix:");
          for (const row of finding.suggestedFix.split("\n")) {
            detail.push(`  ${row}`);
          }
        }
        return {
          content: [
            {
              type: "text",
              text: boundedDetail(`${detail.join("\n")}\n`, "finding detail"),
            },
          ],
          details: {
            caller,
            revision: view.revision,
            board: board.file,
            identity: caller,
            findingId: finding.id,
          },
        };
      }

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
          view.incomplete === true
            ? "- updatedAt: unavailable (restored from a bounded checkpoint — no timestamps are kept)"
            : `- updatedAt: ${relativeTime(now, task.updatedAt)} (${new Date(task.updatedAt).toISOString()})`,
        ];
        if (view.incomplete === true) {
          detail.push(
            "⚠ board file is missing — this detail comes from the last bounded checkpoint (open fields only); full content is unavailable.",
          );
        }
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
      if (view.incomplete === true) {
        lines.push(
          "⚠ this view is a bounded checkpoint from a previous session's transcript (open tasks + finding titles only; full content unavailable) — the board file was missing when it was restored. Writes treat a missing file as an empty board.",
        );
      } else if (
        !existsSync(board.file) &&
        view.tasks.length + view.messages.length + view.findings.length > 0
      ) {
        // A LEGACY full-board checkpoint restores as a complete view
        // (`incomplete` is undefined), so a non-empty view with a missing file
        // is that checkpoint — not an empty fold.
        lines.push(
          "⚠ the board file is missing — this view is the last full-board checkpoint from a previous session's transcript. Writes treat the missing file as an empty board.",
        );
      } else if (!existsSync(board.file)) {
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
      const logIsLarge =
        logLines >= BOARD_COMPACT_HINT_LINES ||
        logBytes >= BOARD_COMPACT_HINT_BYTES;
      // The AUTOMATIC trigger is the byte threshold only (a cheap stat on the
      // session/settle path); the line threshold is a status hint.
      const logBytesTriggerAuto = logBytes >= BOARD_COMPACT_HINT_BYTES;
      if (logIsLarge || view.skipped > 0) {
        lines.push(
          (logIsLarge
            ? `Log is large (${String(logLines)} lines, ${(logBytes / (1024 * 1024)).toFixed(1)}MB)`
            : `Log holds unfoldable data (${String(logLines)} lines, ${(logBytes / (1024 * 1024)).toFixed(1)}MB)`) +
            (view.skipped > 0
              ? `${logIsLarge ? " and" : ""} ${String(view.skipped)} line(s) cannot be folded`
              : "") +
            // A byte-large log WITHOUT unfoldable lines is reclaimed
            // automatically at the next session/settle boundary; a board that
            // holds them is left alone by the automatic path (it must not
            // discard data it cannot parse) and needs this explicit gc, which
            // archives them and reports the count. A line-large log under the
            // byte threshold is never auto-compacted — say so, or the reader
            // waits for a compaction that cannot happen.
            (view.skipped > 0
              ? ' — compact now with tower_do action:"gc" (tower only; archives the old log first), which moves the unfoldable lines into the archive and reports the count. A log with unfoldable lines is NOT compacted automatically.'
              : logBytesTriggerAuto
                ? ' — compact now with tower_do action:"gc" (tower only; archives the old log first). A log this large is compacted automatically at the session/settle boundary (never periodic).'
                : ' — it exceeds the line hint but not the 1MiB byte threshold, which is what triggers automatic compaction; compact now with tower_do action:"gc" (tower only).'),
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
          `Open-task budget full: completed rows do not count — omit your own or an unowned task, or compact a finished board with an as: "tower" write replaying just the rows to keep.`,
        );
      }
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
      if (relevantPresence.length === 0) {
        // An empty presence section spends three lines saying nothing; the
        // count the reader needs fits one.
        lines.push(
          `## Who is around: nobody active${historicalCount > 0 ? ` (${String(historicalCount)} with only historical activity)` : ""}`,
        );
      } else {
        lines.push(`## Who is around (${relevantPresence.length})`);
        for (const person of relevantPresence) {
          // Marker hugs the identity: "←" already means "depends on" on task
          // lines, so keep a single meaning per symbol.
          const label =
            sameAgent(person.identity, caller)
              ? `${person.identity} (me)`
              : person.identity;
          lines.push(
            `- ${formatPresenceLine({ ...person, identity: label }, now)}`,
          );
        }
        if (historicalCount > 0) {
          lines.push(
            `- … ${historicalCount} more with only historical activity`,
          );
        }
      }
      lines.push("");

      // Layered rendering: the caller's own unfinished work first, then the
      // peer work it is coupled to, then everything else, then receipts. Order
      // inside a layer is recency-first (classifyTaskLayers). A `view` that
      // excludes a layer renders it as a compact ledger instead of dropping
      // it, so the rows stay nameable for a full-replacement write.
      //
      // Classify the WHOLE board, then keep the sliced rows: the `needs` layer
      // is derived from the caller's own unfinished work, and a limit/owner=/
      // status= slice can exclude exactly that row.
      const layers = classifyTaskLayers(tasks, view, caller);
      const shownKeys = new Set(shown.map((task) => task.key));
      const sliced = (list: readonly TowerDoTask[]): TowerDoTask[] =>
        list.filter((task) => shownKeys.has(task.key));
      const needsReason = new Map(
        layers.needs.map((entry) => [entry.task.key, entry.reason]),
      );
      const taskRow = (task: TowerDoTask): string => {
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
        // Derived status, like the summary counts: a gated pending row must
        // not render as `○` while the header counts it blocked.
        const shownStatus = displayStatus(task);
        const blocked = shownStatus === "blocked";
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
        const reason = needsReason.get(task.key);
        // A peer row wins the window because the caller is coupled to it; say
        // why, or it reads as unrelated backlog the caller may skip.
        const needsSuffix =
          reason === undefined ? "" : ` [needs you: ${reason}]`;
        return `- ${STATUS_GLYPH[shownStatus]} ${task.key}: ${task.subject}${owner}${deps}${scope}${changedFilesSuffix(task)}${blockedSuffix}${needsSuffix}`;
      };
      const renderSection = (
        label: string,
        sectionTasks: readonly TowerDoTask[],
        compact: boolean,
      ): void => {
        if (sectionTasks.length === 0) return;
        const count = String(sectionTasks.length);
        // The summary must describe the rows actually rendered: an explicit
        // `limit` can drop rows from this layer, and a header that still counts
        // the dropped ones contradicts its own body.
        const detail = compact
          ? ` · ${formatLayerSummary(sectionTasks, view)}`
          : "";
        lines.push(
          compact
            ? `## ${label} (${count}${detail}, ledger)`
            : `## ${label} (${count})`,
        );
        for (const task of sectionTasks) {
          lines.push(compact ? formatLedgerRow(task) : taskRow(task));
        }
        lines.push("");
      };
      const layerView = params.view ?? "layers";
      // `mine` is never compacted by `view` (a view that hid the caller's own
      // work would have no reason to be called); an explicit `limit` can still
      // slice it, exactly as the documented fold-order contract says.
      renderSection("Mine", sliced(layers.mine), false);
      renderSection(
        "Needs you",
        sliced(layers.needs.map((entry) => entry.task)),
        layerView === "mine",
      );
      renderSection("Others", sliced(layers.other), layerView !== "all");
      // Receipts render as a key ledger: their subject, scope and changedFiles
      // are one `taskKey` lookup away, and rendering them per row spends the
      // first screen on other sessions' history. The dashboard budget still
      // applies to this section, and its cut is disclosed like any other.
      const completedShown = sliced(layers.completed);
      if (completedShown.length > 0) {
        lines.push(`## Completed (${completedShown.length})`);
        for (const row of formatLedgerKeyRows(completedShown)) {
          lines.push(row);
        }
        lines.push("");
      }

      if (shown.length === 0) lines.push("(no tasks match the filter)");
      const hiddenNote = formatDashboardHiddenNote(hidden, limit);
      if (hiddenNote !== undefined) lines.push(hiddenNote);

      if (scopeConflicts.length > 0) {
        const conflictKeys = new Set<string>([
          ...layers.mine.map((task) => task.key),
          ...layers.needs.map((entry) => entry.task.key),
        ]);
        const { shown: shownConflicts, hidden: hiddenConflicts } =
          sliceScopeConflicts(
            scopeConflicts,
            conflictKeys,
            layerView === "all"
              ? scopeConflicts.length
              : DASHBOARD_SCOPE_CONFLICT_LINES,
          );
        lines.push(
          `## Scope conflicts (${String(scopeConflicts.length)}${
            hiddenConflicts > 0 ? `, ${String(shownConflicts.length)} shown` : ""
          }) — advisory`,
        );
        for (const conflict of shownConflicts) {
          const glyph = conflict.kind === "collision" ? "⚠" : "⛔";
          const label =
            conflict.kind === "collision"
              ? `collision: ${conflict.taskKey} × ${conflict.peerKey}`
              : `overlap: ${conflict.taskKey} plans to touch what ${conflict.peerKey} already changed`;
          lines.push(`- ${glyph} ${label} — ${conflict.detail}`);
        }
        if (hiddenConflicts > 0) {
          lines.push(
            `  … +${String(hiddenConflicts)} more conflict(s) not shown — view=all lists every one`,
          );
        }
        lines.push(
          "  (advisory: scope is self-declared, changedFiles is self-reported — resolve by messaging the owner or re-scoping, not by gate)",
        );
        lines.push("");
      }

      lines.push(
        `## Messages for ${caller} (${myMessages.length}${
          allMyMessages.length > myMessages.length
            ? ` of ${allMyMessages.length}`
            : ""
        }; ${myUnread} unread)`,
      );
      for (const message of myMessages) {
        const readMark = identityListHas(message.readBy, caller)
          ? "read"
          : "UNREAD";
        lines.push(
          `- [${message.id}] [${readMark}] ${message.from} → me${message.taskKey === undefined ? "" : ` (task ${message.taskKey})`}: ${message.subject} — ${message.body.split("\n")[0]}`,
        );
      }
      if (myMessages.length === 0) lines.push("(none)");

      lines.push("");
      lines.push(
        `${params.view === "all" ? "## Findings" : "## Open findings"} (${String(findingOpenCount)}/${String(MAX_TOWER_DO_OPEN_FINDINGS)} non-closed · ` +
          `${String(findingCounts.actionable)} actionable · ${String(findingCounts.claimed)} claimed · ` +
          `${String(findingCounts.snoozed)} snoozed · ${String(findingCounts.closed)} closed<${String(Math.round(FINDING_CLOSE_GRACE_MS / 86_400_000))}d` +
          (findingCounts.retired > 0
            ? ` · ${String(findingCounts.retired)} retired`
            : "") +
          ")",
      );
      for (const finding of openFindings) {
        const location =
          finding.location === undefined ? "" : ` @${finding.location}`;
        // The list is a list: one truncated line per finding, the full text is
        // one `findingId` lookup away. suggestedFix is dropped here for the
        // same reason (a finding holds up to 4000 + 2000 characters).
        const summary = truncateChars(
          finding.summary.split("\n")[0] ?? "",
          DASHBOARD_FINDING_LINE_CHARS,
        );
        const state = deriveFindingState(finding, now, liveOwners);
        const age = Math.max(0, Math.floor((now - finding.at) / 86_400_000));
        // A digest-only fallback carries no real timestamps (`at` is 0), so an
        // age/overdue tag would read as decades old — omit it instead.
        const tag =
          view.incomplete === true
            ? ""
            : state === "snoozed"
              ? ` snoozed ${String(
                  Math.max(
                    0,
                    Math.ceil(((finding.snoozeUntil ?? now) - now) / 86_400_000),
                  ),
                )}d more`
              : state === "claimed"
                ? ` claimed by ${finding.owner ?? "?"} ${String(age)}d`
                : now - finding.at > FINDING_CLOSE_GRACE_MS
                  ? ` ${String(age)}d overdue`
                  : ` ${String(age)}d`;
        const owner =
          finding.owner === undefined ? "" : ` (owed to ${finding.owner})`;
        const from = finding.from === "" ? "" : ` (${finding.from})`;
        lines.push(
          `- [${finding.id}] [${finding.severity}/${finding.kind}] ${finding.title}${from}${owner}${location} — ${summary}${tag}`,
        );
      }
      if (openFindings.length === 0) lines.push("(none)");
      if (findingRows.length > openFindings.length) {
        lines.push(
          `  … +${String(findingRows.length - openFindings.length)} more finding(s) not shown — view=all lists every row (oldest debt first)`,
        );
      }
      if (findingCounts.retired > 0) {
        lines.push(
          view.incomplete === true
            ? `  … ${String(findingCounts.retired)} closed finding(s) retired beyond ${String(Math.round(FINDING_CLOSE_GRACE_MS / 86_400_000))}d — not in this checkpoint (the board file is missing; their full text is unavailable)`
            : `  … ${String(findingCounts.retired)} closed finding(s) retired beyond ${String(Math.round(FINDING_CLOSE_GRACE_MS / 86_400_000))}d — view=all lists them, findingId reads full text`,
        );
      }

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
      // Caller-owned lines stand out: accent + bold vs plain toolOutput. The
      // execute side already resolved the caller; prefer it over re-deriving.
      const details = (result.details ?? {}) as Record<string, unknown>;
      const caller =
        typeof details.identity === "string"
          ? details.identity
          : sessionIdentity(activeCwd, pi, selfCtx);
      // Fold by section, not by line: a head-cut spends the window on whichever
      // section renders first (the completed ledger) and hides the sections
      // that need action.
      const visible = expanded ? lines : foldDashboardSections(lines);
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
  // Lifecycle: restore, compact checkpoints, reminders, shutdown
  // -------------------------------------------------------------------------

  /**
   * Compact a board log whose size has crossed the documented threshold
   * (Layer 3), using the SAME safety envelope as an explicit `gc`: the
   * per-board cross-process lease, the content CAS, and an archive of the
   * verbatim pre-compact log. Never periodic — it is a size observation at a
   * session/settle boundary — and always attributed in the compact header, so
   * it stays auditable. Best-effort: a contended or failed auto-compact must
   * never break the session, and the explicit `gc` remains the manual path.
   */
  const scheduleAutoCompact = (
    cwd: string,
    ctx: ExtensionContext | undefined,
  ): void => {
    const entry = boards.entryFor(cwd);
    const file = entry.board.file;
    if (autoCompactsInFlight.has(file)) return;
    let bytes: number;
    try {
      bytes = statSync(file).size;
    } catch {
      return;
    }
    if (!shouldAutoCompactBoard(bytes)) return;
    // Refused at this exact size already: retrying means taking the lease and
    // folding the whole log only to refuse again. Any size change re-arms it.
    if (autoCompactBlockedAt.get(file) === bytes) return;
    const lastAttempt = autoCompactCooldown.get(file);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < 600_000) return;
    // Resolve the identity BEFORE registering the in-flight guard: a throw here
    // (a misbehaving host) would otherwise leave the entry behind forever and
    // disable auto-compaction for this board for the instance's lifetime.
    const identity = sessionIdentity(cwd, pi, ctx);
    autoCompactsInFlight.add(file);
    void withFileMutationQueue(file, async () => {
      // Re-check after queuing: a peer (or a previous auto-compact) may have
      // compacted the board since the stat.
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return;
      }
      if (!shouldAutoCompactBoard(size)) return;
      try {
        await entry.board.compact({
          by: identity,
          archive: true,
          // NEVER drop unfoldable lines from an unattended path: a legacy row
          // the fold cannot parse (a retuned field limit) is invisible in the
          // view but still recoverable from the raw log — an auto-compact that
          // discarded it, with the archive itself pruned after a few runs,
          // would be silent, permanent data loss. Such a board simply stays
          // uncompacted and `tower_do_status` keeps disclosing `skipped > 0`
          // plus the explicit `gc` remedy (which reports the count).
          dropSkipped: false,
        });
        autoCompactBlockedAt.delete(file);
        if (activeCwd === cwd && existsSync(file)) {
          currentView = await foldRetained(cwd);
        }
        // Re-check AFTER the await: a session/project switch during the fold
        // must not have the old board repainted (and `updateWidget()` with no
        // ctx keeps whichever context is current).
        if (activeCwd === cwd) updateWidget();
      } catch (error) {
        // Only the "refusing to compact: N unfoldable lines" refusal is
        // stable for a given size; pin THAT so the same unchanged log is not
        // re-lease/re-folded every settle. A transient failure (contended
        // lease, CAS) must stay retryable after the cooldown, so it does not
        // pin.
        if (
          error instanceof TowerDoValidationError &&
          error.message.startsWith("refusing to compact")
        ) {
          autoCompactBlockedAt.set(file, size);
        }
      }
    })
      .catch(() => {
        // Queue registration failed (e.g. realpath threw): swallow it so the
        // in-flight entry is released by `finally` instead of leaking, which
        // would disable auto-compaction for this board for the whole instance.
      })
      .finally(() => {
        autoCompactsInFlight.delete(file);
        autoCompactCooldown.set(file, Date.now());
      });
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    clearWidget();
    // Only this instance's own context — a nested session's restore must not
    // re-label this one (see sessionIdentity).
    selfCtx = ctx;
    activeCwd = ctx.cwd;
    const entry = boards.entryFor(ctx.cwd);
    // Disk is authoritative. Fall back to the last session checkpoint ONLY
    // when the board file is missing (worktree cleaned / first run) — never
    // when the board exists but holds zero tasks, because that is a genuine
    // `tower_do tasks: []` clear and replaying an old checkpoint would
    // resurrect finished work in the UI.
    if (existsSync(entry.board.file)) {
      currentView = await foldRetained(ctx.cwd);
      checkpointFallback = undefined;
    } else {
      // Always replace the in-memory view: a previous session's currentView
      // must not leak into this one when the board file is gone. getBranch
      // is root-to-leaf, so take the last valid checkpoint (see
      // latestBoardCheckpoint), not the first. BOTH forms restore: a digest is
      // an `incomplete` display view (open tasks + finding titles only), a
      // legacy full snapshot is a complete view. Either must become the
      // fallback the read paths use — keeping only the digest form left a
      // legacy-snapshot session reporting an empty fold on every tool call.
      const checkpoint = latestBoardCheckpoint(ctx.sessionManager.getBranch());
      // Pin the fallback to revision 0 as well: the write gate folds the
      // missing file at revision 0, so a read path that advertised the
      // checkpoint's revision would hand the caller a baseRevision every write
      // then rejects.
      checkpointFallback =
        checkpoint === undefined
          ? undefined
          : cloneBoard({ ...checkpoint, revision: 0 });
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
    // Session boundary is the natural time to reclaim a board log that grew
    // past the compaction threshold in an earlier session.
    scheduleAutoCompact(ctx.cwd, ctx);
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
    // A long session can outgrow the threshold between session starts; the
    // settle boundary is the cheapest safe place to reclaim it (never during
    // a write, and the compact takes the board lease itself).
    if (activeCwd !== undefined && uiContext !== undefined) {
      scheduleAutoCompact(activeCwd, uiContext);
    }
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
    // Compact / before_agent_start inject board snapshots (legacy full view or
    // the bounded digest) that persist in the session transcript. They must
    // not keep cancelled todos in the LLM context after a peer writes; always
    // strip them. Replacing with a fresh reminder is a separate cadence
    // (REMINDER_INTERVAL) — a leftover snapshot must not skip the counter and
    // re-inject every call.
    const isBoardContext = (message: {
      role?: string;
      customType?: string;
    }): boolean =>
      message.role === "custom" &&
      (message.customType === TOWER_DO_REMINDER_TYPE ||
        message.customType === TOWER_DO_BOARD_TYPE ||
        message.customType === TOWER_DO_BOARD_DIGEST_TYPE);
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

  pi.on("session_compact", async (event, ctx) => {
    // Fold + checkpoint under the same mutation queue as tower_do so a
    // concurrent cancel cannot land between the fold and appendEntry. The
    // transcript payload is the bounded DIGEST (Layer 4): open tasks + finding
    // titles + O(1) counts, never the whole view.
    const compactEntry = boards.entryFor(ctx.cwd);
    const identity = sessionIdentity(ctx.cwd, pi, ctx);
    const buildDigest = async (): Promise<TowerDoCheckpointDigest> =>
      checkpointDigest(
        currentView,
        Date.now(),
        effectiveLiveOwners(currentView, await readLiveOwners(ctx.cwd)),
        identity,
      );
    let digest: TowerDoCheckpointDigest;
    if (existsSync(compactEntry.board.file)) {
      digest = await withFileMutationQueue(compactEntry.board.file, async () => {
        currentView = await foldRetained(ctx.cwd);
        const next = await buildDigest();
        pi.appendEntry(TOWER_DO_BOARD_DIGEST_TYPE, next);
        return next;
      });
    } else {
      digest = await buildDigest();
      pi.appendEntry(TOWER_DO_BOARD_DIGEST_TYPE, digest);
    }
    if (event.willRetry || ctx.hasPendingMessages()) {
      contextCheckpointNeeded = false;
      llmCallsSinceReminder = REMINDER_ARMED;
      pi.sendMessage(
        {
          customType: TOWER_DO_BOARD_DIGEST_TYPE,
          content: formatBoardReminder(currentView, identity),
          display: false,
          details: digest,
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
    llmCallsSinceReminder = REMINDER_ARMED;
    const cwd = ctx?.cwd ?? activeCwd;
    if (cwd !== undefined) {
      const entry = boards.entryFor(cwd);
      if (existsSync(entry.board.file)) {
        await withFileMutationQueue(entry.board.file, async () => {
          currentView = await foldRetained(cwd);
        });
      }
    }
    const identity = sessionIdentity(cwd, pi, selfCtx);
    const live =
      cwd === undefined
        ? new Set<string>()
        : effectiveLiveOwners(currentView, await readLiveOwners(cwd));
    return {
      message: {
        customType: TOWER_DO_BOARD_DIGEST_TYPE,
        content: formatBoardReminder(currentView, identity),
        display: false,
        details: checkpointDigest(currentView, Date.now(), live, identity),
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
    selfCtx = undefined;
    activeCwd = undefined;
    currentView = createEmptyBoard();
    checkpointFallback = undefined;
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
