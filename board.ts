/**
 * tower-do — shared multi-agent WIP board (disk layer).
 *
 * Load-bearing Tower design choice: the board is a plain append-only JSONL
 * file (`<project>/.pi/tower-do/board.jsonl`), i.e. file-as-state. Any agent
 * session or subagent that can read the file can see everyone's WIP, and any
 * writer appends events. Folding events yields the current view; the
 * monotonic `revision` is derived from the file (tool-read, never
 * self-reported) and backs the stale-write guard.
 *
 * Concurrency notes: appends are serialized per process on a promise chain
 * and use O_APPEND single-write syscalls, so interleaved writers cannot tear
 * a line. Cross-process writers rely on the baseRevision guard for
 * conflict awareness (last writer wins otherwise) — the same rough edge as
 * Tower's "no cross-process mutex, single-tower assumption" (risk ledger
 * 9/11 in the upstream port).
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createEmptyBoard,
  readPersistedFinding,
  readPersistedMessage,
  readPersistedTask,
  TOWER_DO_SCHEMA_VERSION,
  type TowerBoardView,
  type TowerDoFinding,
  type TowerDoMessage,
  type TowerDoTask,
} from "./state.ts";

export interface BoardEvent {
  kind: "task" | "message" | "finding";
  op?: "upsert" | "remove";
  key?: string;
  task?: TowerDoTask;
  message?: TowerDoMessage;
  finding?: TowerDoFinding;
  by: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function readEvent(candidate: unknown): BoardEvent | undefined {
  if (!isRecord(candidate) || typeof candidate.kind !== "string")
    return undefined;
  if (candidate.kind === "task") {
    if (candidate.op !== "upsert" && candidate.op !== "remove")
      return undefined;
    const key = typeof candidate.key === "string" ? candidate.key : undefined;
    const by = typeof candidate.by === "string" ? candidate.by : "?";
    const at = typeof candidate.at === "number" ? candidate.at : Date.now();
    return { kind: "task", op: candidate.op, key, by, at };
  }
  if (candidate.kind === "message" && isRecord(candidate.message)) {
    const message = readPersistedMessage(candidate.message);
    const by =
      typeof candidate.by === "string" ? candidate.by : (message?.from ?? "?");
    const at =
      typeof candidate.at === "number"
        ? candidate.at
        : (message?.at ?? Date.now());
    if (!message) return undefined;
    return { kind: "message", message, by, at };
  }
  if (candidate.kind === "finding" && isRecord(candidate.finding)) {
    const finding = readPersistedFinding(candidate.finding);
    const by =
      typeof candidate.by === "string" ? candidate.by : (finding?.from ?? "?");
    const at =
      typeof candidate.at === "number"
        ? candidate.at
        : (finding?.at ?? Date.now());
    if (!finding) return undefined;
    return { kind: "finding", finding, by, at };
  }
  return undefined;
}

export class TowerBoard {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Fold the full event log into the current board view (source of truth). */
  async fold(): Promise<TowerBoardView> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return createEmptyBoard();
    }
    const tasks = new Map<string, TowerDoTask>();
    const messages = new Map<string, TowerDoMessage>();
    const findings = new Map<string, TowerDoFinding>();
    let revision = 0;
    let index = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        continue; // tolerate foreign/corrupt lines; they never bump the revision
      }
      const event = readEvent(candidate);
      if (event === undefined) continue;
      if (event.kind === "task") {
        if (event.op === "remove") {
          if (event.key !== undefined) {
            tasks.delete(event.key);
            revision += 1;
          }
          continue;
        }
        // The task payload is nested under `task` in the event line — parse
        // that, not the whole event record.
        if (
          event.key === undefined ||
          !isRecord(candidate) ||
          !isRecord(candidate.task)
        )
          continue;
        const plain = readPersistedTask(candidate.task, index);
        if (plain === undefined) continue;
        revision += 1;
        const updatedAt =
          isRecord(candidate.task) &&
          typeof candidate.task.updatedAt === "number"
            ? candidate.task.updatedAt
            : event.at;
        tasks.set(event.key, { ...plain, updatedAt });
        index += 1;
        continue;
      }
      if (event.kind === "message" && event.message !== undefined) {
        // LWW by id (same as findings): a later event carrying the same id
        // (e.g. a read/ack update) replaces the earlier snapshot instead of
        // accumulating duplicate message rows in the folded view.
        const message = event.message;
        const foldedSoFar = messages.get(message.id);
        if (message.to === "all" && message.audience === undefined) {
          // Back-fill the audience snapshot for pre-audience broadcasts. The
          // tasks map at THIS replay point mirrors the board when the event
          // was written (the log is in order), which is exactly the owners
          // the broadcast could address. Deriving from the map rather than an
          // incrementally-maintained owner set stays correct across owner
          // transfers (upsert that swaps owner without a remove). Keep an
          // already-folded audience if a later re-emission (ack) lacks one.
          const currentOwners = [...tasks.values()]
            .map((task) => task.owner)
            .filter((owner): owner is string => owner !== undefined);
          const audience =
            foldedSoFar?.audience ??
            currentOwners.filter((owner) => owner !== message.from);
          messages.set(message.id, { ...message, audience });
        } else {
          messages.set(message.id, message);
        }
        continue;
      }
      if (event.kind === "finding" && event.finding !== undefined) {
        findings.set(event.finding.id, event.finding); // LWW by id
      }
    }
    const orderedTasks = [...tasks.values()];
    orderedTasks.sort((a, b) => a.updatedAt - b.updatedAt);
    const orderedMessages = [...messages.values()];
    orderedMessages.sort((a, b) => a.at - b.at);
    return {
      schemaVersion: TOWER_DO_SCHEMA_VERSION,
      revision,
      tasks: orderedTasks,
      messages: orderedMessages,
      findings: [...findings.values()],
    };
  }

  /** Append board events (one JSON line each), serialized per process. */
  async append(events: readonly BoardEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.serialize(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const lines = events.map((event) => `${JSON.stringify(event)}\n`);
      await appendFile(this.file, lines.join(""), "utf8");
    });
  }

  /** Raw tail of the event log (newest lines last), for activity views. */
  async rawTail(lines: number = 50): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-lines);
  }
}

