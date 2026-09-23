/**
 * tower-do — shared multi-agent task board (state layer).
 *
 * Pure schema/validation/folding, mirroring the reference todo extension's
 * state.ts style. The board is a shared, append-only file (file-as-state, in
 * the spirit of Kimi Tower's board): every writer appends events, folding them
 * yields the current view, and a monotonic `revision` guards against stale
 * blind writes (the simplified "merge gate": tool-read revision, never a
 * self-reported one).
 *
 * Tower concepts fused in:
 *  - ownership: a task may have an `owner`; status changes require the owner
 *    or the reserved orchestrator identity "tower" (workers only touch their
 *    own missions).
 *  - scope: optional file-glob list describing what paths the task may touch
 *    (mission scope; visible to everyone; only owner/tower may change it).
 *  - blocked: a task can be parked with a `blockedBy` note instead of being
 *    silently stuck (Tower's blocker/mission semantics).
 *  - deps: dependsOn must resolve against the FULL board + batch, not just the
 *    batch (Tower's "deps must reference known missions").
 */

export const TOWER_DO_SCHEMA_VERSION = 1 as const;
export const TOWER_DO_BOARD_TYPE = "pi-tower-do-board";
export const TOWER_DO_REMINDER_TYPE = "pi-tower-do-reminder";
export const TOWER_DO_TOOL_NAME = "tower_do";
export const TOWER_DO_TALK_TOOL_NAME = "tower_do_talk";
export const TOWER_DO_STATUS_TOOL_NAME = "tower_do_status";
/** Open-task budget: how many NON-completed tasks a board may hold. Completed
 * rows are receipts/history, not work: they replay free and never consume the
 * budget, otherwise a board whose rows are all completed becomes unwritable
 * for every session that is not an owner or `tower` (the guard pins completed
 * rows to their owner forever). See DECISIONS.md "open-task budget". */
export const MAX_TOWER_DO_OPEN_TASKS = 50;
/** Live-alias memory cap: distinct `as` labels one session records in its own
 * liveness sidecar. Unrelated to the task budget (identities, not work); they
 * were one constant before and silently changed together. */
export const MAX_TOWER_DO_ALIASES = 50;
export const DEFAULT_IDENTITY = "main";
/** Reserved orchestrator identity that may act on any owned task (Tower). */
export const TOWER_IDENTITY = "tower";
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_MESSAGE_SUBJECT_CHARS = 200;
export const MAX_FINDING_TITLE_CHARS = 200;
export const MAX_FINDING_SUMMARY_CHARS = 4000;
export const MAX_FINDING_LOCATION_CHARS = 256;
export const MAX_FINDING_SUGGESTED_FIX_CHARS = 2_000;
/** Finding exit mechanism (see docs/plans/board-exit.md and CONTRACTS.md):
 * open work is bounded, closing is auditable, and nothing actionable is ever
 * retired by age alone. These are semantic constants, not tuning knobs. */
/** Non-closed findings a board may carry (open + accepted + snoozed, expired
 * snoozes included). "Snooze" and "claim" both occupy a slot; only a terminal
 * status frees one — otherwise deferral would be a free way to clear the
 * budget and the digest could grow without bound again. */
export const MAX_TOWER_DO_OPEN_FINDINGS = 50;
/** A claimed finding older than this is an unfulfilled close obligation: its
 * owner must `done|rejected|snooze` before filing a new finding. Also the
 * default-view grace period for closed findings (visible, then view-retired). */
export const FINDING_CLOSE_GRACE_MS = 7 * 24 * 60 * 60_000;
/** Upper bound on how far a snooze may push a finding (`snoozeUntil <= now +
 * this`). An expired snooze flows back to `actionable`; a snooze never removes
 * the finding, it only leaves the default list. */
export const FINDING_SNOOZE_MAX_MS = 30 * 24 * 60 * 60_000;
/** Close/snooze reason: single line, stored in the event, shown in the detail
 * read. Closing without a reason is the silent-wrong class this board exists to
 * prevent, so the field is required for terminal/held transitions. */
export const MAX_FINDING_REASON_CHARS = 256;
/** Age after which an unread message leaves the default view even though nobody
 * acked it. The message stays on disk and is readable via `inbox all` — this is
 * a VIEW retirement (Layer 2), never a delete. */
export const MESSAGE_PENDING_RETIRE_MS = 14 * 24 * 60 * 60_000;
/** Ownership-takeover window for non-completed tasks, separate from the 30 min
 * presence/idle hint: ownership dies on the task-relevant activity clock, not
 * on unrelated board chatter (see staleTaskClaims). */
export const TASK_CLAIM_STALE_MS = 6 * 60 * 60_000;
/** Log-size thresholds. `BOARD_COMPACT_HINT_BYTES` is BOTH the automatic
 * compaction trigger (`shouldAutoCompactBoard`, a cheap `stat` at a
 * session/settle boundary) and a `tower_do_status` hint; `BOARD_COMPACT_HINT_LINES`
 * is disclosed by status only (the auto path does not read the whole file to
 * count lines). A compact is named (header `by`), archived (the pre-compact log
 * is kept under `archive/`) and lease/CAS-guarded, so a threshold-triggered run
 * is as auditable as an explicit `gc` — leaving the cleanup purely advisory is
 * what let every board in `~/.pi/tower-do` grow without bound.
 *
 * Never PERIODIC: the trigger is a file-size observation at a session/settle
 * boundary, never a timer. */
export const BOARD_COMPACT_HINT_LINES = 10_000;
export const BOARD_COMPACT_HINT_BYTES = 1024 * 1024;
/** Pre-compact logs kept per board under `<board-dir>/archive/`. A compact
 * writes one archive per run, so without a bound the cleanup would itself
 * accumulate whole-log copies forever; the newest N survive for audit (they
 * are also the evidence for the unfoldable legacy lines a `gc` discards). */
export const MAX_BOARD_ARCHIVES = 3;

/** Whether a board log has crossed the automatic compaction threshold. Pure so
 * the threshold has one definition and one test. Byte-based on purpose: the
 * trigger sits on the session/settle path and must stay a cheap `stat`. */
export function shouldAutoCompactBoard(bytes: number): boolean {
  return bytes >= BOARD_COMPACT_HINT_BYTES;
}

/** Checkpoint custom-entry type carrying the bounded digest (Layer 4). The old
 * `TOWER_DO_BOARD_TYPE` full-snapshot entries stay readable. */
export const TOWER_DO_BOARD_DIGEST_TYPE = "pi-tower-do-board-digest";

// ---------------------------------------------------------------------------
// Content limits — defined exactly once, here.
//
// The tool-arg schema is built from these constants (index.ts) instead of
// restating them, and each limit has exactly one enforcing layer: an
// element-level limit (`tasks[i].*`) is enforced by the extension so its error
// can name the task, a named top-level field by the schema. Nothing else may
// hard-code a limit: a second definition is a second rule that drifts (see
// CONTRACTS.md "arg schema vs the fold").
//
// Metric: `textLength` counts Unicode code points — not `String.length`
// (UTF-16 units, where one emoji is two) and not grapheme clusters (where a
// combining sequence is one). Code points are the cheap, dependency-free
// metric that matches the documented wording for the ordinary cases a caller
// writes; the host's own count is never larger (see `transportLimit`), so a
// limit expressed in code points never lets through what the host would refuse.
// ---------------------------------------------------------------------------

/** Task key: ASCII only, so the length is metric-free and the arg schema owns
 * the rule outright (pattern + length). The pattern derives from the length so
 * there is exactly one place to change it. */
export const MAX_TASK_KEY_CHARS = 40;
export const TASK_KEY_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9._-]{0,${MAX_TASK_KEY_CHARS - 1}}$`,
);
export const MAX_TASK_SUBJECT_CHARS = 160;
export const MAX_TASK_DESCRIPTION_CHARS = 2_000;
export const MAX_IDENTITY_CHARS = 64;
export const MAX_TASK_DEPENDENCIES = 20;
export const MAX_SCOPE_GLOBS = 20;
export const MAX_CHANGED_FILES = 100;
/** `blockedBy` is a free-form blocker list, not a dependency list: same shape,
 * different rule. Kept as its own constant so retuning the dependency cap
 * cannot silently retune the blocker cap (CONTRACTS.md task model). */
export const MAX_TASK_BLOCKERS = 20;
/** Longest single `blockedBy` entry. Blockers name a task/message/finding id,
 * so 120 is generous, but the list still needs a bound: it is rendered inline
 * in the reminder, which has no byte budget of its own. */
export const MAX_BLOCKER_CHARS = 120;
/** Longest single entry in a path-ish list (`scope` glob, `changedFiles`
 * path). Both are single-line repo-relative strings that must stay readable in
 * the dashboard, so one limit covers both. */
export const MAX_PATH_ENTRY_CHARS = 256;

/** Length of `value` in Unicode code points — the metric every user-facing
 * "at most N characters" limit in this extension uses. */
export function textLength(value: string): number {
  return [...value].length;
}

/** Arg-schema transport guard for a limit the EXTENSION enforces (fold or
 * execute). pi validates tool arguments against the same schema before
 * `execute` runs, and a rejection there can name only an array index
 * (`tasks.84.description`) — so an element-level bound living in the schema
 * rejects a whole write with an error that cannot say which task it hit.
 * Wherever the schema declares an element-level bound, it is this guard, and
 * the extension owns the error, because only it can name the task key, the
 * measured length and the remedy (CONTRACTS.md "arg schema vs the fold").
 * Limits the schema does not declare at all (per-entry size of
 * `scope`/`changedFiles`, the key format inside `dependsOn`) are enforced by
 * the extension alone and need no guard — nothing can pre-empt them.
 *
 * The guard is a payload bound, not a second rule: the host's length check
 * never counts more than the fold's code points (plain BMP text: exactly equal;
 * astral or combining text: fewer code points per counted character), so a
 * value the fold accepts is never refused preflight. 2× keeps the guard
 * strictly above the limit so a realistic overshoot (the incident was 1.11×)
 * reaches the fold's key-bearing error instead of the host's index-only one,
 * while still bounding the ordinary case at twice the intended payload. It is
 * deliberately not an upper bound on payload: a base character plus thousands
 * of combining marks is one grapheme and passes any such guard. */
export function transportLimit(limit: number): number {
  return limit * 2;
}

export type TowerDoStatus = "pending" | "in_progress" | "completed" | "blocked";
export type FindingKind = "bug" | "improve" | "vuln" | "idea";
export type FindingSeverity = "low" | "medium" | "high";
export type FindingStatus =
  | "open"
  | "accepted"
  | "snoozed"
  | "rejected"
  | "done";

export const TOWER_DO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);
export const FINDING_KINDS: ReadonlySet<string> = new Set([
  "bug",
  "improve",
  "vuln",
  "idea",
]);
export const FINDING_SEVERITIES: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
]);
export const FINDING_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "accepted",
  "snoozed",
  "rejected",
  "done",
]);

export function isTowerDoStatus(value: unknown): value is TowerDoStatus {
  return typeof value === "string" && TOWER_DO_STATUSES.has(value);
}

interface TowerDoTaskInput {
  key: string;
  subject?: string;
  description?: string;
  status?: TowerDoStatus;
  owner?: string;
  dependsOn?: string[];
  scope?: string[];
  /** Delivery receipt: files the owner actually changed (completed only). */
  changedFiles?: string[];
  blockedBy?: string[];
}

interface ResolvedTowerDoTaskInput {
  key: string;
  subject: string;
  status: TowerDoStatus;
  description?: string;
  owner?: string;
  dependsOn: string[];
  scope?: string[];
  changedFiles?: string[];
  blockedBy: string[];
}

export interface TowerDoTask extends ResolvedTowerDoTaskInput {
  updatedAt: number;
}

export interface TowerDoMessage {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  at: number;
  taskKey?: string;
  /** Identities that have read this message (acked). Absent = nobody read. */
  readBy?: string[];
  /**
   * For broadcasts (`to: "all"`): the owners who were on the board when it
   * was sent, excluding the sender. Full-read / retirement checks use this
   * snapshot so an owner who joins LATER (never addressed by the broadcast)
   * cannot keep it alive forever. Older broadcasts lack this and fall back
   * to the current board owners.
   */
  audience?: string[];
}

export interface TowerDoFinding {
  id: string;
  kind: FindingKind;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  summary: string;
  location?: string;
  suggestedFix?: string;
  /** Accountability owner (Layer 1): set on `claim`, displaceable by the same
   * stale-owner takeover rules as a task. Optional — legacy rows and unclaimed
   * findings have none. */
  owner?: string;
  /** Close/snooze reason (required for done|rejected|snoozed). Single line. */
  reason?: string;
  /** Wall-clock ms the finding returns to `actionable` (only for `snoozed`). */
  snoozeUntil?: number;
  from: string;
  /** Last write time — for `closed`/`snoozed` rows this is the transition time,
   * so the close-age grace and the snooze deadline read it directly. */
  at: number;
}

export interface TowerBoardView {
  schemaVersion: typeof TOWER_DO_SCHEMA_VERSION;
  revision: number;
  tasks: TowerDoTask[];
  messages: TowerDoMessage[];
  findings: TowerDoFinding[];
  /** Non-empty log lines the fold could not turn into an event (corrupt JSON,
   * foreign shapes, a task payload that no longer validates). Data the board
   * still holds but cannot show — never silent: the dashboard discloses it.
   * Not part of `revision` (which counts folded task events only). */
  skipped: number;
  /** True when this view was rebuilt from a bounded digest because the board
   * file was missing (Layer 4). Display-only fallback: it carries open tasks
   * and finding titles, NOT full content or history, and must be disclosed.
   * Never persisted into a board event. */
  incomplete?: boolean;
  /** Digest-only: the finding counts captured when the checkpoint was written.
   * A restored digest carries no closed rows, so re-summarizing it would
   * report `closed: 0 / retired: 0` as fact; renderers must prefer this
   * snapshot when present. Never persisted into a board event. */
  findingCountsAtCheckpoint?: FindingCounts;
}

interface TowerDoChangeSummary {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface TowerDoWriteDetails {
  view: TowerBoardView;
  caller: string;
  change: TowerDoChangeSummary;
  taskEvents: BoardTaskEvent[];
}

export interface TowerDoSnapshotInput {
  tasks: TowerDoTaskInput[];
  baseRevision?: number;
}

export class TowerDoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TowerDoValidationError";
  }
}

export function createEmptyBoard(): TowerBoardView {
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: 0,
    tasks: [],
    messages: [],
    findings: [],
    skipped: 0,
  };
}

function cloneTask(task: TowerDoTask): TowerDoTask {
  return {
    ...task,
    description: task.description,
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    dependsOn: [...task.dependsOn],
    ...(task.scope === undefined ? {} : { scope: [...task.scope] }),
    ...(task.changedFiles === undefined
      ? {}
      : { changedFiles: [...task.changedFiles] }),
    blockedBy: [...task.blockedBy],
  };
}

export function cloneBoard(view: TowerBoardView): TowerBoardView {
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: view.revision,
    skipped: view.skipped,
    ...(view.incomplete === undefined ? {} : { incomplete: view.incomplete }),
    ...(view.findingCountsAtCheckpoint === undefined
      ? {}
      : { findingCountsAtCheckpoint: { ...view.findingCountsAtCheckpoint } }),
    tasks: view.tasks.map(cloneTask),
    messages: view.messages.map((message) => ({
      ...message,
      ...(message.readBy === undefined ? {} : { readBy: [...message.readBy] }),
      ...(message.audience === undefined
        ? {}
        : { audience: [...message.audience] }),
    })),
    findings: view.findings.map((finding) => ({ ...finding })),
  };
}

export function getAllTasks(view: TowerBoardView): TowerDoTask[] {
  return view.tasks.map(cloneTask);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTaskKey(value: string, location: string): string {
  const key = value.trim();
  if (!TASK_KEY_PATTERN.test(key)) {
    throw new TowerDoValidationError(
      `${location} must be 1-${MAX_TASK_KEY_CHARS} lowercase ASCII letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return key;
}

