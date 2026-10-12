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
 *  - deps: dependsOn must name a task in the SAME batch — tower_do is a full
 *    replacement, so an omitted dependency is being deleted, not merely absent
 *    from this call (Tower's "deps must reference known missions").
 */

export const TOWER_DO_SCHEMA_VERSION = 1 as const;
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
/** Age after which an unread message leaves the default view even though nobody
 * acked it. The message stays on disk and is readable via `inbox all` — this is
 * a VIEW retirement (Layer 2), never a delete. */
export const MESSAGE_PENDING_RETIRE_MS = 14 * 24 * 60 * 60_000;
/** Ownership-takeover window for non-completed tasks, separate from the 10 min
 * `PRESENCE_IDLE_MS` display hint: ownership dies on the task-relevant
 * activity clock, not on unrelated board chatter (see staleTaskClaims). */
export const TASK_CLAIM_STALE_MS = 6 * 60 * 60_000;

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

export const TOWER_DO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
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
  blockedBy?: string[];
}

interface ResolvedTowerDoTaskInput {
  key: string;
  subject: string;
  status: TowerDoStatus;
  description?: string;
  owner?: string;
  dependsOn: string[];
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

export interface TowerBoardView {
  schemaVersion: typeof TOWER_DO_SCHEMA_VERSION;
  revision: number;
  tasks: TowerDoTask[];
  messages: TowerDoMessage[];
  /** Non-empty log lines the fold could not turn into an event (corrupt JSON,
   * foreign shapes, a task payload that no longer validates). Data the board
   * still holds but cannot show — never silent: the dashboard discloses it.
   * Not part of `revision` (which counts folded task events only). */
  skipped: number;
  /** True when this view was rebuilt from a bounded checkpoint because the
   * board file was missing. Display-only, never persisted into a board event. */
  incomplete?: boolean;
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
  /** Upsert list: each entry is created or merged as a patch onto the stored
   *  row. A key omitted here is left untouched. */
  tasks: TowerDoTaskInput[];
  /** Explicit deletions. A key not listed here is never deleted, so a partial
   *  list can no longer drop a peer's work by omission. */
  remove?: string[];
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
    skipped: 0,
  };
}

function cloneTask(task: TowerDoTask): TowerDoTask {
  return {
    ...task,
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    dependsOn: [...task.dependsOn],
    blockedBy: [...task.blockedBy],
  };
}

