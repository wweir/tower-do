/**
 * tower-do — tool argument schemas and the text/theme rendering helpers
 * (presentation layer).
 *
 * Two jobs that are pure functions of their inputs and belong to neither the
 * state layer nor the extension wiring: the typebox schemas the host binds to
 * the three tools, and the small formatters the tool renderers and the widget
 * share. Keeping them here is what lets `index.ts` stay an assembly file.
 *
 * Layering: no filesystem, no board access. May import `./state.ts` only; must
 * never import `./index.ts`, `./board.ts` or `./paths.ts` — see
 * test/layering.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  DASHBOARD_ROW_BUDGET,
  DEFAULT_INBOX_LIMIT,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_TASK_BLOCKERS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TASK_KEY_CHARS,
  MAX_TASK_SUBJECT_CHARS,
  MAX_TOWER_DO_OPEN_TASKS,
  TASK_KEY_PATTERN,
  TASK_STATUS_GLYPHS,
  transportLimit,
  TOWER_IDENTITY,
  TowerDoValidationError,
  type TowerBoardView,
  type TowerDoStatus,
  type TowerDoTask,
} from "./state.ts";

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

export const TowerDoParamsSchema = Type.Object({
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

export const TalkParamsSchema = Type.Object({
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

export const StatusParamsSchema = Type.Object({
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
        `Max task lines (default ${DASHBOARD_ROW_BUDGET}). The default budget is won by open (non-completed) rows, so a long completed history can never hide unfinished work; rows render newest-first within each group. Hidden rows are reported in the output.`,
      minimum: 1,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Theme color for a task status glyph. Shared by the widget and renderCall. */
export function statusColor(
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

/** Newest first, key-ascending tiebreak — the ordering shared by the widget and
 *  the status dashboard. */
export function byRecency(a: TowerDoTask, b: TowerDoTask): number {
  return b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1);
}

/** Flatten a tool result's text content into one string — the shared tail of
 * every renderResult handler. Content items may be text or image parts; only
 * text parts carry a usable string. */
export function toolResultText(result: {
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

export function formatChange(
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
        `[added] ${TASK_STATUS_GLYPHS[task.status]} ${taskLine(task)}`,
      );
    }
  }
  return `TowerDo board revision ${view.revision} (${view.tasks.length} task(s)) by ${caller}:\n${lines.join("\n")}`;
}

export function ensureKnown(
  /** Addressable identities (knownIdentities: owners + recent activity). */
  known: ReadonlySet<string>,
  recipient: string,
): void {
  // "all" broadcasts; the orchestrator identity is always addressable.
  if (recipient === "all" || recipient === TOWER_IDENTITY) return;
  if (!known.has(recipient)) {
    throw new TowerDoValidationError(
      `unknown recipient "${recipient}" — address "all", ${TOWER_IDENTITY}, a current task owner, or someone with recent board activity (known: ${[...known].join(", ") || "(none)"})`,
    );
  }
}