interface BoardTaskEvent {
  kind: "task";
  op: "upsert" | "remove";
  key: string;
  task?: TowerDoTask;
  by: string;
  at: number;
}

function assertSingleLine(value: string, location: string): string {
  if (/[\r\n\u2028\u2029]/.test(value)) {
    throw new TowerDoValidationError(`${location} must be a single line`);
  }
  return value;
}

export function normalizeIdentity(
  value: string | undefined,
  location: string,
): string {
  const identity = value?.trim();
  if (!identity) throw new TowerDoValidationError(`${location} is required`);
  assertSingleLine(identity, location);
  // NUL is the separator in `claimKey` (and board.ts's task clock), so an
  // identity carrying one could collide with another (owner, task) pair. Task
  // keys cannot contain NUL (their pattern is lowercase ASCII), so rejecting it
  // on the identity side is enough to keep those keys injective.
  if (identity.includes("\u0000")) {
    throw new TowerDoValidationError(
      `${location} must not contain a NUL character`,
    );
  }
  const identityLength = textLength(identity);
  if (identityLength > MAX_IDENTITY_CHARS)
    throw new TowerDoValidationError(
      `${location} is ${identityLength} characters (max ${MAX_IDENTITY_CHARS}) — shorten it`,
    );
  if (identity === "all") {
    throw new TowerDoValidationError(
      `${location} must not be the reserved broadcast recipient "all"`,
    );
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Identity labels — one agent, one key
// ---------------------------------------------------------------------------

/** pi session ids are UUIDv7 (hex, `8-4-4-4-12`): the first 12 hex digits are a
 * millisecond timestamp, the last 12 are random. Two generated-label shapes
 * exist: `session-<time8>` (≤ 0.4.0) and `session-<time8>-<rand8>` (≥ 0.4.1). */
const LEGACY_SESSION_LABEL = /^session-([0-9a-f]{8})$/;
const CURRENT_SESSION_LABEL = /^session-([0-9a-f]{8})-([0-9a-f]{8})$/;

/** Board identity for a session id: `session-<time8>-<rand8>`.
 *
 * Through 0.4.0 the label was `session-<time8>`. The first 8 hex digits of a
 * UUIDv7 are the top 32 bits of a 48-bit millisecond timestamp — pure time
 * with no entropy — so every session started inside one 65536 ms (65.5 s)
 * bucket resolved to the SAME identity: parallel subagents, launched within
 * milliseconds of each other, shared one owner key (observed live: two
 * siblings 26 ms apart, both `session-01a0b47e`). The suffix carries 8 hex
 * digits of the id's random tail, which separates the bucket's members.
 *
 * The time prefix is kept verbatim, so a ≤ 0.4.0 label is a prefix of the
 * label the same session resolves to now — that partition is what `sameAgent`
 * uses to migrate rows written before the change. */
export function sessionLabel(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}-${sessionId
    .replace(/-/g, "")
    .slice(-8)}`;
}

/**
 * Do two labels reach the same agent? DELIVERY AND DISPLAY ONLY — never
 * permission (see the owner guard: it compares labels exactly).
 *
 * Exact equality always does. Beyond that a legacy `session-<time8>` label
 * reaches the `session-<time8>-<rand8>` label it prefixes, so mail addressed to
 * a pre-0.4.1 label is still delivered and a migrated row still renders as the
 * same agent. A legacy label is ambiguous for its whole 65.5 s bucket by
 * construction — it cannot name one member — so this relation is deliberately
 * permissive: it may over-deliver (the pre-0.4.1 reach, never worse) but must
 * never lose mail.
 *
 * Two CURRENT labels are never equated, not even when they share the 8-digit
 * time prefix: that prefix is a bucket, not an identity, and treating bucket
 * siblings as one agent is exactly the collision this fixes. Labels that are
 * not generated session labels (a pinned `config.identity`, an `as` label)
 * compare verbatim. The relation is NOT transitive (legacy ↔ each sibling), so
 * grouping must stay keyed — `derivePresence` merges a legacy row only into a
 * bucket that holds exactly one current label.
 */
export function sameAgent(left: string, right: string): boolean {
  if (left === right) return true;
  const legacyLeft = LEGACY_SESSION_LABEL.exec(left);
  const legacyRight = LEGACY_SESSION_LABEL.exec(right);
  if (legacyLeft === null && legacyRight === null) return false;
  const currentLeft = CURRENT_SESSION_LABEL.exec(left);
  const currentRight = CURRENT_SESSION_LABEL.exec(right);
  if (legacyLeft !== null && currentRight !== null)
    return legacyLeft[1] === currentRight[1];
  if (legacyRight !== null && currentLeft !== null)
    return legacyRight[1] === currentLeft[1];
  return false;
}

/** Set membership that honours `sameAgent` — for reachability and display
 * (audiences, recipient validation, presence). NEVER for permission: the owner
 * guard compares labels exactly. Identity sets are small. */
export function identitySetHas(
  set: ReadonlySet<string>,
  label: string,
): boolean {
  if (set.has(label)) return true;
  for (const candidate of set) if (sameAgent(candidate, label)) return true;
  return false;
}

/** List membership that honours `sameAgent` (read receipts, audiences). */
export function identityListHas(
  list: readonly string[] | undefined,
  label: string,
): boolean {
  return (list ?? []).some((candidate) => sameAgent(candidate, label));
}

/** `readBy` after `label` acks: append unless the same agent is already
 * recorded. Purely additive — an existing legacy entry is left alone, because
 * rewriting another label's receipt is not this ack's business. */
export function readByWith(
  readBy: readonly string[] | undefined,
  label: string,
): string[] {
  const next = [...(readBy ?? [])];
  if (!identityListHas(next, label)) next.push(label);
  return next;
}

/**
 * Normalize one task input against the current board + existing task (merge
 * semantics like the reference todo: omitted fields preserve existing values,
 * new keys require subject + status).
 */
export function writeBoardSnapshot(
  current: TowerBoardView,
  input: TowerDoSnapshotInput,
  caller: string,
  /** Displaceable claims (staleTaskClaims), keyed owner+NUL+task; empty keeps
   * the guard strict — the default is what every non-board-aware caller wants. */
  staleClaims: ReadonlySet<string> = new Set(),
): TowerDoWriteDetails {
  if (
    input.baseRevision !== undefined &&
    input.baseRevision !== current.revision
  ) {
    throw new TowerDoValidationError(
      `stale tower-do revision: expected ${String(input.baseRevision)}, current board revision is ${current.revision} — ` +
        "call tower_do_status to re-read the shared board, then merge your changes",
    );
  }
  const existingByKey = new Map(current.tasks.map((task) => [task.key, task]));
  const resolved: ResolvedTowerDoTaskInput[] = [];
  const keys = new Set<string>();

  for (const [index, patch] of input.tasks.entries()) {
    const key = normalizeTaskKey(patch.key, `tasks[${index}].key`);
    if (keys.has(key))
      throw new TowerDoValidationError(
        `tasks[${index}].key is duplicated: ${key}`,
      );
    keys.add(key);

    const existing = existingByKey.get(key);
    const subject = patch.subject ?? existing?.subject;
    if (subject === undefined) {
      throw new TowerDoValidationError(
        `tasks[${index}].subject is required for new task ${key}`,
      );
    }
    const status = patch.status ?? existing?.status;
    if (status === undefined) {
      throw new TowerDoValidationError(
        `tasks[${index}].status is required for new task ${key}`,
      );
    }
    const owner = patch.owner ?? existing?.owner;
    if (owner !== undefined && owner.trim() !== "") {
      // Validate here too (fail fast before the merge), but with the key: an
      // element-level rejection must be attributable to a task. A blank owner
      // is skipped because the layers below treat "" as "no owner" — checking
      // it here would make this pre-check stricter than the layer it guards.
      normalizeIdentity(owner, `tasks[${index}].owner (${key})`);
    }
    // Receipts describe a completed delivery: do not inherit one onto a
    // reopen, or normalizeTask rejects a field the caller never sent.
    const changedFiles =
      patch.changedFiles === undefined
        ? status === "completed"
          ? existing?.changedFiles
          : undefined
        : patch.changedFiles;

    resolved.push(
      normalizeTask(
        {
          key,
          subject,
          status,
          ...(patch.description === undefined
            ? existing?.description
              ? { description: existing.description }
              : {}
            : { description: patch.description }),
          ...(owner === undefined ? {} : { owner }),
          dependsOn:
            patch.dependsOn === undefined
              ? existing
                ? [...existing.dependsOn]
                : []
              : patch.dependsOn,
          ...(patch.scope !== undefined || existing?.scope !== undefined
            ? { scope: patch.scope ?? existing!.scope }
            : {}),
          ...(changedFiles === undefined ? {} : { changedFiles }),
          blockedBy:
            patch.blockedBy === undefined
              ? existing
                ? [...existing.blockedBy]
                : []
              : patch.blockedBy,
        },
        index,
      ),
    );
  }

  // Capacity is charged to open work, not to history: completed rows stay
  // replayable without limit. Both checks run after normalization on purpose —
  // the open quota is the common overflow and carries the remediation hint, so
  // it must be the error the caller sees.
  const openTaskCount = resolved.filter(
    (task) => task.status !== "completed",
  ).length;
  if (openTaskCount > MAX_TOWER_DO_OPEN_TASKS) {
    throw new TowerDoValidationError(
      `open tasks support at most ${MAX_TOWER_DO_OPEN_TASKS} items (got ${openTaskCount}; completed rows do not count)` +
        OPEN_TASK_BUDGET_HINT,
    );
  }
  // What the budget bounds is fabricated history, not batch length: a delivered
  // task is one the board already carries (replaying it is free), so this caps
  // only the NEW completed rows a single write introduces. A length ceiling
  // would reject an honest full replay as soon as the board outgrew any fixed
  // number — the deadlock this budget exists to remove. The quota is
  // deliberately the same constant as the open budget (one number, two
  // readings: work a board carries / history one write may invent) — not a
  // second knob whose value could drift from the first.
  const newCompleted = resolved.filter(
    (task) => task.status === "completed" && !existingByKey.has(task.key),
  ).length;
  if (newCompleted > MAX_TOWER_DO_OPEN_TASKS) {
    throw new TowerDoValidationError(
      `a write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} new completed tasks (got ${newCompleted}; replaying a completed row the board already holds is free — do not fabricate receipts, split deliveries across successive writes)`,
    );
  }

  const removedTasks = current.tasks.filter((task) => !keys.has(task.key));

  // Tower: workers may remove only their own (or unowned) tasks; the
  // orchestrator may remove any. Without this, a partial-list update or a
  // stray `tasks: []` would silently delete another agent's task.
  // Stale-claim exception: a row whose own claim is idle past
  // OWNER_TAKEOVER_MS may be removed by anyone (adoption via update is the
  // gentler path, but a hopeless task should not need an adopter first).
  // Completed tasks keep the full guard — a receipt cannot be dropped by a
  // peer. The exception is asked PER ROW: an owner may be dead on one task and
  // alive on another, so a row-level set is what keeps a live sibling safe.
  for (const removed of removedTasks) {
    // EXACT label match, not `sameAgent`: a legacy `session-<time8>` label
    // cannot name one member of its 65.5 s bucket, so aliasing it here would
    // hand every bucket sibling write rights over the row. Ambiguity is
    // resolved strictly (the owner is unreachable ⇒ takeover/tower), never by
    // guessing.
    if (
      removed.owner !== undefined &&
      caller !== removed.owner &&
      caller !== TOWER_IDENTITY
    ) {
      if (
        isStaleClaim(staleClaims, removed.owner, removed.key) &&
        removed.status !== "completed"
      )
        continue;
      throw new TowerDoValidationError(
        `task ${removed.key} is owned by "${removed.owner}" — only its owner or ${TOWER_IDENTITY} may remove it` +
          staleClaimHint(removed, staleClaims),
      );
    }
  }

  // tower_do is a FULL replacement: every key not in this batch is removed, so
  // after the write the board contains exactly `resolved`. Dependency targets
  // must therefore live in this batch — `assertDependenciesAreConsistent`
  // below checks against `resolved` only, which also catches a batch task
  // depending on a task this same write deletes (a pre-write board lookup
  // would wrongly see the to-be-deleted task and let a dangling ref through).
  assertDependenciesAreConsistent(resolved, current);
  assertNoDependencyCycles(resolved);

  const now = Date.now();
  const taskEvents: BoardTaskEvent[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const nextTasks: TowerDoTask[] = [];

  for (const task of resolved) {
    const existing = existingByKey.get(task.key);
    const candidate: TowerDoTask = {
      ...cloneNormalizedTask(task),
      updatedAt: now,
    };
    if (!existing) {
      added.push(task.key);
      taskEvents.push({
        kind: "task",
        op: "upsert",
        key: task.key,
        task: candidate,
        by: caller,
        at: now,
      });
      nextTasks.push(candidate);
      continue;
    }
    if (taskEquals(existing, candidate)) {
      // Content unchanged: no event, no revision bump, and the row keeps its
      // original updatedAt — a no-op full-list replay must not drift it.
      nextTasks.push(cloneTask(existing));
      continue;
    }
    // Tower: only the owner or the orchestrator may change an owned task's
    // fields (removal is guarded separately above). We only reach this point
    // when taskEquals found a real field change, so a plain ownership check
    // suffices — the every-field comparison already happened.
    // Stale-claim exception (takeover/adopt): strictly an ownership
    // displacement — the candidate must equal the existing task except for
    // owner === caller. Any content edit (subject/status/deps/scope/…) of a
    // stalled task stays rejected; the adopter re-plans in a second write
    // once it owns the task. This keeps the every-field guard's promise
    // intact: a peer can displace a dead ownership, never silently rewrite
    // someone's content or forge a receipt. Per row, like the removal guard:
    // adopting away a row the owner touched a minute ago is the same data loss
    // as deleting it, so both sites ask about THIS key.
    const adoptingStale =
      isStaleClaim(staleClaims, existing.owner, existing.key) &&
      existing.status !== "completed" &&
      task.owner === caller &&
      taskEquals(
        { ...existing, owner: task.owner },
        // taskEquals ignores updatedAt; the spread only satisfies its
        // TowerDoTask parameter (a resolved input carries no timestamp).
        { ...task, updatedAt: existing.updatedAt },
      );
    if (
      existing.owner !== undefined &&
      caller !== existing.owner &&
      caller !== TOWER_IDENTITY &&
      !adoptingStale
    ) {
      throw new TowerDoValidationError(
        `task ${task.key} is owned by "${existing.owner}" — workers may update only their own tasks ` +
          `(${TOWER_IDENTITY} may update any)` +
          staleClaimHint(existing, staleClaims),
      );
    }
    updated.push(task.key);
    taskEvents.push({
      kind: "task",
      op: "upsert",
      key: task.key,
      task: candidate,
      by: caller,
      at: now,
    });
    nextTasks.push(candidate);
  }

  for (const removed of removedTasks) {
    taskEvents.push({
      kind: "task",
      op: "remove",
      key: removed.key,
      by: caller,
      at: now,
    });
  }

  const removed = removedTasks.map((task) => task.key);
  // One revision bump per persisted task event, so a refold of the file yields
  // the exact same revision the write reported (the gate reads the file).
  const changed = taskEvents.length > 0;

  const nextView: TowerBoardView = {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: changed ? current.revision + taskEvents.length : current.revision,
    tasks: nextTasks,
    // Fresh arrays: the returned view must not alias the caller's board (a
    // caller mutating the result would otherwise mutate the input view).
    messages: [...current.messages],
    findings: [...current.findings],
    skipped: current.skipped,
  };

  return {
    view: nextView,
    caller,
    change: { added, updated, removed },
    taskEvents,
  };
}

function cloneNormalizedTask(
  task: ResolvedTowerDoTaskInput,
): ResolvedTowerDoTaskInput {
  return {
    key: task.key,
    subject: task.subject,
    status: task.status,
    ...(task.description === undefined
      ? {}
      : { description: task.description }),
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    dependsOn: [...task.dependsOn],
    ...(task.scope === undefined ? {} : { scope: [...task.scope] }),
    ...(task.changedFiles === undefined
      ? {}
      : { changedFiles: [...task.changedFiles] }),
    blockedBy: [...task.blockedBy],
  };
}

/** Element-wise list equality. Compared element by element rather than by
 * joining with a separator: a join is only injective when the separator cannot
 * appear in a value, and these lists hold arbitrary caller text. */
function listEquals(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function taskEquals(left: TowerDoTask, right: TowerDoTask): boolean {
  return (
    left.subject === right.subject &&
    left.status === right.status &&
    left.description === right.description &&
    left.owner === right.owner &&
    listEquals(left.dependsOn, right.dependsOn) &&
    listEquals(left.scope, right.scope) &&
    listEquals(left.changedFiles, right.changedFiles) &&
    listEquals(left.blockedBy, right.blockedBy)
  );
}

function normalizeTask(
  input: ResolvedTowerDoTaskInput,
  index: number,
): ResolvedTowerDoTaskInput {
  const key = normalizeTaskKey(input.key, `tasks[${index}].key`);
  const subject = assertSingleLine(
    input.subject.trim(),
    `tasks[${index}].subject (${key})`,
  );
  if (!subject)
    throw new TowerDoValidationError(
      `tasks[${index}].subject (${key}) is required`,
    );
  const subjectLength = textLength(subject);
  if (subjectLength > MAX_TASK_SUBJECT_CHARS)
    throw new TowerDoValidationError(
      `tasks[${index}].subject (${key}) is ${subjectLength} characters (max ${MAX_TASK_SUBJECT_CHARS}) — shorten it`,
    );

  const description = normalizeOptionalText(input.description);
  if (description !== undefined) {
    const descriptionLength = textLength(description);
    if (descriptionLength > MAX_TASK_DESCRIPTION_CHARS) {
      throw new TowerDoValidationError(
        `tasks[${index}].description (${key}) is ${descriptionLength} characters (max ${MAX_TASK_DESCRIPTION_CHARS}) — shorten it, or omit the field to preserve the stored text`,
      );
    }
  }

  if (!isTowerDoStatus(input.status)) {
    throw new TowerDoValidationError(
      `tasks[${index}].status (${key}) is invalid: ${String(input.status)}`,
    );
  }

  // Lists: normalize (trim, drop blanks, dedupe) FIRST, then validate entries,
  // then apply the cap. Counting the raw input would reject a batch whose
  // stored value is legal: 101 changedFiles entries with one duplicate is 100
  // paths, and 21 dependsOn entries with a duplicate is one dependency.
  const dependsOn = [
    ...new Set(
      (input.dependsOn ?? [])
        .map((dependency) => dependency.trim())
        .filter(Boolean),
    ),
  ];
  for (const [dependencyIndex, dependency] of dependsOn.entries()) {
    normalizeTaskKey(
      dependency,
      `tasks[${index}].dependsOn[${dependencyIndex}] (${key})`,
    );
  }
  if (dependsOn.length > MAX_TASK_DEPENDENCIES) {
    throw new TowerDoValidationError(
      `tasks[${index}].dependsOn (${key}) supports at most ${MAX_TASK_DEPENDENCIES} keys`,
    );
  }
  if (dependsOn.includes(key)) {
    throw new TowerDoValidationError(
      `tasks[${index}].dependsOn (${key}) cannot depend on itself`,
    );
  }

  const scope = [
    ...new Set(
      (input.scope ?? [])
        .map((glob, entryIndex) =>
          assertSingleLine(
            glob.trim(),
            `tasks[${index}].scope[${entryIndex}] (${key})`,
          ),
        )
        .filter(Boolean),
    ),
  ];
  for (const [entryIndex, glob] of scope.entries()) {
    const globLength = textLength(glob);
    if (globLength > MAX_PATH_ENTRY_CHARS) {
      throw new TowerDoValidationError(
        `tasks[${index}].scope[${entryIndex}] (${key}) is ${globLength} characters (max ${MAX_PATH_ENTRY_CHARS}) — shorten it`,
      );
    }
  }
  if (scope.length > MAX_SCOPE_GLOBS) {
    throw new TowerDoValidationError(
      `tasks[${index}].scope (${key}) supports at most ${MAX_SCOPE_GLOBS} globs`,
    );
  }

  const changedFiles = [
    ...new Set(
      (input.changedFiles ?? [])
        .map((file, entryIndex) =>
          assertSingleLine(
            file.trim(),
            `tasks[${index}].changedFiles[${entryIndex}] (${key})`,
          ),
        )
        .filter(Boolean),
    ),
  ];
  for (const [entryIndex, file] of changedFiles.entries()) {
    const fileLength = textLength(file);
    if (fileLength > MAX_PATH_ENTRY_CHARS) {
      throw new TowerDoValidationError(
        `tasks[${index}].changedFiles[${entryIndex}] (${key}) is ${fileLength} characters (max ${MAX_PATH_ENTRY_CHARS}) — shorten it`,
      );
    }
  }
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new TowerDoValidationError(
      `tasks[${index}].changedFiles (${key}) supports at most ${MAX_CHANGED_FILES} paths`,
    );
  }
  if (changedFiles.length > 0 && input.status !== "completed") {
    throw new TowerDoValidationError(
      `tasks[${index}].changedFiles (${key}) is a delivery receipt — it requires status "completed" (got "${input.status}")`,
    );
  }

  const blockedBy = [
    ...new Set(
      (input.blockedBy ?? [])
        .map((entry, entryIndex) =>
          assertSingleLine(
            entry.trim(),
            `tasks[${index}].blockedBy[${entryIndex}] (${key})`,
          ),
        )
        .filter(Boolean),
    ),
  ];
  if (blockedBy.length > MAX_TASK_BLOCKERS) {
    throw new TowerDoValidationError(
      `tasks[${index}].blockedBy (${key}) supports at most ${MAX_TASK_BLOCKERS} entries`,
    );
  }
  for (const [entryIndex, entry] of blockedBy.entries()) {
    const entryLength = textLength(entry);
    if (entryLength > MAX_BLOCKER_CHARS) {
      throw new TowerDoValidationError(
        `tasks[${index}].blockedBy[${entryIndex}] (${key}) is ${entryLength} characters (max ${MAX_BLOCKER_CHARS}) — shorten it`,
      );
    }
  }

  const owner = normalizeOptionalText(input.owner);
  if (owner !== undefined) {
    // Key in the location: `owner` is an element-level limit, so the fold is
    // the only layer that can attribute the rejection to a task.
    normalizeIdentity(owner, `tasks[${index}].owner (${key})`);
  }

  return {
    key,
    subject,
    status: input.status,
    ...(description ? { description } : {}),
    ...(owner === undefined ? {} : { owner }),
    dependsOn,
    ...(scope.length ? { scope } : {}),
    ...(changedFiles.length ? { changedFiles } : {}),
    blockedBy,
  };
}

function assertNoDependencyCycles(
  tasks: readonly ResolvedTowerDoTaskInput[],
): void {
  const dependencies = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): void => {
    if (visiting.has(key))
      throw new TowerDoValidationError(`dependency cycle detected at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of dependencies.keys()) visit(key);
}