export function cloneBoard(view: TowerBoardView): TowerBoardView {
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: view.revision,
    skipped: view.skipped,
    ...(view.incomplete === undefined ? {} : { incomplete: view.incomplete }),
    tasks: view.tasks.map(cloneTask),
    messages: view.messages.map((message) => ({
      ...message,
      ...(message.readBy === undefined ? {} : { readBy: [...message.readBy] }),
      ...(message.audience === undefined
        ? {}
        : { audience: [...message.audience] }),
    })),
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

/**
 * Normalize one list-valued task field: trim, drop blanks, dedupe — while
 * keeping each surviving entry's ORIGINAL payload index. A length error must
 * name the caller's position (`scope[2]`), not the deduped one (`scope[1]`),
 * or the documented remedy ("shorten the named entry") points at the wrong
 * item and the retry fails identically.
 */
function normalizeListEntries(
  input: readonly string[] | undefined,
  location: (entryIndex: number) => string,
): Array<{ value: string; at: number }> {
  const out: Array<{ value: string; at: number }> = [];
  const seen = new Set<string>();
  for (const [entryIndex, raw] of (input ?? []).entries()) {
    const value = assertSingleLine(raw.trim(), location(entryIndex));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, at: entryIndex });
  }
  return out;
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
 * Apply one UPSERT write to the board: `tasks` are created or merged as patches
 * (omitted fields preserve stored values; new keys require subject + status),
 * and `remove` lists explicit deletions. A key absent from both is left alone —
 * there is no implicit removal. Returns the produced view, the per-task change
 * summary, and the events to append.
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

  // `tasks` is an UPSERT list. An unmentioned key is left alone, so a partial
  // write can never delete a peer's row by omission.
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
      // is skipped because the layers below treat "" as "no owner".
      normalizeIdentity(owner, `tasks[${index}].owner (${key})`);
    }
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

  // Explicit removals. A key that is not on the board, or that also appears in
  // `tasks`, is a caller bug — fail loud rather than pick a winner.
  const removeKeys = new Set<string>();
  for (const [index, rawKey] of (input.remove ?? []).entries()) {
    const key = normalizeTaskKey(rawKey, `remove[${index}]`);
    if (removeKeys.has(key))
      throw new TowerDoValidationError(
        `remove[${index}] is duplicated: ${key}`,
      );
    if (keys.has(key))
      throw new TowerDoValidationError(
        `task ${key} appears in both tasks and remove — one write cannot upsert and delete it`,
      );
    if (!existingByKey.has(key))
      throw new TowerDoValidationError(
        `cannot remove task ${key}: no such task on the board`,
      );
    removeKeys.add(key);
  }

  const now = Date.now();
  const taskEvents: BoardTaskEvent[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  // The board this write produces: existing rows, minus explicit removals, with
  // each upsert applied. Budget, dependency checks and the returned view all
  // read THIS map, never the input list.
  const resultByKey = new Map(existingByKey);

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
      resultByKey.set(task.key, candidate);
      continue;
    }
    if (taskEquals(existing, candidate)) {
      // Content unchanged: no event, no revision bump, and the row keeps its
      // original updatedAt — re-sending a row you already own must not drift it.
      resultByKey.set(task.key, cloneTask(existing));
      continue;
    }
    // Only the owner or the orchestrator may change an owned task's fields.
    // Stale-claim exception (takeover/adopt): strictly an ownership
    // displacement — the candidate must equal the existing task except for
    // owner === caller. Any content edit of a stalled task stays rejected.
    const adoptingStale =
      isStaleClaim(staleClaims, existing.owner, existing.key) &&
      existing.status !== "completed" &&
      task.owner === caller &&
      taskEquals(
        { ...existing, owner: task.owner },
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
          staleClaimHint(existing, staleClaims, "update"),
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
    resultByKey.set(task.key, candidate);
  }

  for (const key of removeKeys) {
    const target = existingByKey.get(key)!;
    // Workers may remove only their own (or unowned) tasks; the orchestrator
    // may remove any. Stale-claim exception: a row whose own claim is idle past
    // the takeover window may be removed by anyone. Completed receipts stay
    // fully guarded — a peer cannot drop a delivery record.
    if (
      target.owner !== undefined &&
      caller !== target.owner &&
      caller !== TOWER_IDENTITY &&
      !(
        isStaleClaim(staleClaims, target.owner, key) &&
        target.status !== "completed"
      )
    ) {
      throw new TowerDoValidationError(
        `task ${key} is owned by "${target.owner}" — only its owner or ${TOWER_IDENTITY} may remove it` +
          staleClaimHint(target, staleClaims),
      );
    }
    taskEvents.push({ kind: "task", op: "remove", key, by: caller, at: now });
    resultByKey.delete(key);
  }

  // Capacity is charged to open work on the PRODUCED board, not to history.
  const openTaskCount = [...resultByKey.values()].filter(
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
  // only the NEW completed rows a single write introduces.
  const newCompleted = resolved.filter(
    (task) => task.status === "completed" && !existingByKey.has(task.key),
  ).length;
  if (newCompleted > MAX_TOWER_DO_OPEN_TASKS) {
    throw new TowerDoValidationError(
      `a write may introduce at most ${MAX_TOWER_DO_OPEN_TASKS} new completed tasks (got ${newCompleted}; replaying a completed row the board already holds is free — do not fabricate receipts, split deliveries across successive writes)`,
    );
  }

  // Dependencies are checked against the PRODUCED board: an upsert may
  // reference an untouched task that still exists, and a removal must not
  // strand a surviving dependent.
  assertDependenciesAreConsistent(resolved, resultByKey, removeKeys);
  assertNoDependencyCycles([...resultByKey.values()]);

  const nextTasks = [...resultByKey.values()].map(cloneTask);
  const removed = [...removeKeys];
  // One revision bump per persisted task event, so a refold of the file yields
  // the exact same revision the write reported (the gate reads the file).
  const changed = taskEvents.length > 0;

  const nextView: TowerBoardView = {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: changed ? current.revision + taskEvents.length : current.revision,
    tasks: nextTasks,
    // Fresh arrays: the returned view must not alias the caller's board.
    messages: [...current.messages],
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
  const dependsOnEntries = normalizeListEntries(
    input.dependsOn,
    (entryIndex) => `tasks[${index}].dependsOn[${entryIndex}] (${key})`,
  );
  for (const { value, at } of dependsOnEntries) {
    normalizeTaskKey(value, `tasks[${index}].dependsOn[${at}] (${key})`);
  }
  const dependsOn = dependsOnEntries.map((entry) => entry.value);
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

  const blockedByEntries = normalizeListEntries(
    input.blockedBy,
    (entryIndex) => `tasks[${index}].blockedBy[${entryIndex}] (${key})`,
  );
  if (blockedByEntries.length > MAX_TASK_BLOCKERS) {
    throw new TowerDoValidationError(
      `tasks[${index}].blockedBy (${key}) supports at most ${MAX_TASK_BLOCKERS} entries`,
    );
  }
  for (const { value, at } of blockedByEntries) {
    const entryLength = textLength(value);
    if (entryLength > MAX_BLOCKER_CHARS) {
      throw new TowerDoValidationError(
        `tasks[${index}].blockedBy[${at}] (${key}) is ${entryLength} characters (max ${MAX_BLOCKER_CHARS}) — shorten it`,
      );
    }
  }
  const blockedBy = blockedByEntries.map((entry) => entry.value);

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
    blockedBy,
  };
}

