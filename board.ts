/**
 * tower-do — shared multi-agent task board (disk layer).
 *
 * The board is a plain append-only JSONL file (one per project, under
 * `~/.pi/tower-do/<slug>-<hash>/board.jsonl`), i.e. file-as-state. Any agent
 * session or subagent that can read the file sees the same tasks; folding the
 * events yields the current view, and the monotonic `revision` is derived from
 * the file (never self-reported) and backs the stale-write guard.
 *
 * Concurrency: appends are serialized per process on a promise chain and
 * written as ONE `open(O_APPEND)` + `write(2)` call, so two processes appending
 * concurrently cannot interleave inside a batch. There is no cross-process
 * lease and no log compaction: the log only grows by the events actually
 * written (one per changed entity), and folding a few hundred kilobytes is
 * cheap. A future `gc` can be added with its own concurrency proof, but it is
 * an optimisation, never a correctness requirement.
 *
 * Readers never lock and never mutate. `fold()` treats a missing file as an
 * empty board; any other read error throws (an unreadable file must not look
 * like a cleared board).
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createEmptyBoard,
  isEpochMs,
  isRecord,
  normalizeIdentity,
  readPersistedMessage,
  readPersistedTask,
  sameAgent,
  TOWER_DO_SCHEMA_VERSION,
  TOWER_IDENTITY,
  TowerDoValidationError,
  type TowerBoardView,
  type TowerDoMessage,
  type TowerDoTask,
} from "./state.ts";

export interface BoardEvent {
  kind: "task" | "message";
  op?: "upsert" | "remove";
  key?: string;
  task?: TowerDoTask;
  message?: TowerDoMessage;
  by: string;
  at: number;
}

/** errno code of a thrown filesystem error, or undefined for anything else. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** One O_APPEND write per batch: the kernel appends the whole buffer before
 *  any other O_APPEND writer can, so a peer never sees half a batch. */
async function appendBatch(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.write(text, null, "utf8");
  } finally {
    await handle.close();
  }
}

const ignored: unique symbol = Symbol("ignored");
type ReadEventResult = BoardEvent | typeof ignored | undefined;