/**
 * Dependencies must resolve against BOTH the batched tasks and the existing
 * board (a cross-session mission may depend on a task another agent owns).
 * Mirrors the tower rule "deps must reference known missions" and the
 * reference todo's rule that in_progress/completed require resolved deps
 * (with `blocked` exempt — blocked explicitly means "waiting").
 */
function assertDependenciesAreConsistent(
  tasks: readonly ResolvedTowerDoTaskInput[],
  board: TowerBoardView,
): void {
  // tower_do is a FULL replacement: after the write the board holds exactly
  // `tasks`, because every key not in this batch is removed. Dependency
  // targets must therefore survive in this batch — a pre-write board entry
  // that this write omits is being deleted and cannot satisfy a surviving
  // task's dependency (looking it up on the old board would let a dangling
  // reference through).
  const byKey = new Map<string, { readonly status: TowerDoStatus }>();
  for (const task of tasks) byKey.set(task.key, { status: task.status });
  const boardByKey = new Map(board.tasks.map((task) => [task.key, task]));
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (byKey.has(dependency)) continue;
      const omitted = boardByKey.get(dependency);
      throw new TowerDoValidationError(
        omitted === undefined
          ? `tasks[${index}].dependsOn (${task.key}) references missing task ${dependency} — it must exist on the shared board or in this call`
          : `cannot remove task ${dependency} (this write omits it): ${task.key} still depends on it — keep it in the batch or drop the dependency first`,
      );
    }
    if (task.status !== "in_progress" && task.status !== "completed") continue;
    const unresolved = task.dependsOn.filter(
      (dependency) => byKey.get(dependency)?.status !== "completed",
    );
    if (unresolved.length > 0) {
      throw new TowerDoValidationError(
        `tasks[${index}] (${task.key}) cannot be ${task.status} while dependencies are unresolved: ${unresolved.join(", ")}`,
      );
    }
  }
}

export function taskIsBlocked(
  task: TowerDoTask,
  board: TowerBoardView,
): boolean {
  // Completed means delivered — a stale blockedBy left on a completed task
  // must not keep it visually blocked forever.
  if (task.status === "completed") return false;
  if (task.status === "blocked") return true;
  if (task.blockedBy.length > 0) return true;
  const statusByKey = new Map(
    board.tasks.map((candidate) => [candidate.key, candidate.status]),
  );
  return task.dependsOn.some((key) => statusByKey.get(key) !== "completed");
}

/** Dependency keys that are not yet completed on the board (block reason). */
export function findAllUnresolvedDeps(
  task: TowerDoTask,
  board: TowerBoardView,
): string[] {
  const statusByKey = new Map(
    board.tasks.map((candidate) => [candidate.key, candidate.status]),
  );
  return task.dependsOn.filter((key) => statusByKey.get(key) !== "completed");
}

// ---------------------------------------------------------------------------
// Scope × changedFiles overlap detection (derived, read-only).
//
// P1: turn the (previously decorative) `scope` declaration into a *useful*
// boundary signal. Because changedFiles is a delivery receipt (completed
// only; a worker may set it once, owner/tower may amend) and scope is the
// owner's declared file boundary, we can derive two advisory warnings without
// any git access:
//   1. boundary overlap — a task still in progress/pending has a scope glob
//      that a COMPLETED task's receipt already touched → "files you plan to
//      change were just changed by X";
//   2. scope-vs-scope collision — two in_progress tasks declared overlapping
//      globs → a planning mistake worth surfacing before both start writing.
// Both are pure read derivations (like taskIsBlocked): nobody writes them to
// the board; tower_do_status renders them as row suffixes. Advisory only —
// never a gate, because scope is a self-declared glob and changedFiles is a
// self-reported receipt (authoritative conflict resolution needs git diff
// reads, which is out of TowerDo's scope).
// ---------------------------------------------------------------------------

export interface ScopeConflict {
  /** Task key that has the overlapping declaration (in progress / pending). */
  taskKey: string;
  kind: "overlap" | "collision";
  /** The completed task whose receipt collides (overlap), or the peer task. */
  peerKey: string;
  /** Human-readable summary of what collides. */
  detail: string;
}

/**
 * Minimal file-glob matcher (path segments joined by "/"). Supports:
 *   `*`   — any run of chars within one segment (no "/")
 *   `**`  — any number of segments (may span "/")
 *   `?`   — exactly one char (no "/")
 * No character classes / braces / negation — keep it dependency-free and
 * predictable for the board's advisory use. A glob with no wildcard is
 * treated as an exact path match.
 */
export function globMatchesPath(glob: string, path: string): boolean {
  const g = glob.replaceAll("\\", "/");
  const p = path.replaceAll("\\", "/");
  // Fast path: no wildcards → exact match (both normalized, no trailing
  // slash semantics — a directory glob like "src/" is not special here).
  if (!g.includes("*") && !g.includes("?")) return g === p;

  const gSeg = g.split("/");
  const pSeg = p.split("/");

  const matchFrom = (gi: number, pi: number): boolean => {
    for (;;) {
      if (gi === gSeg.length) return pi === pSeg.length;
      const seg = gSeg[gi];
      if (seg === "**") {
        // `**` eats zero or more path segments: try every split point.
        for (let skip = pi; skip <= pSeg.length; skip += 1) {
          if (matchFrom(gi + 1, skip)) return true;
        }
        return false;
      }
      if (pi >= pSeg.length) return false;
      if (!segmentMatches(seg, pSeg[pi])) return false;
      gi += 1;
      pi += 1;
    }
  };
  return matchFrom(0, 0);
}