function assertNoDependencyCycles(
  tasks: readonly {
    readonly key: string;
    readonly dependsOn: readonly string[];
  }[],
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
 * Dependency targets must exist on the board the write PRODUCES, and an
 * in_progress/completed task must have every dependency completed. With upsert
 * semantics a target may live outside this batch (an untouched task), so the
 * check runs over the produced board — not over the input list — and a removal
 * must not strand a surviving dependent.
 */
function assertDependenciesAreConsistent(
  tasks: readonly ResolvedTowerDoTaskInput[],
  board: ReadonlyMap<
    string,
    { readonly status: TowerDoStatus; readonly dependsOn: readonly string[] }
  >,
  removed: ReadonlySet<string>,
): void {
  const indexOf = new Map(tasks.map((task, index) => [task.key, index]));
  for (const [key, task] of board) {
    const index = indexOf.get(key);
    const at =
      index === undefined ? `task ${key}` : `tasks[${String(index)}] (${key})`;
    const unresolved: string[] = [];
    for (const dependency of task.dependsOn) {
      if (removed.has(dependency)) {
        throw new TowerDoValidationError(
          `cannot remove task ${dependency}: ${key} still depends on it — drop the dependency first`,
        );
      }
      const target = board.get(dependency);
      if (target === undefined) {
        throw new TowerDoValidationError(
          `${at}.dependsOn references missing task ${dependency}`,
        );
      }
      if (target.status !== "completed") unresolved.push(dependency);
    }
    if (
      index !== undefined &&
      (task.status === "in_progress" || task.status === "completed") &&
      unresolved.length > 0
    ) {
      throw new TowerDoValidationError(
        `${at} cannot be ${task.status} while dependencies are unresolved: ${unresolved.join(", ")}`,
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
  return findAllUnresolvedDeps(task, board).length > 0;
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
// Persisted-state reading (board file entries) + session checkpoint replay.
// The disk board is authoritative; the session checkpoint is a fallback.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
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

const REMINDER_TASK_LINE_CAP = 12;

// ---------------------------------------------------------------------------
// Bounded checkpoint digest (Layer 4)
// ---------------------------------------------------------------------------

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
  // Exclude the sender by AGENT — not exact string — for BOTH the send-time
  // snapshot and the current-owners fallback. A session that migrated from a
  // legacy label sends as its current label, so the audience it persisted can
  // name its own older label; that label can never ack (a self-broadcast never
  // reaches its own inbox), which would pin the broadcast outside the
  // retention budget forever.
  const owners = [...(message.audience ?? currentOwners(view))].filter(
    (owner) => !sameAgent(owner, message.from),
  );
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
    const pendingStillHere = pendingReaders.some((owner) =>
      view.tasks.some(
        (task) => task.owner !== undefined && sameAgent(task.owner, owner),
      ),
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
  kind: "task" | "message";
  by: string;
  at: number;
  glyph: string;
  /** Human summary: task key / recipient / subject. */
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
    // Parity with the fold: a task upsert counts as activity only when the
    // fold can actually turn it into a row (an event key plus a payload that
    // still validates under the current limits). `readPersistedTask` is the
    // SAME reader `fold()` uses, so a line the fold reports in `skipped` can
    // no longer refresh an owner's takeover clock (ARCHITECTURE.md "one clock,
    // not two").
    if (key !== undefined && task !== undefined) {
      const plain = readPersistedTask(task, 0);
      if (plain !== undefined) {
        return {
          kind: "task",
          by,
          at,
          glyph: ACTIVITY_GLYPHS[plain.status],
          detail: `${key}: ${plain.subject}`, // could be added or updated
          taskKey: key,
        };
      }
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
    // Readers survive compaction: an ack is its own log line whose byline the
    // compact snapshot does not keep (one line per message), but `readBy`
    // rides inside the message entity forever. Without this a peer whose only
    // footprint was an ack would become an unknown recipient after a gc.
    ...view.messages.flatMap((message) => message.readBy ?? []),
  ]);
  known.delete(TOWER_IDENTITY);
  return known;
}

/** Alias of `TASK_CLAIM_STALE_MS` under the name the docs and the takeover
 * hint use; a single constant behind the alias means the two cannot drift. */
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
 * text must not depend on it. `site` separates the two completed-row failures:
 * a removal is fixed by replaying the key, an update by replaying it unchanged. */
function staleClaimHint(
  task: TowerDoTask,
  staleClaims: ReadonlySet<string>,
  site: "removal" | "update" = "removal",
): string {
  if (task.status === "completed")
    return site === "update"
      ? ' (a completed task stays with its owner — only that owner or an as: "tower" write may change it, and a peer cannot forge a receipt)'
      : ' (a completed task stays with its owner — only that owner or an as: "tower" write may drop it; a peer cannot forge a receipt)';
  if (!isStaleClaim(staleClaims, task.owner, task.key)) return "";
  return ` (owner idle past the ${formatTakeoverWindow()} takeover window: adopt it by setting owner to yourself and changing nothing else, then edit in a second write — or remove it)`;
}

/** Heartbeat cadence for the per-session liveness sidecar
 * (`live/<identity>.<sessionId>.json`, see index.ts): each session rewrites its
 * own record on this cadence. */
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

/** Compact status-line rendering of the whole board for reminders. Rows are
 *  layered (mine → needs) and recency-first, so the cap shows the work the
 *  caller is in and the peer work it is coupled to; the unrelated layer folds
 *  to one key line. Counts stay board-wide. */
export function formatBoardReminder(
  view: TowerBoardView,
  identity: string,
): string {
  const tasks = getAllTasks(view);
  const unfinished = tasks
    .filter((task) => task.status !== "completed")
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1));
  const completed = tasks.length - unfinished.length;
  const blocked = unfinished.filter((task) => taskIsBlocked(task, view));
  const unread = unreadMessagesToMe(view, identity).length;
  const lines = [
    `TowerDo shared board — you are ${identity} (revision ${view.revision}; ${tasks.length} task(s), ${unfinished.length} open${completed > 0 ? `, ${completed} completed hidden` : ""}, ${blocked.length} blocked, ${unread} unread message(s) for you).`,
  ];
  if (view.incomplete === true) {
    lines.push(
      "⚠ board file is missing — this is the last bounded checkpoint (open tasks only). Full content (messages, completed receipts) is unavailable; writes fold the missing file as an empty board.",
    );
  }
  const shown = unfinished.slice(0, REMINDER_TASK_LINE_CAP);
  for (const task of shown) {
    const owner =
      task.owner === undefined
        ? ""
        : task.owner === identity
          ? ` @${task.owner} (me)`
          : ` @${task.owner}`;
    const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
    // The status tag already says "blocked" — the suffix adds the WHY.
    const blockers = [
      ...new Set([...task.blockedBy, ...findAllUnresolvedDeps(task, view)]),
    ];
    const blockedBy = blockers.length
      ? ` [blocked by: ${blockers.join(",")}]`
      : "";
    const label = taskIsBlocked(task, view) ? "blocked" : task.status;
    lines.push(
      `- [${label}] ${task.key}: ${task.subject}${owner}${deps}${blockedBy}`,
    );
  }
  if (unfinished.length > shown.length) {
    lines.push(
      `… and ${String(unfinished.length - shown.length)} more open task(s): ${unfinished
        .slice(shown.length)
        .map((task) => task.key)
        .join(", ")}`,
    );
  }
  lines.push(
    "Before your final response, reconcile actual progress with this shared board. " +
      `If your work changed (or should change) any task's status, owner, or deps, write it via tower_do with baseRevision ${view.revision}. ` +
      "To coordinate, message the task owner via tower_do_talk instead of silently changing tasks you don't own. " +
      `An owner idle for ${formatTakeoverWindow()}+ (per-task activity, not board chatter) may be displaced: adopt the non-completed task by setting owner to yourself, or remove it. ` +
      "Do not call tower_do only to acknowledge this reminder.",
  );
  return lines.join("\n");
}