export interface TowerDoConfig {
  /** Optional fixed identity; otherwise resolved from the session. */
  identity?: string;
  /** Inject a board-reconciliation reminder every N LLM calls (0 = off). */
  reminderInterval: number;
  /** Widget collapsed task limit (completed hidden unless expanded). */
  collapsedTaskLimit: number;
  /** How many recent activity-log lines the status tool shows. */
  activityTail: number;
  /**
   * Max folded messages kept after fully-read ones are retired. Unread or
   * partially-read messages always survive; this bounds how many *done*
   * (every addressee has read them) messages the view retains so history
   * exits instead of accumulating forever. 0 = keep all (legacy).
   */
  messageRetention: number;
}

export const DEFAULT_TOWER_DO_CONFIG: TowerDoConfig = {
  reminderInterval: 3,
  collapsedTaskLimit: 3,
  activityTail: 8,
  messageRetention: 50,
};

export function normalizeBoardConfig(value: unknown): TowerDoConfig {
  if (!value || typeof value !== "object")
    return { ...DEFAULT_TOWER_DO_CONFIG };
  const input = value as {
    identity?: unknown;
    reminderInterval?: unknown;
    collapsedTaskLimit?: unknown;
    activityTail?: unknown;
    messageRetention?: unknown;
  };
  const reminderInterval =
    typeof input.reminderInterval === "number" &&
    Number.isInteger(input.reminderInterval) &&
    input.reminderInterval >= 0 &&
    input.reminderInterval <= 20
      ? input.reminderInterval
      : DEFAULT_TOWER_DO_CONFIG.reminderInterval;
  const collapsedTaskLimit =
    typeof input.collapsedTaskLimit === "number" &&
    Number.isInteger(input.collapsedTaskLimit) &&
    input.collapsedTaskLimit >= 1 &&
    input.collapsedTaskLimit <= 10
      ? input.collapsedTaskLimit
      : DEFAULT_TOWER_DO_CONFIG.collapsedTaskLimit;
  const activityTail =
    typeof input.activityTail === "number" &&
    Number.isInteger(input.activityTail) &&
    input.activityTail >= 1 &&
    input.activityTail <= 50
      ? input.activityTail
      : DEFAULT_TOWER_DO_CONFIG.activityTail;
  const messageRetention =
    typeof input.messageRetention === "number" &&
    Number.isInteger(input.messageRetention) &&
    input.messageRetention >= 0 &&
    input.messageRetention <= 10_000
      ? input.messageRetention
      : DEFAULT_TOWER_DO_CONFIG.messageRetention;
  // identity is used in exact comparisons (owner / message recipient); keep it
  // a single line and bounded so a misconfigured value cannot garble matching.
  const rawIdentity =
    typeof input.identity === "string" ? input.identity.trim() : "";
  const identity =
    rawIdentity &&
    rawIdentity.length <= 64 &&
    !/[\r\n\u2028\u2029]/.test(rawIdentity)
      ? rawIdentity
      : undefined;
  return {
    ...(identity === undefined ? {} : { identity }),
    reminderInterval,
    collapsedTaskLimit,
    activityTail,
    messageRetention,
  };
}

export function readBoardConfig(value: unknown): TowerDoConfig {
  return normalizeBoardConfig(value);
}