function segmentMatches(glob: string, value: string): boolean {
  if (!glob.includes("*") && !glob.includes("?")) return glob === value;
  // Build a regex char by char: escape regex metacharacters first, then map
  // `*` → any non-slash run and `?` → exactly one non-slash char. (Escaping
  // AFTER substituting `?` would escape the generated `.` and turn `?` into
  // a literal dot — a classic order bug.)
  let pattern = "";
  for (const ch of glob) {
    if (ch === "*") pattern += "[^/]*";
    else if (ch === "?") pattern += "[^/]";
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(value);
}

function scopeGlobIntersects(a: string, b: string): boolean {
  // Two globs intersect if any path in one matches the other. For our
  // advisory signal an exact conservative test is enough: either glob
  // literally contains the other's head, or they share a concrete prefix
  // segment. True glob-intersection is undecidable in general; we only need
  // to flag the OBVIOUS collisions a planner would make.
  if (globMatchesPath(a, b)) return true;
  if (globMatchesPath(b, a)) return true;
  const aDir = a.endsWith("/**") ? a.slice(0, -3) : a;
  const bDir = b.endsWith("/**") ? b.slice(0, -3) : b;
  return (
    aDir === bDir || aDir.startsWith(`${bDir}/`) || bDir.startsWith(`${aDir}/`)
  );
}

/**
 * Derive advisory scope conflicts for a board view. Returns one entry per
 * in-progress/pending task that collides with a completed task's receipt
 * (kind "overlap") or with another in-progress task's scope (kind
 * "collision"). Read-only; never throws; renders nothing itself.
 */
export function findScopeConflicts(board: TowerBoardView): ScopeConflict[] {
  const conflicts: ScopeConflict[] = [];
  const completed = board.tasks.filter((t) => t.status === "completed");
  const active = board.tasks.filter(
    (t) => t.status === "in_progress" || t.status === "pending",
  );
  for (const task of active) {
    if (task.scope === undefined || task.scope.length === 0) continue;
    // 1. overlap: a completed task's receipt file sits inside my scope glob.
    for (const done of completed) {
      if (done.key === task.key) continue;
      const files = done.changedFiles ?? [];
      if (files.length === 0) continue;
      const hit = files.find((file) =>
        task.scope!.some((glob) => globMatchesPath(glob, file)),
      );
      if (hit !== undefined) {
        conflicts.push({
          taskKey: task.key,
          kind: "overlap",
          peerKey: done.key,
          detail: `${hit} (touched by ${done.key} ${done.owner ? `@${done.owner}` : ""})`,
        });
      }
    }
  }
  // 2. collision: two in-progress tasks declared intersecting scope globs.
  const inProgress = board.tasks.filter((t) => t.status === "in_progress");
  for (let i = 0; i < inProgress.length; i += 1) {
    for (let j = i + 1; j < inProgress.length; j += 1) {
      const a = inProgress[i];
      const b = inProgress[j];
      if (a.key === b.key) continue;
      const aScope = a.scope ?? [];
      const bScope = b.scope ?? [];
      if (aScope.length === 0 || bScope.length === 0) continue;
      const collides = aScope.some((ga) =>
        bScope.some((gb) => scopeGlobIntersects(ga, gb)),
      );
      if (collides) {
        conflicts.push({
          taskKey: a.key,
          kind: "collision",
          peerKey: b.key,
          detail: `scope ${aScope.join(", ")} × ${bScope.join(", ")}`,
        });
      }
    }
  }
  return conflicts;
}

/** How many `## Scope conflicts` rows the default dashboard renders. The
 *  section grows with the completed history — every receipt that touched a file
 *  the caller's scope names is a row — so the default view keeps the rows that
 *  involve the caller and reports the rest as a count; `view=all` expands. */
export const DASHBOARD_SCOPE_CONFLICT_LINES = 5;

/** Order conflicts for the caller and cut them to `cap`: conflicts involving a
 *  key in `relevantKeys` (the caller's own or coupled tasks) come first, the
 *  rest follow; `hidden` is how many rows the cut dropped. Pure. */
export function sliceScopeConflicts(
  conflicts: readonly ScopeConflict[],
  relevantKeys: ReadonlySet<string>,
  cap: number,
): { shown: ScopeConflict[]; hidden: number } {
  const relevant: ScopeConflict[] = [];
  const rest: ScopeConflict[] = [];
  for (const conflict of conflicts) {
    const involvesCaller =
      relevantKeys.has(conflict.taskKey) || relevantKeys.has(conflict.peerKey);
    (involvesCaller ? relevant : rest).push(conflict);
  }
  const ordered = [...relevant, ...rest];
  const shown = cap >= ordered.length ? ordered : ordered.slice(0, cap);
  return { shown, hidden: ordered.length - shown.length };
}

// ---------------------------------------------------------------------------
// Persisted-state reading (board file entries) + session checkpoint replay.
// The disk board is authoritative; the session checkpoint is a fallback.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Finite epoch-ms guard. JSON admits `1e999` → Infinity (and a corrupt row
 *  can carry NaN); a non-finite timestamp would permanently defeat every
 *  time-based exit (staleness, overdue, message retirement), so it is
 *  rejected exactly like any other malformed field. */
export function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readPersistedTask(
  candidate: unknown,
  index: number,
): ResolvedTowerDoTaskInput | undefined {
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.subject !== "string" ||
    typeof candidate.status !== "string"
  ) {
    return undefined;
  }
  const description =
    typeof candidate.description === "string"
      ? candidate.description
      : undefined;
  const owner =
    typeof candidate.owner === "string" ? candidate.owner : undefined;
  const dependsOn = Array.isArray(candidate.dependsOn)
    ? candidate.dependsOn.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const scope = Array.isArray(candidate.scope)
    ? candidate.scope.filter((item): item is string => typeof item === "string")
    : undefined;
  const changedFiles = Array.isArray(candidate.changedFiles)
    ? candidate.changedFiles.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  const blockedBy = Array.isArray(candidate.blockedBy)
    ? candidate.blockedBy.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  try {
    return normalizeTask(
      {
        key: candidate.key,
        subject: candidate.subject,
        status: candidate.status as TowerDoStatus,
        ...(description ? { description } : {}),
        ...(owner ? { owner } : {}),
        dependsOn,
        ...(scope !== undefined && scope.length ? { scope } : {}),
        ...(changedFiles !== undefined && changedFiles.length
          ? { changedFiles }
          : {}),
        blockedBy,
      },
      index,
    );
  } catch {
    return undefined;
  }
}

export function readPersistedMessage(
  candidate: unknown,
): TowerDoMessage | undefined {
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.to !== "string" ||
    typeof candidate.from !== "string" ||
    typeof candidate.subject !== "string" ||
    typeof candidate.body !== "string" ||
    !isEpochMs(candidate.at)
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    to: candidate.to,
    from: candidate.from,
    subject: candidate.subject,
    body: candidate.body,
    at: candidate.at,
    ...(typeof candidate.taskKey === "string"
      ? { taskKey: candidate.taskKey }
      : {}),
    // readBy arrived later; older persisted messages lack it and stay unread.
    ...(Array.isArray(candidate.readBy)
      ? {
          readBy: candidate.readBy.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    // audience snapshot arrived after readBy; old broadcasts fall back to the
    // current board owners when it is absent.
    ...(Array.isArray(candidate.audience)
      ? {
          audience: candidate.audience.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
  };
}

export function readPersistedFinding(
  candidate: unknown,
): TowerDoFinding | undefined {
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.kind !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.severity !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.from !== "string" ||
    !isEpochMs(candidate.at)
  ) {
    return undefined;
  }
  if (
    !FINDING_KINDS.has(candidate.kind) ||
    !FINDING_SEVERITIES.has(candidate.severity) ||
    !FINDING_STATUSES.has(candidate.status)
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    kind: candidate.kind as FindingKind,
    title: candidate.title,
    severity: candidate.severity as FindingSeverity,
    status: candidate.status as FindingStatus,
    summary: candidate.summary,
    ...(typeof candidate.location === "string"
      ? { location: candidate.location }
      : {}),
    ...(typeof candidate.suggestedFix === "string"
      ? { suggestedFix: candidate.suggestedFix }
      : {}),
    // Optional accountability fields (Layer 1). Absent on legacy rows — an old
    // finding must not be reported as `skipped` because it predates the model.
    ...(typeof candidate.owner === "string" ? { owner: candidate.owner } : {}),
    ...(typeof candidate.reason === "string"
      ? { reason: candidate.reason }
      : {}),
    ...(typeof candidate.snoozeUntil === "number" &&
    Number.isFinite(candidate.snoozeUntil)
      ? { snoozeUntil: candidate.snoozeUntil }
      : {}),
    from: candidate.from,
    at: candidate.at,
  };
}

/** Read a serialized board snapshot (used for session checkpoints). */
function readBoardSnapshot(value: unknown): TowerBoardView | undefined {
  if (!isRecord(value) || value.schemaVersion !== TOWER_DO_SCHEMA_VERSION)
    return undefined;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.findings)
  ) {
    return undefined;
  }
  const tasks: TowerDoTask[] = [];
  const keys = new Set<string>();
  for (const [index, candidate] of value.tasks.entries()) {
    const task = readPersistedTask(candidate, index);
    if (!task || keys.has(task.key)) return undefined;
    keys.add(task.key);
    const updatedAt =
      isRecord(candidate) && isEpochMs(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now();
    tasks.push({ ...cloneNormalizedTask(task), updatedAt });
  }
  const messages: TowerDoMessage[] = [];
  for (const candidate of value.messages) {
    const message = readPersistedMessage(candidate);
    if (!message) return undefined;
    messages.push(message);
  }
  const findings: TowerDoFinding[] = [];
  for (const candidate of value.findings) {
    const finding = readPersistedFinding(candidate);
    if (!finding) return undefined;
    findings.push(finding);
  }
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: value.revision,
    skipped:
      typeof value.skipped === "number" &&
      Number.isSafeInteger(value.skipped) &&
      value.skipped >= 0
        ? value.skipped
        : 0,
    ...(value.incomplete === true ? { incomplete: true } : {}),
    tasks,
    messages,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Bounded checkpoint digest (Layer 4)
// ---------------------------------------------------------------------------

export interface TowerDoCheckpointDigest {
  digestVersion: 1;
  schemaVersion: typeof TOWER_DO_SCHEMA_VERSION;
  revision: number;
  identity: string;
  counts: {
    tasks: { byStatus: Record<TowerDoStatus, number>; open: number };
    findings: FindingCounts;
    unread: number;
  };
  openTasks: {
    key: string;
    status: TowerDoStatus;
    owner?: string;
    subject: string;
  }[];
  findings: {
    id: string;
    severity: FindingSeverity;
    kind: FindingKind;
    title: string;
    owner?: string;
    state: FindingState;
    /** Epoch ms a snoozed finding returns to actionable. Carried so a
     * digest-only restore still derives `snoozed` correctly instead of
     * misreading it as actionable work. */
    snoozeUntil?: number;
  }[];
}

/**
 * Digest-field sanitizer. The digest reader (`readBoardDigest`) requires every
 * rendered field to be a SINGLE line as well as length-bounded
 * (`boundedLine`), while the fold accepts finding `id`/`title`/`owner` strings
 * verbatim. Collapsing line separators before truncating is what keeps the
 * writer from emitting a checkpoint its own reader rejects (which would drop
 * the ENTIRE digest, not one field).
 */
function digestLine(value: string, max: number): string {
  return truncateToAtMost(value.replace(/[\r\n\u2028\u2029]/g, " "), max);
}

/**
 * Bounded projection of a board view for the session transcript. Every field
 * has an upper bound derived from a single constant: `openTasks` <=
 * MAX_TOWER_DO_OPEN_TASKS, `findings` <= MAX_TOWER_DO_OPEN_FINDINGS, counts
 * O(1). No field may grow with board history — a `retiredFindingIds`-style
 * field is exactly the design error this forbids (see CONTRACTS.md).
 */
export function checkpointDigest(
  view: TowerBoardView,
  now: number,
  liveOwners: ReadonlySet<string>,
  identity: string,
): TowerDoCheckpointDigest {
  const byStatus: Record<TowerDoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  };
  for (const task of view.tasks) byStatus[task.status] += 1;
  const openTasks = view.tasks
    .filter((task) => task.status !== "completed")
    .slice(0, MAX_TOWER_DO_OPEN_TASKS)
    .map((task) => ({
      key: task.key,
      status: task.status,
      ...(task.owner === undefined
        ? {}
        : { owner: digestLine(task.owner, MAX_IDENTITY_CHARS) }),
      subject: digestLine(task.subject, MAX_TASK_SUBJECT_CHARS),
    }));
  const findings = findingPressureOrder(view.findings, now, liveOwners)
    .filter(
      (finding) => deriveFindingState(finding, now, liveOwners) !== "closed",
    )
    .slice(0, MAX_TOWER_DO_OPEN_FINDINGS)
    .map((finding) => {
      const state = deriveFindingState(finding, now, liveOwners);
      return {
        // Truncated AND single-lined to exactly what `readBoardDigest`
        // accepts. The fold does NOT bound these fields, so a legacy row with
        // an over-long or multi-line title would otherwise make the writer
        // emit a checkpoint its own reader rejects — silently losing the
        // ENTIRE digest instead of one display field.
        id: digestLine(finding.id, MAX_IDENTITY_CHARS),
        severity: finding.severity,
        kind: finding.kind,
        title: digestLine(finding.title, MAX_FINDING_TITLE_CHARS),
        // Owner and snooze deadline are carried ONLY for the state they belong
        // to. An `accepted` finding whose owner died derives `actionable`, and
        // carrying the dead claim's owner would round-trip into the impossible
        // `open`+`owner` shape (the live fold always clears an owner on open).
        ...(state === "claimed" && finding.owner !== undefined
          ? { owner: digestLine(finding.owner, MAX_IDENTITY_CHARS) }
          : {}),
        state,
        // The reader requires a positive safe integer; `readPersistedFinding`
        // accepts any finite number, so a legacy fractional/deadline value
        // must not be carried through verbatim.
        ...(state === "snoozed" &&
        finding.snoozeUntil !== undefined &&
        Number.isSafeInteger(finding.snoozeUntil) &&
        finding.snoozeUntil > 0
          ? { snoozeUntil: finding.snoozeUntil }
          : {}),
      };
    });
  return {
    digestVersion: 1,
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: view.revision,
    identity,
    counts: {
      tasks: { byStatus, open: view.tasks.length - byStatus.completed },
      findings: findingCountsFor(view, now, liveOwners),
      unread: unreadMessagesToMe(view, identity).length,
    },
    openTasks,
    findings,
  };
}

function readFindingCounts(value: unknown): FindingCounts | undefined {
  if (!isRecord(value)) return undefined;
  const keys: (keyof FindingCounts)[] = [
    "actionable",
    "claimed",
    "snoozed",
    "closed",
    "retired",
  ];
  const counts = {
    actionable: 0,
    claimed: 0,
    snoozed: 0,
    closed: 0,
    retired: 0,
  };
  for (const key of keys) {
    const n = value[key];
    // Counts must be non-negative safe integers: a corrupt/foreign digest must
    // never materialize a fractional or negative count.
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      return undefined;
    counts[key] = n;
  }
  return counts;
}

/** Validate a serialized digest (checkpoint read path). */
export function readBoardDigest(
  value: unknown,
): TowerDoCheckpointDigest | undefined {
  if (!isRecord(value) || value.digestVersion !== 1) return undefined;
  if (value.schemaVersion !== TOWER_DO_SCHEMA_VERSION) return undefined;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return undefined;
  }
  if (typeof value.identity !== "string") return undefined;
  if (!isRecord(value.counts)) return undefined;
  const countsRecord = value.counts;
  const findingCounts = readFindingCounts(countsRecord.findings);
  if (findingCounts === undefined) return undefined;
  if (!isRecord(countsRecord.tasks)) return undefined;
  if (typeof countsRecord.unread !== "number") return undefined;
  if (!Array.isArray(value.openTasks) || !Array.isArray(value.findings))
    return undefined;
  // The digest's whole point is a bounded payload; a restored digest must not
  // be able to exceed those bounds (a corrupt/foreign entry would otherwise
  // materialize an unbounded view).
  if (
    value.openTasks.length > MAX_TOWER_DO_OPEN_TASKS ||
    value.findings.length > MAX_TOWER_DO_OPEN_FINDINGS ||
    !Number.isSafeInteger(countsRecord.unread) ||
    countsRecord.unread < 0
  ) {
    return undefined;
  }
  const byStatus: Record<TowerDoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  };
  for (const status of TOWER_DO_STATUSES) {
    const n = (countsRecord.tasks as Record<string, unknown>).byStatus;
    if (!isRecord(n)) return undefined;
    const value = n[status];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return undefined;
    byStatus[status as TowerDoStatus] = value;
  }
  if (
    typeof countsRecord.tasks.open !== "number" ||
    !Number.isSafeInteger(countsRecord.tasks.open) ||
    countsRecord.tasks.open < 0
  ) {
    return undefined;
  }
  // The count and the per-status tally must agree: a digest whose `open`
  // disagrees with its own `byStatus` is corrupt/foreign, and accepting it
  // would restore a view the writer could never have produced.
  if (
    countsRecord.tasks.open !==
    byStatus.pending + byStatus.in_progress + byStatus.blocked
  ) {
    return undefined;
  }
  const openTasks: TowerDoCheckpointDigest["openTasks"] = [];
  // Length is not the only bound: a foreign digest could carry a
  // newline-injecting key, an oversized subject, or a non-key id. Restored
  // rows render verbatim, so every rendered field must satisfy the same
  // contract the fold enforces — that is what keeps "bounded" true.
  const boundedLine = (value: string, max: number): boolean =>
    textLength(value) <= max && !/[\r\n\u2028\u2029]/.test(value);
  for (const candidate of value.openTasks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.key !== "string" ||
      typeof candidate.subject !== "string" ||
      !isTowerDoStatus(candidate.status) ||
      candidate.status === "completed" ||
      !TASK_KEY_PATTERN.test(candidate.key) ||
      !boundedLine(candidate.subject, MAX_TASK_SUBJECT_CHARS) ||
      (candidate.owner !== undefined &&
        (typeof candidate.owner !== "string" ||
          !boundedLine(candidate.owner, MAX_IDENTITY_CHARS)))
    ) {
      return undefined;
    }
    openTasks.push({
      key: candidate.key,
      status: candidate.status,
      subject: candidate.subject,
      ...(typeof candidate.owner === "string" ? { owner: candidate.owner } : {}),
    });
  }
  const findings: TowerDoCheckpointDigest["findings"] = [];
  for (const candidate of value.findings) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.kind !== "string" ||
      typeof candidate.severity !== "string" ||
      typeof candidate.state !== "string" ||
      !boundedLine(candidate.id, MAX_IDENTITY_CHARS) ||
      !boundedLine(candidate.title, MAX_FINDING_TITLE_CHARS) ||
      (candidate.owner !== undefined &&
        (typeof candidate.owner !== "string" ||
          candidate.owner === "" ||
          !boundedLine(candidate.owner, MAX_IDENTITY_CHARS)))
    ) {
      return undefined;
    }
    if (
      !FINDING_KINDS.has(candidate.kind) ||
      !FINDING_SEVERITIES.has(candidate.severity) ||
      !FINDING_STATES.has(candidate.state)
    ) {
      return undefined;
    }
    if (
      candidate.snoozeUntil !== undefined &&
      (typeof candidate.snoozeUntil !== "number" ||
        !Number.isSafeInteger(candidate.snoozeUntil) ||
        candidate.snoozeUntil <= 0)
    ) {
      return undefined;
    }
    findings.push({
      id: candidate.id,
      kind: candidate.kind as FindingKind,
      severity: candidate.severity as FindingSeverity,
      title: candidate.title,
      state: candidate.state as FindingState,
      ...(typeof candidate.owner === "string" ? { owner: candidate.owner } : {}),
      ...(candidate.snoozeUntil === undefined
        ? {}
        : { snoozeUntil: candidate.snoozeUntil }),
    });
  }
  return {
    digestVersion: 1,
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: value.revision,
    identity: value.identity,
    counts: {
      tasks: { byStatus, open: countsRecord.tasks.open },
      findings: findingCounts,
      unread: countsRecord.unread,
    },
    openTasks,
    findings,
  };
}