function readEvent(candidate: unknown): ReadEventResult {
  if (!isRecord(candidate) || typeof candidate.kind !== "string")
    return undefined;
  if (candidate.kind === "compact") {
    // A pre-compaction header from an older writer. Compaction no longer
    // exists, but old files open with one — it is valid and must not be
    // counted as an unfoldable line.
    return ignored;
  }
  if (candidate.kind === "task") {
    if (candidate.op !== "upsert" && candidate.op !== "remove")
      return undefined;
    const key = typeof candidate.key === "string" ? candidate.key : undefined;
    const by = typeof candidate.by === "string" ? candidate.by : "?";
    // No `Date.now()` fallback: a task event's `at` IS the identity/ownership
    // clock (the fold falls back to it for a missing `updatedAt`). Fabricating
    // it would make the fold non-deterministic between reads and report a
    // corrupt line as permanently fresh.
    if (!isEpochMs(candidate.at)) return undefined;
    return { kind: "task", op: candidate.op, key, by, at: candidate.at };
  }
  if (candidate.kind === "message" && isRecord(candidate.message)) {
    const message = readPersistedMessage(candidate.message);
    const by =
      typeof candidate.by === "string" ? candidate.by : (message?.from ?? "?");
    const at = isEpochMs(candidate.at)
      ? candidate.at
      : (message?.at ?? Date.now());
    if (!message) return undefined;
    return { kind: "message", message, by, at };
  }
  // Findings are retired from the product: legacy lines are valid history, not
  // corrupt, so they are ignored rather than counted as unfoldable.
  if (candidate.kind === "finding") return ignored;
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

  /** Fold the full event log into the current board view (source of truth).
   *  A missing file is an empty board; any other read error throws — a
   *  permission failure must not look like `tower_do tasks: []`. */
  async fold(): Promise<TowerBoardView> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return createEmptyBoard();
      }
      throw error;
    }
    const tasks = new Map<string, TowerDoTask>();
    const messages = new Map<string, TowerDoMessage>();
    let revision = 0;
    let skipped = 0;
    let index = 0;
    // A legacy compact header may open the file (written by a version that had
    // compaction). It carries the logical `revision` and the number of
    // following last-wins snapshot lines; those lines rebuild the maps WITHOUT
    // bumping the revision (the header already accounts for it).
    const lines = raw.split("\n");
    const firstIndex = lines.findIndex((line) => line.trim().length > 0);
    let start = 0;
    let snapshotLines = 0;
    if (firstIndex >= 0) {
      try {
        const header: unknown = JSON.parse(lines[firstIndex].trim());
        if (
          isRecord(header) &&
          header.kind === "compact" &&
          typeof header.revision === "number" &&
          Number.isSafeInteger(header.revision) &&
          header.revision >= 0 &&
          typeof header.snapshotLines === "number" &&
          Number.isSafeInteger(header.snapshotLines) &&
          header.snapshotLines >= 0
        ) {
          revision = header.revision;
          snapshotLines = header.snapshotLines;
          start = firstIndex + 1;
        }
      } catch {
        // Not JSON: treated as an ordinary (skipped) legacy line below.
      }
    }
    // Snapshot membership is counted by CONSUMED snapshot events, not by
    // physical line index: a blank, foreign, or unfoldable line inside the
    // block must not let the trailing snapshot events fall outside it and bump
    // the revision the block is not allowed to bump.
    let snapshotConsumed = 0;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (li === firstIndex && start !== 0) continue; // the compact header itself
      const inSnapshot = start !== 0 && snapshotConsumed < snapshotLines;
      let candidate: unknown;
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        // Tolerate foreign/corrupt lines (they never bump the revision), but
        // COUNT them: a silently skipped line is data the board holds and no
        // participant can see.
        skipped += 1;
        continue;
      }
      const event = readEvent(candidate);
      if (event === ignored) continue;
      if (event === undefined) {
        skipped += 1;
        continue;
      }
      // Only a line the fold can turn into an event was written as a snapshot
      // row, so only it consumes a snapshot slot.
      if (inSnapshot) snapshotConsumed += 1;
      if (event.kind === "task") {
        if (event.op === "remove") {
          if (event.key !== undefined) {
            tasks.delete(event.key);
            if (!inSnapshot) revision += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
        // The task payload is nested under `task` in the event line — parse
        // that, not the whole event record.
        if (
          event.key === undefined ||
          !isRecord(candidate) ||
          !isRecord(candidate.task)
        ) {
          skipped += 1;
          continue;
        }
        const plain = readPersistedTask(candidate.task, index);
        if (plain === undefined) {
          // A payload that no longer validates under the CURRENT limits (a
          // retuned cap, a schema change, a torn append) must not vanish
          // silently: the row stays in the log and is reported as skipped.
          skipped += 1;
          continue;
        }
        if (!inSnapshot) revision += 1;
        const updatedAt =
          isRecord(candidate.task) && isEpochMs(candidate.task.updatedAt)
            ? candidate.task.updatedAt
            : event.at;
        tasks.set(event.key, { ...plain, updatedAt });
        index += 1;
        continue;
      }
      if (event.kind === "message" && event.message !== undefined) {
        // LWW by id: a later event carrying the same id (a read/ack update)
        // replaces the earlier row instead of accumulating duplicates.
        const message = event.message;
        const foldedSoFar = messages.get(message.id);
        if (message.to === "all" && message.audience === undefined) {
          // Back-fill the audience snapshot for pre-audience broadcasts. The
          // tasks map at THIS replay point mirrors the board when the event was
          // written, which is exactly the owners the broadcast could address.
          const currentOwners = [
            ...new Set(
              [...tasks.values()]
                .map((task) => task.owner)
                .filter((owner): owner is string => owner !== undefined),
            ),
          ];
          const audience =
            foldedSoFar?.audience ??
            // Exclude the sender by AGENT, so a legacy label of the same
            // session is not left in the audience (a self-broadcast can never
            // be acked).
            currentOwners.filter((owner) => !sameAgent(owner, message.from));
          messages.set(message.id, { ...message, audience });
        } else {
          messages.set(message.id, message);
        }
        continue;
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
      skipped,
    };
  }

  /** Append board events (one JSON line each), serialized per process. */
  async append(events: readonly BoardEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.serialize(async () => {
      const lines = events.map((event) => `${JSON.stringify(event)}\n`);
      await appendBatch(this.file, lines.join(""));
    });
  }

  /** Run `fn` while holding the in-process write chain, handing it an append
   *  that does NOT re-enter it. Use this when a DECISION must be computed and
   *  acted on without another local write interleaving (e.g. a budget count);
   *  checking and then calling `append` separately would let a local writer slip
   *  in between. The `baseRevision` file guard covers cross-process races.
   *  NOTE: inside `fn` you MUST use the handed append; calling `this.append`
   *  deadlocks, because both share the non-reentrant `serialize` chain. */
  async withWrite<T>(
    fn: (append: (events: readonly BoardEvent[]) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      const append = async (
        events: readonly BoardEvent[],
      ): Promise<void> => {
        if (events.length === 0) return;
        const lines = events.map((event) => `${JSON.stringify(event)}\n`);
        await appendBatch(this.file, lines.join(""));
      };
      return fn(append);
    });
  }

  /** Full event log (oldest lines first). I/O errors throw — a missing or
   *  unreadable file is not "no activity". */
  async rawLines(): Promise<string[]> {
    const raw = await readFile(this.file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Raw tail of the event log (newest lines last). */
  async rawTail(lines: number = 50): Promise<string[]> {
    // slice(-0) is slice(0) — the whole log — so a non-positive request must be
    // an empty tail, not a full read that looks bounded. `!Number.isFinite`
    // also catches NaN, for which `NaN <= 0` is false and `slice(-NaN)`
    // silently becomes `slice(0)`.
    if (!Number.isFinite(lines) || lines <= 0) return [];
    return (await this.rawLines()).slice(-lines);
  }
}

export interface TowerDoConfig {
  /**
   * Optional fixed identity; otherwise resolved from the session. The ONLY
   * user-configurable key — every other tuning constant lives in index.ts
   * (internal, never user-facing).
   */
  identity?: string;
}

/**
 * Validate config.json. Fail loud: a silently-reset config would drop a pinned
 * identity and corrupt owner matching / message addressing. Unknown keys are
 * ignored (forward compatibility after retired knobs).
 */
export function normalizeBoardConfig(value: unknown): TowerDoConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TowerDoValidationError(
      "tower-do config.json must contain a JSON object",
    );
  }
  const rawIdentity = (value as Record<string, unknown>).identity;
  if (rawIdentity === undefined) return {};
  if (typeof rawIdentity !== "string") {
    throw new TowerDoValidationError('config key "identity" must be a string');
  }
  const identity = normalizeIdentity(rawIdentity, 'config key "identity"');
  if (identity === TOWER_IDENTITY) {
    throw new TowerDoValidationError(
      `config key "identity" must not be the reserved orchestrator identity "${TOWER_IDENTITY}"`,
    );
  }
  return { identity };
}
