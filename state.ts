/**
 * tower-do — shared multi-agent WIP board (state layer).
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
export const MAX_TOWER_DO_TASKS = 50;
export const MAX_TASK_DEPENDENCIES = 20;
export const MAX_SCOPE_GLOBS = 20;
export const DEFAULT_IDENTITY = "main";
/** Reserved orchestrator identity that may act on any owned task (Tower). */
export const TOWER_IDENTITY = "tower";
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_MESSAGE_SUBJECT_CHARS = 200;
export const MAX_FINDING_TITLE_CHARS = 200;
export const MAX_FINDING_SUMMARY_CHARS = 4000;

export type TowerDoStatus = "pending" | "in_progress" | "completed" | "blocked";
export type FindingKind = "bug" | "improve" | "vuln" | "idea";
export type FindingSeverity = "low" | "medium" | "high";
export type FindingStatus = "open" | "accepted" | "rejected" | "done";

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
  "rejected",
  "done",
]);

export function isTowerDoStatus(value: unknown): value is TowerDoStatus {
  return typeof value === "string" && TOWER_DO_STATUSES.has(value);
}

export interface TowerDoTaskInput {
  key: string;
  subject?: string;
  description?: string;
  status?: TowerDoStatus;
  owner?: string;
  dependsOn?: string[];
  scope?: string[];
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
  from: string;
  at: number;
}

export interface TowerBoardView {
  schemaVersion: typeof TOWER_DO_SCHEMA_VERSION;
  revision: number;
  tasks: TowerDoTask[];
  messages: TowerDoMessage[];
  findings: TowerDoFinding[];
}

export interface TowerDoChangeSummary {
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
  };
}

function cloneTask(task: TowerDoTask): TowerDoTask {
  return {
    ...task,
    description: task.description,
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    dependsOn: [...task.dependsOn],
    ...(task.scope === undefined ? {} : { scope: [...task.scope] }),
    blockedBy: [...task.blockedBy],
  };
}