/** Rebuild a DISPLAY-ONLY view from a digest (board file missing). It carries
 * open tasks and finding titles verbatim; full content and history are gone,
 * hence `incomplete: true`. The write path never reads this view's revision. */
function digestToView(digest: TowerDoCheckpointDigest): TowerBoardView {
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: digest.revision,
    skipped: 0,
    incomplete: true,
    tasks: digest.openTasks.map((task) => ({
      key: task.key,
      subject: task.subject,
      status: task.status,
      ...(task.owner === undefined ? {} : { owner: task.owner }),
      dependsOn: [],
      blockedBy: [],
      updatedAt: 0,
    })),
    messages: [],
    findings: digest.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      title: finding.title,
      severity: finding.severity,
      // A closed row can only arrive from a foreign/corrupt digest (the writer
      // filters them out); mapping it to `done` keeps it closed instead of
      // resurrecting it as actionable.
      status:
        finding.state === "closed"
          ? "done"
          : finding.state === "claimed" && finding.owner !== undefined
            ? "accepted"
            : finding.state === "snoozed"
              ? "snoozed"
              : "open",
      summary: "",
      from: "",
      at: 0,
      ...(finding.state === "claimed" && finding.owner !== undefined
        ? { owner: finding.owner }
        : {}),
      ...(finding.state === "snoozed" && finding.snoozeUntil !== undefined
        ? { snoozeUntil: finding.snoozeUntil }
        : {}),
    })),
    findingCountsAtCheckpoint: { ...digest.counts.findings },
  };
}

/**
 * Latest valid board checkpoint on a session branch. Pi's `getBranch()` is
 * root-to-leaf (oldest first), so the *last* matching custom entry is the
 * one written by the most recent compact. Taking the first would resurrect
 * todos that a later compact already superseded. Both the legacy full
 * snapshot and the bounded digest (Layer 4) are accepted; a digest restores
 * as an `incomplete` display view.
 */
export function latestBoardCheckpoint(
  entries: readonly {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  }[],
): TowerBoardView | undefined {
  let latest: TowerBoardView | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === TOWER_DO_BOARD_TYPE) {
      const parsed = readBoardSnapshot(entry.data);
      if (parsed !== undefined) latest = parsed;
    } else if (entry.customType === TOWER_DO_BOARD_DIGEST_TYPE) {
      const parsed = readBoardDigest(entry.data);
      if (parsed !== undefined) latest = digestToView(parsed);
    }
  }
  return latest;
}

const REMINDER_TASK_LINE_CAP = 12;

/**
 * Owners currently on the board (task owners), used to scope broadcast
 * visibility/retirement to the people who can actually act on the message.
 */
export function currentOwners(view: TowerBoardView): Set<string> {
  const owners = new Set<string>();
  for (const task of view.tasks) {
    if (task.owner !== undefined) owners.add(task.owner);
  }
  return owners;
}

/**
 * The audience a broadcast addresses: its send-time snapshot when present,
 * else the owners currently on the board (sender excluded). A broadcast is
 * visible to — and retired only after being read by — this set.
 */
function broadcastAudience(
  message: TowerDoMessage,
  view: TowerBoardView,
): Set<string> {
  const owners =
    message.audience ??
    // Delivery/display: exclude the sender by AGENT, not exact string, so a
    // legacy label of the same session is not left as a pending reader it can
    // never ack (a self-broadcast never reaches its own inbox).
    [...currentOwners(view)].filter((owner) => !sameAgent(owner, message.from));
  return new Set(owners);
}

/**
 * Messages addressed to `identity` but sent by someone else. Self-sent
 * broadcasts (`A → all`) are excluded: the sender already knows what they
 * wrote, and counting them would make a node's own broadcast look like new
 * inbound traffic in its own inbox / reminder / widget badge.
 *
 * A broadcast is only "for" an identity when that identity is still in the
 * broadcast's audience (send-time snapshot, or current owners as fallback):
 * an owner who joined after the broadcast — or left before it was sent — was
 * never actually addressed by it. Showing every historical broadcast to
 * every identity would surface finished rounds as phantom "UNREAD" traffic
 * to newcomers (a session that opens after a test round ended sees stale
 * "please reply" broadcasts from identities that have left).
 */
export function messagesToMe(
  view: TowerBoardView,
  identity: string,
): TowerDoMessage[] {
  return view.messages.filter((message) => {
    if (sameAgent(message.from, identity)) return false;
    if (sameAgent(message.to, identity)) return true;
    if (message.to !== "all") return false;
    return identitySetHas(broadcastAudience(message, view), identity);
  });
}

/** Messages to `identity` that it has not yet acked (read). */
export function unreadMessagesToMe(
  view: TowerBoardView,
  identity: string,
): TowerDoMessage[] {
  return messagesToMe(view, identity).filter(
    (message) => !identityListHas(message.readBy, identity),
  );
}

/** True when every addressee of the message has read it (all → every owner). */
export function isMessageFullyRead(
  message: TowerDoMessage,
  view: TowerBoardView,
): boolean {
  const readBy = message.readBy ?? [];
  if (message.to === "all") {
    // The sender already knows what they wrote (self-sends never reach their
    // own inbox), so they cannot ack their own broadcast and must not count
    // as a pending reader — otherwise broadcasts would never retire. The
    // audience (send-time snapshot, else current owners) is exactly who the
    // broadcast addressed and who `messagesToMe` surfaces it to.
    const owners = broadcastAudience(message, view);
    if (owners.size === 0) return true; // nobody left to read it
    // Orphaned broadcast: every audience member who has not yet read has
    // since LEFT the board (the board was cleared / rebuilt under new
    // owners). Nobody can ever read it now — treat as fully read so a
    // finished broadcast round cannot pin the retention budget forever.
    const pendingReaders = [...owners].filter(
      (owner) => !identityListHas(readBy, owner),
    );
    if (pendingReaders.length === 0) return true;
    const pendingStillHere = pendingReaders.some(
      (owner) =>
        view.tasks.some(
          (task) => task.owner !== undefined && sameAgent(task.owner, owner),
        ) || sameAgent(owner, message.to),
    );
    if (!pendingStillHere) return true;
    return false;
  }
  // Addressed message: fully read once the recipient acks. `tower` is the
  // reserved orchestrator identity and owns no task by design, so the
  // ownership proxy below would classify every message to it as undeliverable
  // and let the retention budget drop one that is still unread. Its read state
  // is the ack list alone.
  if (message.to === TOWER_IDENTITY) return identityListHas(readBy, message.to);
  // Anyone else: if the recipient is no longer an owner on the board (they
  // left / the board was rebuilt), nobody can ever read it — treat it as fully
  // read so orphan messages do not accumulate in the folded view forever.
  // Reachability is proxied by TASK OWNERSHIP (CONTRACTS.md
  // "undeliverable/orphaned messages auto-retire"); a recipient admitted only
  // for recent board activity may therefore retire earlier than the age valve,
  // which stays the bound.
  const recipientStillHere = view.tasks.some(
    (task) => task.owner !== undefined && sameAgent(task.owner, message.to),
  );
  if (!recipientStillHere) return true;
  return identityListHas(readBy, message.to);
}

// ---------------------------------------------------------------------------
// Finding exit mechanism (Layer 1/2) — pure derivation, never writes.
// ---------------------------------------------------------------------------

export type FindingState = "actionable" | "claimed" | "snoozed" | "closed";

export const FINDING_STATES: ReadonlySet<string> = new Set([
  "actionable",
  "claimed",
  "snoozed",
  "closed",
]);

export function isFindingClosed(finding: TowerDoFinding): boolean {
  return finding.status === "done" || finding.status === "rejected";
}

/**
 * Derived lifecycle state. `accepted` only counts as `claimed` while its owner
 * is alive; a dead owner's claim collapses back to `actionable` so the finding
 * can be taken over. Liveness never means "resolved" — only the terminal
 * statuses do (see CONTRACTS.md).
 */
export function deriveFindingState(
  finding: TowerDoFinding,
  now: number,
  liveOwners: ReadonlySet<string>,
): FindingState {
  if (isFindingClosed(finding)) return "closed";
  if (finding.status === "snoozed") {
    return finding.snoozeUntil !== undefined && finding.snoozeUntil > now
      ? "snoozed"
      : "actionable";
  }
  if (finding.status === "accepted") {
    return finding.owner !== undefined && liveOwners.has(finding.owner)
      ? "claimed"
      : "actionable";
  }
  return "actionable";
}

/**
 * Age past which a closed finding leaves the DEFAULT view (it stays in the
 * fold and stays readable via `view=all` / `findingId`). `at` is the
 * transition time, set by the close event, so this is the close age.
 */
export function findingViewRetired(
  finding: TowerDoFinding,
  now: number,
): boolean {
  return isFindingClosed(finding) && now - finding.at > FINDING_CLOSE_GRACE_MS;
}

/** Keep every non-closed finding; view-retire closed ones past the grace. This
 * is the Layer 2 "default view" primitive: the dashboard's own state filter is
 * narrower today, but retirement must stay the outer bound so a future list
 * change cannot silently un-retire closed rows. */
export function retainFindings(
  findings: readonly TowerDoFinding[],
  now: number,
): TowerDoFinding[] {
  return findings.filter((finding) => !findingViewRetired(finding, now));
}

export interface FindingCounts {
  actionable: number;
  claimed: number;
  snoozed: number;
  closed: number;
  retired: number;
}

export function summarizeFindings(
  findings: readonly TowerDoFinding[],
  now: number,
  liveOwners: ReadonlySet<string>,
): FindingCounts {
  const counts: FindingCounts = {
    actionable: 0,
    claimed: 0,
    snoozed: 0,
    closed: 0,
    retired: 0,
  };
  for (const finding of findings) {
    const state = deriveFindingState(finding, now, liveOwners);
    if (state === "actionable") counts.actionable += 1;
    else if (state === "claimed") counts.claimed += 1;
    else if (state === "snoozed") counts.snoozed += 1;
    else if (findingViewRetired(finding, now)) counts.retired += 1;
    else counts.closed += 1;
  }
  return counts;
}

/** Non-closed findings a board carries — the budget's charge. */
export function openFindingCount(
  findings: readonly TowerDoFinding[],
): number {
  return findings.filter((finding) => !isFindingClosed(finding)).length;
}

/** Finding counts for a possibly digest-restored view. Only `closed`/`retired`
 *  are taken from the checkpoint: a digest carries no closed rows, so
 *  recomputing them would report 0 as fact. `actionable`/`claimed`/`snoozed`
 *  are always recomputed — liveness and snooze deadlines move on, and a frozen
 *  count would contradict the per-row state rendered on the same screen. */
export function findingCountsFor(
  view: TowerBoardView,
  now: number,
  liveOwners: ReadonlySet<string>,
): FindingCounts {
  const fresh = summarizeFindings(view.findings, now, liveOwners);
  const carried = view.findingCountsAtCheckpoint;
  return carried === undefined
    ? fresh
    : { ...fresh, closed: carried.closed, retired: carried.retired };
}

/** Overdue actionable: waiting longer than the close grace. */
function findingOverdue(
  finding: TowerDoFinding,
  now: number,
  state: FindingState,
): boolean {
  return state === "actionable" && now - finding.at > FINDING_CLOSE_GRACE_MS;
}

/**
 * Pressure order for the list: overdue actionable first (oldest of those
 * first — they are the rows the old `at DESC` page hid forever), then plain
 * actionable (newest first), claimed, snoozed (soonest deadline first), then
 * closed (newest first). Pure; the caller applies the page cut and discloses
 * it.
 *
 * "Oldest" is measured from `at`, the LAST transition (a claim, a snooze, a
 * reopen), not from first filing: a re-opened or re-claimed row ranks as
 * freshly active, which is what a reader triaging debt needs. There is
 * deliberately no separate `filedAt` (a persisted field nothing else reads).
 */
export function findingPressureOrder(
  findings: readonly TowerDoFinding[],
  now: number,
  liveOwners: ReadonlySet<string>,
): TowerDoFinding[] {
  const rank = (finding: TowerDoFinding): number => {
    const state = deriveFindingState(finding, now, liveOwners);
    if (findingOverdue(finding, now, state)) return 0;
    if (state === "actionable") return 1;
    if (state === "claimed") return 2;
    if (state === "snoozed") return 3;
    return 4;
  };
  return [...findings].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) {
      const ua = a.snoozeUntil ?? 0;
      const ub = b.snoozeUntil ?? 0;
      if (ua !== ub) return ua - ub;
    }
    // Overdue and claimed: longest-waiting first. Everything else: newest.
    if (ra === 0 || ra === 2) return a.at - b.at;
    return b.at - a.at;
  });
}

function ageDays(ms: number): number {
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Error message when filing a NEW finding must be rejected, else undefined.
 * Two independent bars, both executable by the caller:
 *  - close obligation: a live owner holding an overdue claimed finding;
 *  - budget: all non-closed findings (snoozed included) at the cap.
 * The budget error names the highest-pressure rows, because the failure the
 * old model produced was precisely that the backlog was invisible.
 */
export function findingBudgetRejection(
  findings: readonly TowerDoFinding[],
  now: number,
  liveOwners: ReadonlySet<string>,
  caller: string,
): string | undefined {
  const owed = findings.filter(
    (finding) =>
      deriveFindingState(finding, now, liveOwners) === "claimed" &&
      finding.owner !== undefined &&
      // EXACT owner match, like every other permission/obligation check:
      // aliasing here would make a bucket sibling carry (or escape) a claim
      // that is not theirs (CONTRACTS.md "permission is exact").
      finding.owner === caller &&
      now - finding.at > FINDING_CLOSE_GRACE_MS,
  );
  if (owed.length > 0) {
    return (
      `you hold ${owed.length} claimed finding(s) past the ${String(Math.round(FINDING_CLOSE_GRACE_MS / 86_400_000))}d close grace ` +
      `(${owed.map((finding) => finding.id).join(", ")}) — close (done|rejected) or snooze them before filing another`
    );
  }
  const open = findings.filter((finding) => !isFindingClosed(finding));
  if (open.length >= MAX_TOWER_DO_OPEN_FINDINGS) {
    const pressing = findingPressureOrder(open, now, liveOwners)
      .slice(0, 5)
      .map(
        (finding) =>
          `${finding.id} (${String(ageDays(now - finding.at))}d, ${finding.severity}/${finding.kind})`,
      );
    return (
      `non-closed findings are at the budget (${String(MAX_TOWER_DO_OPEN_FINDINGS)}): close one first — a snooze still occupies a slot, so it frees nothing.\n` +
      `  most pressing: ${pressing.join(", ")}\n` +
      `  remedy: tower_do_talk action=finding findingIds=[…] status=done|rejected reason=…`
    );
  }
  return undefined;
}

/**
 * Retire fully-read history: keep at most `retention` fully-read messages
 * (oldest first) once the folded set exceeds the budget. Unread and
 * partially-read messages always survive the budget — retiring them would
 * silently swallow traffic a peer has not seen — but an unread message nobody
 * acks still leaves the DEFAULT view after `MESSAGE_PENDING_RETIRE_MS` (the
 * age valve; disk and `inbox all` keep it). retention 0 = keep everything
 * (legacy). Returns a NEW messages array; the input view is not mutated.
 */
export function retainMessages(
  messages: readonly TowerDoMessage[],
  view: TowerBoardView,
  retention: number,
  now: number = Date.now(),
): TowerDoMessage[] {
  const fresh =
    retention <= 0
      ? [...messages]
      : messages.filter(
          (message) =>
            isMessageFullyRead(message, view) ||
            now - message.at <= MESSAGE_PENDING_RETIRE_MS,
        );
  if (retention <= 0 || fresh.length <= retention) return fresh;
  const done = fresh.filter((message) => isMessageFullyRead(message, view));
  const keepDone = Math.max(0, retention - (fresh.length - done.length));
  const surplus = done.length - keepDone;
  if (surplus <= 0) return fresh;
  const retired = new Set(done.slice(0, surplus).map((message) => message.id));
  return fresh.filter((message) => !retired.has(message.id));
}

// ---------------------------------------------------------------------------
// Activity + presence (derived, read-only — never written to the board).
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  kind: "task" | "message" | "finding";
  by: string;
  at: number;
  glyph: string;
  /** Human summary: task key / recipient / finding title. */
  detail: string;
  /** Structured task key for task events (undefined otherwise). `detail` is a
   * display string (`key: subject`) and must never be parsed back — the
   * stale-owner clock keys on this field. */
  taskKey?: string;
}

const ACTIVITY_GLYPHS: Record<TowerDoStatus, string> = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
  blocked: "✗",
};

/**
 * Parse one raw board-log line (JSON event) into a compact activity entry.
 * Foreign / corrupt lines return undefined (caller skips them).
 */
export function parseActivityLine(line: string): ActivityEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const kind = record.kind;
  const at = isEpochMs(record.at) ? record.at : undefined;
  const by = typeof record.by === "string" ? record.by : undefined;
  if (at === undefined || by === undefined) return undefined;
  if (kind === "task") {
    // Same shape test as `readEvent` (board.ts): a task line whose `op` is
    // not upsert/remove is skipped by the fold, so it must not count as
    // ownership activity here either — otherwise presence and the fold read
    // two different clocks (ARCHITECTURE.md "one clock, not two"), and a
    // garbage line would extend an owner's takeover protection.
    if (record.op !== "upsert" && record.op !== "remove") return undefined;
    const task = record.task as Record<string, unknown> | undefined;
    const key = typeof record.key === "string" ? record.key : undefined;
    if (record.op === "remove") {
      return {
        kind: "task",
        by,
        at,
        glyph: "🗑",
        detail: `${key ?? "?"} removed`,
        ...(key === undefined ? {} : { taskKey: key }),
      };
    }
    if (task && typeof task.subject === "string") {
      const status = isTowerDoStatus(task.status)
        ? (task.status as TowerDoStatus)
        : "pending";
      return {
        kind: "task",
        by,
        at,
        glyph: ACTIVITY_GLYPHS[status],
        detail: `${key ?? "?"}: ${task.subject}`, // could be added or updated
        ...(key === undefined ? {} : { taskKey: key }),
      };
    }
    return undefined;
  }
  if (kind === "message") {
    // Validate with the SAME reader the fold uses, so a partially-formed
    // message cannot show up as activity while the fold skips it.
    const message = readPersistedMessage(record.message);
    if (message !== undefined) {
      const readBy = message.readBy ?? [];
      // An ack re-emission (reader appends their id to readBy) is NOT a new
      // message: it is traffic the *reader* generated. Render it as a read
      // notice, keyed to the reader, so activity doesn't look like the
      // reader re-sent the message.
      if (by !== message.from && identityListHas(readBy, by)) {
        return {
          kind: "message",
          by,
          at,
          glyph: "👁",
          detail: `read →${message.to}: ${message.subject}`, // by = reader
        };
      }
      return {
        kind: "message",
        by,
        at,
        glyph: "✉",
        detail: `→${message.to}: ${message.subject}`,
      };
    }
    return undefined;
  }
  if (kind === "finding") {
    const finding = readPersistedFinding(record.finding);
    if (finding !== undefined) {
      return {
        kind: "finding",
        by,
        at,
        glyph: "⚑",
        detail: `[${finding.severity}] ${finding.title}`,
      };
    }
    return undefined;
  }
  return undefined;
}

/** Compact relative time for activity/presence lines (test-friendly). */
export function relativeTime(now: number, at: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatActivityEntry(entry: ActivityEntry, now: number): string {
  const rel = relativeTime(now, entry.at);
  return `${entry.by} · ${rel} · ${entry.glyph} ${entry.detail}`;
}

/**
 * Gap (ms) between adjacent activity entries that marks a session break —
 * the feed renders a separator line so a reader can tell "several events in
 * one sitting" from "several sittings" without timestamps on every row.
 * Pure read derivation; no schema, no writes.
 */
export const SESSION_BREAK_GAP_MS = 30 * 60_000;

/**
 * Latest-write summary of an activity feed: the identity and time of the
 * newest entry, for the status header's "last updated N ago by X" line.
 */
export function latestActivity(
  entries: readonly ActivityEntry[],
): { by: string; at: number } | undefined {
  let latest: { by: string; at: number } | undefined;
  for (const entry of entries) {
    if (latest === undefined || entry.at > latest.at) {
      latest = { by: entry.by, at: entry.at };
    }
  }
  return latest;
}

/**
 * Render an activity feed (already newest-first) with session-break
 * separators: between two consecutive entries whose timestamps differ by
 * more than SESSION_BREAK_GAP_MS a `── session break ──` line is inserted.
 * Entries within one burst render as plain lines.
 */
export function formatActivityFeed(
  entries: readonly ActivityEntry[],
  now: number,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (i > 0 && entries[i - 1].at - entry.at > SESSION_BREAK_GAP_MS) {
      lines.push("── session break ──");
    }
    lines.push(`- ${formatActivityEntry(entry, now)}`);
  }
  return lines;
}

/** How long before an owner with no activity is flagged idle (ms). */
const PRESENCE_IDLE_MS = 10 * 60_000;

/**
 * Identities addressable via tower_do_talk send: current task owners plus
 * anyone who appears in recent board activity. Owners alone would strand a
 * peer whose tasks are all completed (no longer an owner) right when
 * hand-off coordination needs to reach them — their historical bylines keep
 * them reachable.
 */
export function knownIdentities(
  view: TowerBoardView,
  entries: readonly ActivityEntry[],
): Set<string> {
  const known = new Set([
    ...currentOwners(view),
    ...entries.map((entry) => entry.by),
  ]);
  known.delete(TOWER_IDENTITY);
  return known;
}

export interface PresenceLine {
  identity: string;
  lastSeenAt?: number;
  ownerOf: string[];
  /** True when the identity has NO activity record at all (freshly assigned). */
  unstarted: boolean;
  /** Set when the identity has been active before but has gone quiet. */
  idle: boolean;
}

/**
 * Derive who-is-around from parsed activity (never writes to the board).
 * Two distinct signals, kept apart so a coordinator can act correctly:
 *   - unstarted: owns work but has NO activity record (freshly assigned, or
 *     the board was re-planned under a new identity) — NOT a stall, the
 *     owner may simply not have begun;
 *   - idle: HAS activity but nothing for PRESENCE_IDLE_MS — a real stall a
 *     coordinator may message about or re-claim.
 */
export function derivePresence(
  entries: readonly ActivityEntry[],
  tasks: readonly TowerDoTask[],
  now: number,
): PresenceLine[] {
  const lastSeen = new Map<string, number>();
  for (const entry of entries) {
    const prior = lastSeen.get(entry.by);
    if (prior === undefined || entry.at > prior)
      lastSeen.set(entry.by, entry.at);
  }
  const ownerOf = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.owner === undefined) continue;
    const list = ownerOf.get(task.owner) ?? [];
    list.push(task.key);
    ownerOf.set(task.owner, list);
  }
  const identities = new Set<string>([...lastSeen.keys(), ...ownerOf.keys()]);
  // A legacy row merges into the current label of its bucket only when exactly
  // ONE current label carries that bucket: `sameAgent` is not transitive
  // (legacy ↔ each sibling), so grouping must stay keyed, never transitive —
  // otherwise two distinct sessions of one bucket would render as one agent,
  // which is the collision this change removes.
  const currentLabels = [...identities].filter((label) =>
    CURRENT_SESSION_LABEL.test(label),
  );
  const displayLabel = (label: string): string => {
    const legacy = LEGACY_SESSION_LABEL.exec(label);
    if (legacy === null) return label;
    const matches = currentLabels.filter(
      (current) => CURRENT_SESSION_LABEL.exec(current)?.[1] === legacy[1],
    );
    return matches.length === 1 ? matches[0] : label;
  };
  const lines: PresenceLine[] = [];
  for (const raw of identities) {
    const identity = displayLabel(raw);
    const existing = lines.find((line) => line.identity === identity);
    const ownerOfKeys = ownerOf.get(raw) ?? [];
    const lastSeenAt = lastSeen.get(raw);
    if (existing !== undefined) {
      for (const key of ownerOfKeys)
        if (!existing.ownerOf.includes(key)) existing.ownerOf.push(key);
      if (
        lastSeenAt !== undefined &&
        (existing.lastSeenAt === undefined || lastSeenAt > existing.lastSeenAt)
      )
        existing.lastSeenAt = lastSeenAt;
      continue;
    }
    const unstarted = ownerOfKeys.length > 0 && lastSeenAt === undefined;
    const idle =
      ownerOfKeys.length > 0 &&
      lastSeenAt !== undefined &&
      now - lastSeenAt > PRESENCE_IDLE_MS;
    lines.push({ identity, lastSeenAt, ownerOf: ownerOfKeys, unstarted, idle });
  }
  // Derived flags are recomputed after merging (a merged row may have gained
  // the activity or the ownership the first pass did not see).
  for (const line of lines) {
    const hasOwnership = line.ownerOf.length > 0;
    line.unstarted = hasOwnership && line.lastSeenAt === undefined;
    line.idle =
      hasOwnership &&
      line.lastSeenAt !== undefined &&
      now - line.lastSeenAt > PRESENCE_IDLE_MS;
  }
  lines.sort((a, b) => {
    const aAt = a.lastSeenAt ?? 0;
    const bAt = b.lastSeenAt ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return a.identity.localeCompare(b.identity);
  });
  return lines;
}

/** Idle threshold after which the owner of a non-completed task becomes
 * adoptable/removable by anyone (see staleTaskClaims). Deliberately separate
 * from SESSION_BREAK_GAP_MS (30 min), which now serves presence/idle display
 * only: ownership must not look dead just because a 30-minute session break
 * happened, and it must not survive 30 minutes of unrelated chatter either. */
export const OWNER_TAKEOVER_MS = TASK_CLAIM_STALE_MS;

/** Human form of the takeover window, derived from the constant so the
 * user-facing hint can never drift from the permission it describes. */
export function formatTakeoverWindow(
  idleMs: number = OWNER_TAKEOVER_MS,
): string {
  const minutes = Math.round(idleMs / 60_000);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours)
    ? `${String(hours)}h`
    : `${String(minutes)} min`;
}

/**
 * Every displaceable claim on the board: `owner\u0000taskKey` pairs whose claim
 * is dead. Staleness is charged to activity **on that task**: unrelated board
 * activity (messages, or work on other task keys) does NOT immunize a stale
 * row — the former `lastSeen` was board-global, so one status update anywhere
 * protected every stale task that owner held. When the owner has no activity
 * on the task, the task's own `updatedAt` is the clock, so a freshly assigned
 * row stays protected ("just assigned, not begun yet").
 *
 * The unit is the CLAIM, never the owner. Returning a per-taskKey set is what
 * keeps the derivation and its consumers in step: a set of owner labels cannot
 * express "this owner is dead on this row but alive on that one", so an owner
 * holding one long-idle row plus one freshly touched row would be reported
 * wholesale and have BOTH displaced — silently losing the live row, the very
 * outcome the per-task clock exists to prevent. Consumers (`isStaleClaim`) must
 * therefore ask about the exact row they are about to touch.
 *
 * Pure read derivation; never writes to the board.
 *
 * `dependsOn`/`blockedBy` references are not visible in an `ActivityEntry`
 * (its `detail` is the task key for task events), so relevance is "this owner
 * wrote this task event". A dependency edit is a change to the depended-on
 * row, which that row's own owner clock already covers.
 */