export function cloneBoard(view: TowerBoardView): TowerBoardView {
  return {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: view.revision,
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
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(key)) {
    throw new TowerDoValidationError(
      `${location} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens`,
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

function normalizeIdentity(
  value: string | undefined,
  location: string,
): string {
  const identity = value?.trim();
  if (!identity) throw new TowerDoValidationError(`${location} is required`);
  assertSingleLine(identity, location);
  if (identity.length > 64)
    throw new TowerDoValidationError(
      `${location} must be at most 64 characters`,
    );
  return identity;
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
  if (input.tasks.length > MAX_TOWER_DO_TASKS) {
    throw new TowerDoValidationError(
      `tasks supports at most ${MAX_TOWER_DO_TASKS} items`,
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
    if (owner !== undefined) {
      normalizeIdentity(owner, `tasks[${index}].owner`);
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
          ...(patch.scope !== undefined || existing?.scope !== undefined
            ? { scope: patch.scope ?? existing!.scope }
            : {}),
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

  const removedTasks = current.tasks.filter((task) => !keys.has(task.key));

  // Tower: workers may remove only their own (or unowned) tasks; the
  // orchestrator may remove any. Without this, a partial-list update or a
  // stray `tasks: []` would silently delete another agent's task.
  for (const removed of removedTasks) {
    if (
      removed.owner !== undefined &&
      caller !== removed.owner &&
      caller !== TOWER_IDENTITY
    ) {
      throw new TowerDoValidationError(
        `task ${removed.key} is owned by "${removed.owner}" — only its owner or ${TOWER_IDENTITY} may remove it`,
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
    // fields (see the removal guard below for task deletion); any agent may
    // add new tasks or touch unowned ones. The guard compares EVERY field
    // (subject/description/status/owner/dependsOn/scope/blockedBy), not just
    // status/owner/scope — otherwise a worker replaying the full task list
    // (full-replacement semantics) could silently rewrite another owner's
    // content (e.g. its subject or dependencies) or roll back its concurrent
    // update with a stale snapshot while leaving status untouched.
    const ownerChanged =
      existing.owner !== candidate.owner ||
      existing.status !== candidate.status ||
      existing.scope?.join("\u0000") !== candidate.scope?.join("\u0000") ||
      existing.subject !== candidate.subject ||
      existing.description !== candidate.description ||
      existing.dependsOn.join("\u0000") !==
        candidate.dependsOn.join("\u0000") ||
      existing.blockedBy.join("\u0000") !== candidate.blockedBy.join("\u0000");
    if (
      ownerChanged &&
      existing.owner !== undefined &&
      caller !== existing.owner &&
      caller !== TOWER_IDENTITY
    ) {
      throw new TowerDoValidationError(
        `task ${task.key} is owned by "${existing.owner}" — workers may update only their own tasks ` +
          `(${TOWER_IDENTITY} may update any)`,
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
    messages: current.messages,
    findings: current.findings,
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
    blockedBy: [...task.blockedBy],
  };
}

function taskEquals(left: TowerDoTask, right: TowerDoTask): boolean {
  return (
    left.subject === right.subject &&
    left.status === right.status &&
    left.description === right.description &&
    left.owner === right.owner &&
    left.dependsOn.join("\u0000") === right.dependsOn.join("\u0000") &&
    (left.scope ?? []).join("\u0000") === (right.scope ?? []).join("\u0000") &&
    left.blockedBy.join("\u0000") === right.blockedBy.join("\u0000")
  );
}

function normalizeTask(
  input: {
    key: string;
    subject: string;
    status: TowerDoStatus;
    description?: string;
    owner?: string;
    dependsOn: string[];
    scope?: string[];
    blockedBy: string[];
  },
  index: number,
): ResolvedTowerDoTaskInput {
  const key = normalizeTaskKey(input.key, `tasks[${index}].key`);
  const subject = assertSingleLine(
    input.subject.trim(),
    `tasks[${index}].subject`,
  );
  if (!subject)
    throw new TowerDoValidationError(`tasks[${index}].subject is required`);
  if (subject.length > 160)
    throw new TowerDoValidationError(
      `tasks[${index}].subject must be at most 160 characters`,
    );

  const description = normalizeOptionalText(input.description);
  if (description && description.length > 2_000) {
    throw new TowerDoValidationError(
      `tasks[${index}].description must be at most 2000 characters`,
    );
  }

  if (!isTowerDoStatus(input.status)) {
    throw new TowerDoValidationError(
      `tasks[${index}].status is invalid: ${String(input.status)}`,
    );
  }

  if ((input.dependsOn?.length ?? 0) > MAX_TASK_DEPENDENCIES) {
    throw new TowerDoValidationError(
      `tasks[${index}].dependsOn supports at most ${MAX_TASK_DEPENDENCIES} keys`,
    );
  }
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
      `tasks[${index}].dependsOn[${dependencyIndex}]`,
    );
  }
  if (dependsOn.includes(key)) {
    throw new TowerDoValidationError(
      `tasks[${index}] cannot depend on itself (${key})`,
    );
  }

  const scope = (input.scope ?? [])
    .slice(0, MAX_SCOPE_GLOBS)
    .map((glob) => assertSingleLine(glob.trim(), `tasks[${index}].scope entry`))
    .filter(Boolean);
  for (const glob of scope) {
    if (glob.length === 0 || glob.length > 256) {
      throw new TowerDoValidationError(
        `tasks[${index}].scope entry must be 1-256 characters`,
      );
    }
  }
  const blockedBy = [
    ...new Set(
      (input.blockedBy ?? [])
        .map((entry) =>
          assertSingleLine(entry.trim(), `tasks[${index}].blockedBy entry`),
        )
        .filter(Boolean),
    ),
  ].slice(0, MAX_TASK_DEPENDENCIES);

  const owner = normalizeOptionalText(input.owner);
  if (owner !== undefined) normalizeIdentity(owner, `tasks[${index}].owner`);

  return {
    key,
    subject,
    status: input.status,
    ...(description ? { description } : {}),
    ...(owner === undefined ? {} : { owner }),
    dependsOn,
    ...(scope.length ? { scope } : {}),
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
          ? `tasks[${index}].dependsOn references missing task ${dependency} — it must exist on the shared board or in this call`
          : `cannot remove task ${dependency} (this write omits it): ${task.key} still depends on it — keep it in the batch or drop the dependency first`,
      );
    }
    if (task.status !== "in_progress" && task.status !== "completed") continue;
    const unresolved = task.dependsOn.filter(
      (dependency) => byKey.get(dependency)?.status !== "completed",
    );
    if (unresolved.length > 0) {
      throw new TowerDoValidationError(
        `tasks[${index}] cannot be ${task.status} while dependencies are unresolved: ${unresolved.join(", ")}`,
      );
    }
  }
}

export function taskIsBlocked(
  task: TowerDoTask,
  board: TowerBoardView,
): boolean {
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
// Persisted-state reading (board file entries) + session checkpoint replay.
// The disk board is authoritative; the session checkpoint is a fallback.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
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
    typeof candidate.at !== "number"
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
    typeof candidate.at !== "number"
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
    from: candidate.from,
    at: candidate.at,
  };
}

/** Read a serialized board snapshot (used for session checkpoints). */
export function readBoardSnapshot(value: unknown): TowerBoardView | undefined {
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
      isRecord(candidate) && typeof candidate.updatedAt === "number"
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
    tasks,
    messages,
    findings,
  };
}

/** Serialize a board snapshot for session checkpoints. */
export function writeBoardCheckpoint(view: TowerBoardView): TowerBoardView {
  return cloneBoard(view);
}

export const REMINDER_TASK_LINE_CAP = 12;

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
export function broadcastAudience(
  message: TowerDoMessage,
  view: TowerBoardView,
): Set<string> {
  const owners =
    message.audience ??
    [...currentOwners(view)].filter((owner) => owner !== message.from);
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
    if (message.from === identity) return false;
    if (message.to === identity) return true;
    if (message.to !== "all") return false;
    return broadcastAudience(message, view).has(identity);
  });
}

/** Messages to `identity` that it has not yet acked (read). */
export function unreadMessagesToMe(
  view: TowerBoardView,
  identity: string,
): TowerDoMessage[] {
  return messagesToMe(view, identity).filter(
    (message) => !(message.readBy ?? []).includes(identity),
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
      (owner) => !readBy.includes(owner),
    );
    if (pendingReaders.length === 0) return true;
    const pendingStillHere = pendingReaders.some(
      (owner) =>
        view.tasks.some((task) => task.owner === owner) || owner === message.to,
    );
    if (!pendingStillHere) return true;
    return false;
  }
  // Addressed message: fully read once the recipient acks. If the recipient
  // is no longer an owner on the board (they left / the board was rebuilt),
  // nobody can ever read it — treat it as fully read so orphan messages do
  // not accumulate in the folded view forever.
  const recipientStillHere = view.tasks.some(
    (task) => task.owner === message.to,
  );
  if (!recipientStillHere) return true;
  return readBy.includes(message.to);
}

/**
 * Retire fully-read history: keep at most `retention` fully-read messages
 * (oldest first) once the folded set exceeds the budget. Unread and
 * partially-read messages always survive — retiring them would silently
 * swallow traffic a peer has not seen. retention 0 = keep everything (legacy).
 * Returns a NEW messages array; the input view is not mutated.
 */
export function retainMessages(
  messages: readonly TowerDoMessage[],
  view: TowerBoardView,
  retention: number,
): TowerDoMessage[] {
  if (retention <= 0 || messages.length <= retention) return [...messages];
  const done = messages.filter((message) => isMessageFullyRead(message, view));
  const keepDone = Math.max(0, retention - (messages.length - done.length));
  const surplus = done.length - keepDone;
  if (surplus <= 0) return [...messages];
  const retired = new Set(done.slice(0, surplus).map((message) => message.id));
  return messages.filter((message) => !retired.has(message.id));
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
  const at = typeof record.at === "number" ? record.at : undefined;
  const by = typeof record.by === "string" ? record.by : undefined;
  if (at === undefined || by === undefined) return undefined;
  if (kind === "task") {
    const task = record.task as Record<string, unknown> | undefined;
    const key = typeof record.key === "string" ? record.key : "?";
    if (record.op === "remove") {
      return { kind: "task", by, at, glyph: "🗑", detail: `${key} removed` };
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
        detail: `${key}: ${task.subject}`, // could be added or updated
      };
    }
    return undefined;
  }
  if (kind === "message") {
    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message.subject === "string") {
      const to = typeof message.to === "string" ? message.to : "?";
      const from = typeof message.from === "string" ? message.from : "?";
      const readBy = Array.isArray(message.readBy)
        ? message.readBy.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      // An ack re-emission (reader appends their id to readBy) is NOT a new
      // message: it is traffic the *reader* generated. Render it as a read
      // notice, keyed to the reader, so activity doesn't look like the
      // reader re-sent the message.
      if (by !== from && readBy.includes(by)) {
        return {
          kind: "message",
          by,
          at,
          glyph: "👁",
          detail: `read →${to}: ${message.subject}`, // by = reader
        };
      }
      return {
        kind: "message",
        by,
        at,
        glyph: "✉",
        detail: `→${to}: ${message.subject}`,
      };
    }
    return undefined;
  }
  if (kind === "finding") {
    const finding = record.finding as Record<string, unknown> | undefined;
    if (finding && typeof finding.title === "string") {
      const severity =
        typeof finding.severity === "string" ? finding.severity : "?";
      return {
        kind: "finding",
        by,
        at,
        glyph: "⚑",
        detail: `[${severity}] ${finding.title}`,
      };
    }
    return undefined;
  }
  return undefined;
}