export function staleTaskClaims(
  entries: readonly ActivityEntry[],
  tasks: readonly TowerDoTask[],
  now: number,
  idleMs: number = OWNER_TAKEOVER_MS,
  /** Identities with a fresh liveness-sidecar record (`live/`,
   * LIVE_WINDOW_MS): a running process is never stale, however quiet it has
   * been on the board — the heartbeat exists precisely to separate "alive
   * but heads-down" from "exited / crashed". Callers who cannot read the
   * sidecar should pass EVERY owner here: no liveness data must disable
   * the exception, not loosen it. */
  liveOwners: ReadonlySet<string> = new Set(),
): Set<string> {
  const stale = new Set<string>();
  // No activity data at all (unreadable / garbage log) must disable the
  // exception, not loosen it: the updatedAt fallback below is only sound
  // when the log EXISTS but simply has no events for that owner+task.
  if (entries.length === 0) return stale;
  // Task-relevant clock, keyed by owner + structured task key (`detail` is a
  // display string and would never match; see ActivityEntry.taskKey).
  const taskActivity = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "task" || entry.taskKey === undefined) continue;
    const key = claimKey(entry.by, entry.taskKey);
    const prior = taskActivity.get(key);
    if (prior === undefined || entry.at > prior)
      taskActivity.set(key, entry.at);
  }
  for (const task of tasks) {
    // Exact label again: a bucket sibling's activity or heartbeat must not
    // decide whether THIS owner is stale. A legacy row therefore goes stale by
    // its own label's silence and becomes adoptable through the normal window —
    // that is the documented remedy, predictable rather than guessed.
    if (
      task.owner === undefined ||
      task.status === "completed" ||
      liveOwners.has(task.owner)
    )
      continue;
    const quietSince =
      taskActivity.get(claimKey(task.owner, task.key)) ?? task.updatedAt;
    if (now - quietSince > idleMs) stale.add(claimKey(task.owner, task.key));
  }
  return stale;
}

/** Key of one claim in the `staleTaskClaims` set — the exact (owner, task)
 * pair the guard is about to touch, so a stale row can never speak for a
 * sibling row the same owner is still working on. NUL is the separator
 * because it cannot appear in a validated identity or task key. */
export function claimKey(owner: string, taskKey: string): string {
  return `${owner}\u0000${taskKey}`;
}

/** Is THIS row's claim displaceable? `owner` defaults to the row's own owner,
 * so a caller can ask about a stored task without unpacking it. */
export function isStaleClaim(
  staleClaims: ReadonlySet<string>,
  owner: string | undefined,
  taskKey: string,
): boolean {
  return owner !== undefined && staleClaims.has(claimKey(owner, taskKey));
}

/** Remediation hint attached to a full open-task budget (see writeBoardSnapshot):
 * what the caller can free, and how a board holding nothing but completed rows
 * is compacted. */
const OPEN_TASK_BUDGET_HINT =
  ' — free a slot by omitting your own or an unowned task, or compact a finished board with an as: "tower" write that replays only the rows to keep';

/** What a caller can still do about a row it is not allowed to touch.
 *
 * Both guard sites call this, and which branches can be reached differs: the
 * removal guard `continue`s for a stale non-completed row, so a rejection there
 * is always a completed row or a live claim; the update guard additionally
 * rejects adoption-with-edits on a stale row. `status` therefore decides the
 * remedy and the stale-claim set only decides whether there is one to name — a
 * completed row never enters that set (a receipt is not displaceable), so its
 * text must not depend on it. */
function staleClaimHint(
  task: TowerDoTask,
  staleClaims: ReadonlySet<string>,
): string {
  if (task.status === "completed")
    return ' (a completed task stays with its owner — only that owner or an as: "tower" write that replays the rows to keep may drop it; a peer cannot forge a receipt)';
  if (!isStaleClaim(staleClaims, task.owner, task.key)) return "";
  return ` (owner idle past the ${formatTakeoverWindow()} takeover window: adopt it by setting owner to yourself and changing nothing else, then edit in a second write — or remove it)`;
}

/** Heartbeat cadence for the per-session liveness sidecar (`live/<sessionId>.json`, see index.ts): each session rewrites its own record on this cadence. */
export const LIVE_HEARTBEAT_MS = 30_000;

/** Liveness window: a sidecar record older than this no longer counts as
 * running. A clean session exit deletes its file; a crashed one is expired
 * after four missed heartbeats. Deliberately much shorter than the old
 * board-activity window (SESSION_BREAK_GAP_MS): liveness now tracks running
 * processes, not last board interaction. */
export const LIVE_WINDOW_MS = 2 * 60_000;

/** Records older than this are unlinked by readers (best-effort GC of files
 * left behind by crashed sessions). Far beyond the window so a slow
 * heartbeat or modest clock skew cannot get a live session's file pruned. */
export const LIVE_PRUNE_MS = 10 * 60_000;

/** One per-session liveness sidecar record: `live/<identity>.<sessionId>.json`. */
export interface LiveRecord {
  identity: string;
  at: number;
  /** Extra owner labels this session has written as (`as`). Used by the
   *  takeover gate; not counted by `liveSessionCount`. */
  aliases?: string[];
}

/** Parse the raw JSON content of a liveness sidecar file. Corrupt or
 * foreign content returns undefined (caller skips the file). */
export function parseLiveRecord(raw: string): LiveRecord | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const { identity, at } = record;
  if (typeof identity !== "string" || identity.trim() === "") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const aliases = readLiveAliases(record.aliases);
  return aliases === undefined ? { identity, at } : { identity, at, aliases };
}

function readLiveAliases(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_TOWER_DO_ALIASES) break;
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id === "" || id === "all" || textLength(id) > MAX_IDENTITY_CHARS)
      continue;
    if (identitySetHas(seen, id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length === 0 ? undefined : out;
}

/** Identities a fresh sidecar record should protect from takeover:
 *  the session identity plus any `as` aliases. `live N` still counts
 *  `identity` only. */
export function liveOwnerIdentities(record: LiveRecord): string[] {
  if (record.aliases === undefined || record.aliases.length === 0)
    return [record.identity];
  const ids = [record.identity];
  const seen = new Set([record.identity]);
  for (const alias of record.aliases) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    ids.push(alias);
  }
  return ids;
}

/**
 * Count sessions currently running against this board: distinct identities
 * seen fresh in the liveness sidecar within the window, plus `self` (own
 * record write failed / has not landed yet — self is by definition running).
 * Pure read derivation over the sidecar; never touches the board.
 */
export function liveSessionCount(
  records: readonly LiveRecord[],
  self: string,
  now: number,
  windowMs: number = LIVE_WINDOW_MS,
): number {
  const live = new Set<string>();
  for (const record of records) {
    if (record.at >= now - windowMs) live.add(record.identity);
  }
  if (self !== "") live.add(self);
  return live.size;
}

/** Header segment `live N`. Defaults keep the empty-segment gate on plain text. */
export function formatLiveSegment(
  count: number,
  em: (n: number) => string = String,
  label: (s: string) => string = (s) => s,
): string {
  if (count < 1) return "";
  return label("live ") + em(count);
}

export type BoardProgressCount =
  | "title"
  | "open"
  | "blocked"
  | "unread"
  | "sep";

/** Header progress segment: `TowerDo N open`, plus `· M blocked` / `· K msg`
 * when present. Tracks remaining work only — completed tasks never count, so
 * the glance follows the current workload instead of growing monotonically
 * with board lifetime (the old `x/y done` counted retired-in-place completed
 * rows pinned by the owner guard / dependsOn). The board `revision` is
 * deliberately not shown here: it is a monotonic CAS token, not a metric.
 * Hidden when nothing is open and no unread mail; defaults keep the
 * empty-segment gate on plain text. */
export function formatBoardProgress(
  open: number,
  blocked: number,
  unread: number,
  em: (n: number, which: BoardProgressCount) => string = String,
  label: (s: string, which: BoardProgressCount) => string = (s) => s,
): string {
  if (open < 1 && unread < 1) return "";
  let out = label("TowerDo", "title");
  let hasPart = false;
  const sep = () => (hasPart ? label(" · ", "sep") : " ");
  if (open > 0) {
    out += sep() + em(open, "open") + label(" open", "open");
    hasPart = true;
    if (blocked > 0) {
      out += sep() + em(blocked, "blocked") + label(" blocked", "blocked");
    }
  }
  if (unread > 0) {
    out += sep() + em(unread, "unread") + label(" msg", "unread");
  }
  return out;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True for status lines that describe the caller's own session. Prefixes
 * (header, presence `(me)`, activity byline, messages section) are owned
 * by the renderer. The task-line alternative looks for ` @<id> (me)`
 * before a renderer suffix (` ←` / ` [` / ` —`) or EOL: a mention in the
 * middle of a subject, or on a line that still has a real other owner
 * after it, does not match. An *unowned* subject that itself ends with
 * that token can still match — closing that needs structured line marks,
 * not a tighter regex.
 *
 * Keep in sync with the renderers in index.ts (status sections, presence
 * `(me)` label, owner `(me)` suffix, activity feed format).
 */
export function isCallerLine(line: string, caller: string): boolean {
  if (caller === "") return false;
  const id = escapeRegExp(caller);
  return new RegExp(
    [
      `^TowerDo shared board — identity ${id}, revision`,
      `^- ${id} \\(me\\) —`,
      `^- ${id} · `,
      `^- [◐✓○✗] .* @${id} \\(me\\)(?= ←| \\[| —|$)`,
      `^## Messages for ${id} \\(`,
    ].join("|"),
  ).test(line);
}

export function formatPresenceLine(line: PresenceLine, now: number): string {
  const seen =
    line.lastSeenAt === undefined
      ? "no recent activity"
      : `last seen ${relativeTime(now, line.lastSeenAt)}`;
  const owned =
    line.ownerOf.length > 0 ? ` (owns ${line.ownerOf.join(", ")})` : "";
  const state = line.idle ? " ⚠ idle" : line.unstarted ? " (not started)" : "";
  return `${line.identity} — ${seen}${owned}${state}`;
}

/** Why a peer-owned unfinished task is in the caller's attention set. */
export type NeedsReason = "await" | "blocking" | "scope" | "unread";

/** One `needs` row: a peer task plus why the caller must still look at it. */
export interface NeedsTask {
  task: TowerDoTask;
  reason: NeedsReason;
}

/** A board rendered for one caller in three unfinished layers plus receipts.
 *
 *  `mine`  — unfinished tasks the caller owns.
 *  `needs` — peer-owned unfinished tasks the caller is coupled to: its own
 *            unfinished work awaits them (`await`), a message to the caller
 *            threads under them (`unread`), or they await the caller's
 *            unfinished work (`blocking`).
 *  `other` — the remaining unfinished tasks.
 *  `completed` — receipts, rendered as a compact key ledger, never as rows.
 *
 *  Order inside every layer is recency-first (`updatedAt` DESC, `key` ASC as
 *  the tiebreaker — one batch write stamps several rows with one `updatedAt`),
 *  so a cap cannot hide the newest work behind arbitrary order. Identity match
 *  is exact (`alice` ≠ `alice-2`); unowned is not mine. Does not mutate
 *  `tasks`. */
export interface TaskLayers {
  mine: TowerDoTask[];
  needs: NeedsTask[];
  other: TowerDoTask[];
  completed: TowerDoTask[];
}

function byRecency(a: TowerDoTask, b: TowerDoTask): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Split a board into the caller's layers. Pure; callers own the rendering. */
export function classifyTaskLayers(
  tasks: readonly TowerDoTask[],
  view: TowerBoardView,
  identity: string,
): TaskLayers {
  const mine: TowerDoTask[] = [];
  const completed: TowerDoTask[] = [];
  const mineKeys = new Set<string>();
  for (const task of tasks) {
    if (task.status === "completed") {
      completed.push(task);
      continue;
    }
    if (identity !== "" && task.owner === identity) {
      mine.push(task);
      mineKeys.add(task.key);
    }
  }
  // Keys the caller's own unfinished work is still waiting on. `blockedBy` is
  // free-form (a task key, a message id, a finding id); when it names a task on
  // this board, the caller is parked on that task too.
  const boardKeys = new Set(tasks.map((task) => task.key));
  const awaited = new Set<string>();
  for (const task of mine) {
    for (const key of findAllUnresolvedDeps(task, view)) awaited.add(key);
    for (const key of task.blockedBy) {
      if (boardKeys.has(key)) awaited.add(key);
    }
  }
  // Peer tasks a message to the caller threads under.
  const unreadKeys = new Set<string>();
  for (const message of unreadMessagesToMe(view, identity)) {
    if (message.taskKey !== undefined) unreadKeys.add(message.taskKey);
  }
  // Declared scopes of the caller's own unfinished work. A peer planning to
  // touch the same files is the other half of "it affects me": not a gate, but
  // the caller must see it before editing. Only the unfinished x unfinished
  // pair lands here — an `overlap` against a completed receipt is what the
  // standalone `## Scope conflicts` section renders.
  const mineScopes = mine
    .map((task) => task.scope ?? [])
    .filter((scope) => scope.length > 0);
  const scopeCollides = (task: TowerDoTask): boolean => {
    const scope = task.scope ?? [];
    if (scope.length === 0 || mineScopes.length === 0) return false;
    return mineScopes.some((mineScope) =>
      scope.some((glob) =>
        mineScope.some((mineGlob) => scopeGlobIntersects(mineGlob, glob)),
      ),
    );
  };
  const needs: NeedsTask[] = [];
  const other: TowerDoTask[] = [];
  for (const task of tasks) {
    if (task.status === "completed" || mineKeys.has(task.key)) continue;
    if (awaited.has(task.key)) {
      needs.push({ task, reason: "await" });
    } else if (unreadKeys.has(task.key)) {
      needs.push({ task, reason: "unread" });
    } else if (task.dependsOn.some((key) => mineKeys.has(key))) {
      // `mineKeys` only holds unfinished work, so this is "it awaits me".
      needs.push({ task, reason: "blocking" });
    } else if (scopeCollides(task)) {
      needs.push({ task, reason: "scope" });
    } else {
      other.push(task);
    }
  }
  needs.sort((a, b) => byRecency(a.task, b.task));
  return {
    mine: mine.sort(byRecency),
    needs,
    other: other.sort(byRecency),
    completed: completed.sort(byRecency),
  };
}

/** The layered order flattened: mine, then needs, then other. Exported for
 *  callers that want the whole board as one ranked list; the widget and the
 *  reminder use the layers directly and fold `other` into a single line. */
export function orderTasksByLayer(
  tasks: readonly TowerDoTask[],
  view: TowerBoardView,
  identity: string,
): TowerDoTask[] {
  const layers = classifyTaskLayers(tasks, view, identity);
  return [
    ...layers.mine,
    ...layers.needs.map((entry) => entry.task),
    ...layers.other,
  ];
}

/** Compact folded row: `key status @owner`. A key the caller can still name is
 *  a key a full-replacement write can keep, so a folded section renders as this
 *  instead of disappearing. The status printed is the STORED one, not the
 *  derived `blocked` view: this row is what a replay writes back, and echoing a
 *  derived blocked would turn a parked reason into a stored status. */
export function formatLedgerRow(task: TowerDoTask): string {
  const owner = task.owner === undefined ? "" : ` @${task.owner}`;
  return `- ${task.key} ${task.status}${owner}`;
}

/** Compact key-only ledger, `maxChars` per line. Receipts share one status, so
 *  repeating it per key buys nothing — this is the form that keeps every key
 *  enumerable for a full-replacement write without spending a line per task. */
export function formatLedgerKeyRows(
  tasks: readonly TowerDoTask[],
  maxChars = 96,
): string[] {
  const rows: string[] = [];
  let current = "";
  for (const task of tasks) {
    const candidate = current === "" ? task.key : `${current}, ${task.key}`;
    // `- ` counts against the width. A single key longer than the budget still
    // gets its own line: losing a key is worse than a long line.
    if (current !== "" && candidate.length + 2 > maxChars) {
      rows.push(`- ${current}`);
      current = task.key;
      continue;
    }
    current = candidate;
  }
  if (current !== "") rows.push(`- ${current}`);
  return rows;
}

/** Truncate the CONTENT to `max` code points, appending an ellipsis when cut
 *  (so the result is at most `max + 1` code points — the marker is always
 *  disclosed). Code points, not UTF-16 units — the same metric as every other
 *  limit. */
export function truncateChars(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join("")}…`;
}

/** Truncate to AT MOST `max` code points, ellipsis included. `truncateChars`
 * is display-oriented and returns `max + 1` when it cuts, so it cannot be used
 * where the result must satisfy a validated `<= max` bound (a checkpoint digest
 * field must be re-readable by `readBoardDigest`). */
export function truncateToAtMost(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** Longest rendered `summary` prefix for one open finding in the dashboard.
 * A finding's `summary` is up to 4000 characters and the list is not the place
 * to read it — the full text is one `findingId` lookup away. The surrounding
 * title/location/from fields carry their own limits, so the rendered line is
 * longer than this. */
export const DASHBOARD_FINDING_LINE_CHARS = 240;

/** Default `tower_do_status` dashboard budget (rows rendered per call). The
 * open-task quota is 50, so this can only ever bind on a long completed
 * history or an explicit smaller `limit`. */
export const DASHBOARD_ROW_BUDGET = 200;

/** Slice the dashboard listing, reporting how many rows it had to hide.
 *
 * `limit` explicit = the caller asked for fold order, honoured verbatim.
 * Default budget = open (non-completed) rows win it: a completed history
 * longer than the budget must never hide unfinished work, and boards now
 * outgrow the budget (the row cap became an open budget — see DECISIONS.md
 * "open-task budget"). Stable partition, so the slice keeps fold order; the
 * render order inside a layer is recency-first. Does not mutate `tasks`. */
export function sliceTaskDashboard(
  tasks: readonly TowerDoTask[],
  limit: number | undefined,
): { shown: TowerDoTask[]; hidden: number } {
  const ordered =
    limit === undefined
      ? [
          ...tasks.filter((task) => task.status !== "completed"),
          ...tasks.filter((task) => task.status === "completed"),
        ]
      : tasks;
  const budget = limit ?? DASHBOARD_ROW_BUDGET;
  const shown = ordered.slice(0, budget);
  return { shown: [...shown], hidden: ordered.length - shown.length };
}

/** Footer note naming what the dashboard budget hid and how to see it. The
 * default budget and an explicit `limit` hide rows for different reasons, so
 * they carry different remedies. `undefined` when nothing was hidden. */
export function formatDashboardHiddenNote(
  hidden: number,
  limit: number | undefined,
): string | undefined {
  if (hidden <= 0) return undefined;
  const budget = limit ?? DASHBOARD_ROW_BUDGET;
  return (
    `… +${String(hidden)} more row(s) hidden by the ${String(budget)}-row budget` +
    (limit === undefined
      ? " (open rows win the default budget — pass limit to widen, or narrow with owner=/status=)"
      : " (pass a larger limit, or narrow with owner=/status=)")
  );
}

/** Section priority for the folded dashboard: the caller's own work first, then
 * the sections that need action, then backlog and history. Titles match by
 * prefix, so a count suffix (`## Mine (3)`) ranks the same as the bare title. */
const DASHBOARD_SECTION_RANK: readonly string[] = [
  "## Mine",
  "## Needs you",
  // `view=all` renders the findings section as `## Findings`, the folded view
  // as `## Open findings`; they are one section under two titles, and both must
  // rank above history or a finite budget spends itself on `## Completed`.
  "## Open findings",
  "## Findings",
  "## Messages for",
  "## Who is around",
  "## Scope conflicts",
  "## Others",
  "## Completed",
  "## Recent activity",
];

/** Sections that keep a heading plus one content line before the rest of the
 * budget is spent (the two findings spellings count as one concept, so this is
 * 5 titles for the 4 action sections). */
const DASHBOARD_MUST_SEE_SECTIONS = 5;

function dashboardSectionRank(title: string): number {
  const index = DASHBOARD_SECTION_RANK.findIndex((prefix) =>
    title.startsWith(prefix),
  );
  return index === -1 ? DASHBOARD_SECTION_RANK.length : index;
}

/** Fold a rendered dashboard to `budget` lines **by section**, keeping the
 * original line order. A head-cut spends the window on whichever section
 * renders first; this spends it where it matters.
 *
 *  - Every must-see section (rank < `DASHBOARD_MUST_SEE_SECTIONS`) keeps its
 *    heading plus one content line before the rest is spent in priority order,
 *    so a long `## Mine` cannot reduce `## Needs you` / findings / messages to
 *    bare headings — while the budget affords it; a head cropped to an
 *    explicit tiny budget may erase sections entirely (pinned by the
 *    `budget < head` case).
 *  - Budget cut notes and `(no tasks match the filter)` are always kept: they
 *    are disclosures, not section content.
 *
 * Pure; the caller reports the cut (`lines.length - result.length`). */
export function foldDashboardSections(
  lines: readonly string[],
  budget = 16,
): string[] {
  const head: string[] = [];
  const notes: string[] = [];
  const sections: { rank: number; rows: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      sections.push({ rank: dashboardSectionRank(line), rows: [line] });
    } else if (sections.length === 0) {
      head.push(line);
    } else if (
      line === "(no tasks match the filter)" ||
      // A section-internal disclosure is indented (`## Scope conflicts` cuts
      // with `  … +N more …`), so match past the indent: a cut notice is a
      // disclosure, not section content the budget may drop.
      line.trimStart().startsWith("… ")
    ) {
      notes.push(line);
    } else {
      sections[sections.length - 1].rows.push(line);
    }
  }
  if (sections.length === 0) {
    // No headings at all (the taskKey / findingId detail reads): fall back to
    // a plain cut so those outputs stay bounded too.
    return head.slice(0, budget);
  }
  // The head is the board header plus its counts; it is bounded by
  // construction, but an explicit small budget still has to hold, so crop it
  // before the sections rather than returning more lines than `budget`.
  const headBudget = Math.max(0, budget - notes.length);
  const keptHead = head.length <= headBudget ? head : head.slice(0, headBudget);
  let remaining = Math.max(0, budget - keptHead.length - notes.length);
  const counts = sections.map(() => 0);
  const ranked = sections
    .map((section, index) => ({ index, rank: section.rank }))
    .sort((a, b) => a.rank - b.rank);
  // Pass 1: headings for every must-see section. A long header or a disclosure
  // note must not erase the section that carries the action items.
  for (const { index, rank } of ranked) {
    if (remaining <= 0) break;
    if (rank >= DASHBOARD_MUST_SEE_SECTIONS) continue;
    counts[index] = 1;
    remaining -= 1;
  }
  // Pass 2: one content line for each of those sections.
  for (const { index, rank } of ranked) {
    if (remaining <= 0) break;
    if (rank >= DASHBOARD_MUST_SEE_SECTIONS) continue;
    if (sections[index].rows.length <= counts[index]) continue;
    counts[index] += 1;
    remaining -= 1;
  }
  // Pass 3: spend what is left in priority order.
  for (const { index } of ranked) {
    if (remaining <= 0) break;
    const room = sections[index].rows.length - counts[index];
    if (room <= 0) continue;
    const take = Math.min(room, remaining);
    counts[index] += take;
    remaining -= take;
  }
  const kept = [...keptHead];
  for (const [index, section] of sections.entries()) {
    for (let row = 0; row < counts[index]; row += 1) {
      kept.push(section.rows[row]);
    }
  }
  // Disclosures are kept last, but the budget is absolute: when the caller
  // passes a budget smaller than the note count, the notes that fit survive and
  // the remainder is cut (the reservation above cannot hold them all).
  kept.push(...notes.slice(0, Math.max(0, budget - kept.length)));
  return kept;
}

/** One line listing unrelated unfinished keys: `+3 other task(s): a, b, c`.
 *  The keys stay enumerable — a full-replacement write replays keys, not rows —
 *  while the layer itself stops spending the caller's attention window. */
export function formatOtherKeysLine(
  keys: readonly string[],
  maxChars = 160,
): string {
  return formatKeyListLine(
    `+${String(keys.length)} other task(s): `,
    keys,
    maxChars,
  );
}

/** `lead` followed by as many keys as fit in `maxChars`; a tail names the rest.
 *  The keys stay enumerable — a full-replacement write replays keys, not rows —
 *  while the layer (or an overflowed attention window) stops spending the
 *  caller's rows. */
export function formatKeyListLine(
  lead: string,
  keys: readonly string[],
  maxChars = 160,
): string {
  let line = lead;
  let taken = 0;
  for (const key of keys) {
    const candidate = taken === 0 ? `${line}${key}` : `${line}, ${key}`;
    if (taken > 0 && candidate.length > maxChars) break;
    line = candidate;
    taken += 1;
  }
  const rest = keys.length - taken;
  return rest > 0
    ? `${line} … (+${String(rest)} more, see tower_do_status)`
    : line;
}

/** One-line shape summary of a folded layer, e.g.
 *  `2 owner(s) · 1 in_progress · 1 blocked` — the layer still reports what the
 *  board holds; only its rows are gone. */
export function formatLayerSummary(
  tasks: readonly TowerDoTask[],
  view: TowerBoardView,
): string {
  const owners = new Set(
    tasks
      .map((task) => task.owner)
      .filter((owner): owner is string => owner !== undefined),
  );
  const counts = new Map<TowerDoStatus, number>();
  let blocked = 0;
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    if (taskIsBlocked(task, view)) blocked += 1;
  }
  const parts = [
    owners.size > 0 ? `${String(owners.size)} owner(s)` : "unowned",
  ];
  for (const status of ["in_progress", "pending"] as const) {
    const count = counts.get(status) ?? 0;
    if (count > 0) parts.push(`${String(count)} ${status}`);
  }
  if (blocked > 0) parts.push(`${String(blocked)} blocked`);
  return parts.join(" · ");
}

/** Compact status-line rendering of the whole board for reminders. Rows are
 *  layered (mine → needs) and recency-first, so the cap shows the work the
 *  caller is in and the peer work it is coupled to; the unrelated layer folds
 *  to one key line. Counts stay board-wide. */
export function formatBoardReminder(
  view: TowerBoardView,
  identity: string,
): string {
  const tasks = getAllTasks(view);
  const layers = classifyTaskLayers(tasks, view, identity);
  const completed = layers.completed.length;
  const unfinished = [
    ...layers.mine,
    ...layers.needs.map((entry) => entry.task),
    ...layers.other,
  ];
  // Rows the caller must actually read: its own work plus the peer work it is
  // coupled to. Unrelated unfinished tasks keep their counts and their keys
  // (a full-replacement write replays keys, not rows) but not their rows.
  const attention = [
    ...layers.mine,
    ...layers.needs.map((entry) => entry.task),
  ];
  const blocked = unfinished.filter((task) => taskIsBlocked(task, view));
  const unread = unreadMessagesToMe(view, identity).length;
  const needsReason = new Map(
    layers.needs.map((entry) => [entry.task.key, entry.reason]),
  );
  // The agent reading this snapshot must know which owner suffix is itself,
  // or owner matching / (me) markers are guesswork. Counts stay board-wide so
  // a folded layer is still measurable; only its rows are gone.
  const lines = [
    `TowerDo shared board — you are ${identity} (revision ${view.revision}; ${tasks.length} task(s), ${layers.mine.length} mine, ${layers.needs.length} need you, ${layers.other.length} other${completed > 0 ? `, ${completed} completed hidden` : ""}, ${blocked.length} blocked, ${unread} unread message(s) for you).`,
  ];
  if (view.incomplete === true) {
    lines.push(
      "⚠ board file is missing — this is the last bounded checkpoint (open tasks and finding titles only). Full content (messages, completed receipts, finding bodies) is unavailable; writes fold the missing file as an empty board.",
    );
  }
  const shown = attention.slice(0, REMINDER_TASK_LINE_CAP);
  for (const task of shown) {
    const owner =
      task.owner === undefined
        ? ""
        : task.owner === identity
          ? ` @${task.owner} (me)`
          : ` @${task.owner}`;
    const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
    // The status tag already says "blocked" — the suffix must add the WHY
    // (which keys still gate it) or it is pure duplication.
    const blockers = [
      ...new Set([...task.blockedBy, ...findAllUnresolvedDeps(task, view)]),
    ];
    const blockedBy = blockers.length
      ? ` [blocked by: ${blockers.join(",")}]`
      : "";
    // One blocked definition everywhere: the header counts taskIsBlocked, so
    // a pending task gated by unresolved deps is labelled [blocked] here too
    // (the suffix still carries the WHY). Otherwise the header says
    // "1 blocked" while the row reads [pending].
    const label = taskIsBlocked(task, view) ? "blocked" : task.status;
    // A peer row wins the window because the caller is coupled to it; say why,
    // or it reads as unrelated backlog the caller may skip.
    const reason = needsReason.get(task.key);
    const needsTag = reason === undefined ? "" : ` [needs you: ${reason}]`;
    lines.push(
      `- [${label}] ${task.key}: ${task.subject}${owner}${deps}${blockedBy}${needsTag}`,
    );
  }
  if (attention.length > shown.length) {
    // The overflow mixes the caller's own rows with the coupled peer rows, so
    // the count must not claim them all as "yours" — and naming the keys keeps
    // them enumerable for a full-replacement write.
    const overflow = attention.slice(shown.length).map((task) => task.key);
    lines.push(
      formatKeyListLine(
        `… and ${String(overflow.length)} more task(s) you need to see: `,
        overflow,
      ),
    );
  }
  if (layers.other.length > 0) {
    lines.push(formatOtherKeysLine(layers.other.map((task) => task.key)));
  }
  lines.push(
    "Before your final response, reconcile actual progress with this shared board. " +
      "If your work changed (or should change) any task's status, owner, or deps, write it via tower_do " +
      `with baseRevision ${view.revision} — attach changedFiles (files you actually changed) when completing. ` +
      "To coordinate, message the task owner or file a finding via tower_do_talk instead of silently changing tasks you don't own. " +
      `An owner idle for ${formatTakeoverWindow()}+ (per-task activity, not board chatter) may be displaced: adopt the non-completed task by setting owner to yourself, or remove it. ` +
      "Do not call tower_do only to acknowledge this reminder.",
  );
  return lines.join("\n");
}