/** Compact relative time for activity/presence lines (test-friendly). */
export function relativeTime(now: number, at: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return "just now";
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
export const PRESENCE_IDLE_MS = 10 * 60_000;

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
  const lines: PresenceLine[] = [];
  for (const identity of identities) {
    const ownerOfKeys = ownerOf.get(identity) ?? [];
    const lastSeenAt = lastSeen.get(identity);
    const unstarted = ownerOfKeys.length > 0 && lastSeenAt === undefined;
    const idle =
      ownerOfKeys.length > 0 &&
      lastSeenAt !== undefined &&
      now - lastSeenAt > PRESENCE_IDLE_MS;
    lines.push({ identity, lastSeenAt, ownerOf: ownerOfKeys, unstarted, idle });
  }
  lines.sort((a, b) => {
    const aAt = a.lastSeenAt ?? 0;
    const bAt = b.lastSeenAt ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return a.identity.localeCompare(b.identity);
  });
  return lines;
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

/** Compact status-line rendering of the whole board for reminders. */
export function formatBoardReminder(
  view: TowerBoardView,
  identity: string,
): string {
  const tasks = getAllTasks(view);
  const unfinished = tasks.filter((task) => task.status !== "completed");
  const blocked = tasks.filter((task) => taskIsBlocked(task, view));
  const unread = unreadMessagesToMe(view, identity).length;
  const lines = [
    `TowerDo shared board (revision ${view.revision}; ${tasks.length} task(s), ${blocked.length} blocked, ${unread} unread message(s) for you).`,
  ];
  const shown = unfinished.slice(0, REMINDER_TASK_LINE_CAP);
  for (const task of shown) {
    const owner = task.owner === undefined ? "" : ` @${task.owner}`;
    const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
    const blocked = taskIsBlocked(task, view) ? " [blocked]" : "";
    lines.push(
      `- [${task.status}] ${task.key}: ${task.subject}${owner}${deps}${blocked}`,
    );
  }
  if (unfinished.length > shown.length) {
    lines.push(
      `… and ${unfinished.length - shown.length} more unfinished task(s)`,
    );
  }
  lines.push(
    "Before the final response, reconcile actual progress with this shared board. " +
      `If task status/ownership/deps changed, call tower_do with baseRevision ${view.revision}, ` +
      "and use tower_do_talk to message task owners or file findings instead of silently changing owned tasks. " +
      "Do not call tower_do only to acknowledge this reminder.",
  );
  return lines.join("\n");
}
