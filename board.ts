/**
 * tower-do — shared multi-agent task board (disk layer).
 *
 * Load-bearing Tower design choice: the board is a plain append-only JSONL
 * file (`<project>/.pi/tower-do/board.jsonl`), i.e. file-as-state. Any agent
 * session or subagent that can read the file can see everyone's tasks, and any
 * writer appends events. Folding events yields the current view; the
 * monotonic `revision` is derived from the file (tool-read, never
 * self-reported) and backs the stale-write guard.
 *
 * Concurrency notes: appends are serialized per process on a promise chain and
 * written with a single `O_APPEND` `write` syscall (verified on Bun 1.4/linux:
 * a 2 MB payload is one `write(2)`), so a line cannot tear *in practice* — a
 * short write is still a POSIX possibility (signal, ENOSPC, NFS), and the two
 * halves would not be atomic as a pair. The lease, not that property, is what
 * serializes writers; the O_APPEND fallback only covers the unlocked degrade
 * path. One window no userspace lease can close: a holder paused past
 * STALE_LOCK_MS between the compact's final ownership proof and its rename.
 * The compact therefore re-proves the lease right AFTER the rename and, on a
 * steal, attempts a PROVABLE reconcile under a freshly taken lease (only when
 * the live file is still its compaction plus appends and the preserved log is
 * the fold's source plus appends) — `content + P + W`, P before W. When the
 * shape cannot be proved it fails loud and keeps the pre-compact log as a
 * hard-linked evidence file (`<board>.prev-*`, named in the error); it never
 * rolls the inode back, because a rollback could clobber writes the new
 * holder made after the rename. Across processes, `append` and `compact` both
 * take a per-board write
 * LEASE (a directory whose ownership is a token file inside it); the
 * `baseRevision` guard remains the conflict-awareness layer for decision
 * races that span a read-modify-append (see `withWriteLock`).
 */

import { appendFile, link, lstat, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  createEmptyBoard,
  isEpochMs,
  normalizeIdentity,
  readPersistedFinding,
  readPersistedMessage,
  readPersistedTask,
  TOWER_DO_SCHEMA_VERSION,
  TOWER_IDENTITY,
  TowerDoValidationError,
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

/** errno code of a thrown filesystem error, or undefined for anything else. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** A held cross-process write lease. `assertHeld` re-proves ownership right
 *  before a mutation, so a holder that a peer reaped as stale (a long GC/
 *  debugger pause) fails loud instead of writing concurrently with the peer
 *  that took over — the failure the CAS in `compact` cannot detect. */
export interface BoardLease {
  assertHeld(): Promise<void>;
}

/** Lease stand-in for an APPEND that could not lock at all (read-only dir):
 *  there is no lease to verify, and a single `O_APPEND` write stays atomic. */
const UNLOCKED_LEASE: BoardLease = { assertHeld: async () => {} };

/** Cross-process lock timing (see TowerBoard.withLock).
 *
 * `LOCK_WAIT_MS` MUST exceed `STALE_LOCK_MS` (here by 5s): a waiter only sees a
 * dead holder's token as reapable one full staleness window after that holder's
 * `mkdir`, and two writers that arrive together (Tw ≈ Th, W having lost the
 * mkdir race) would otherwise reach their own deadline before reaping — timing
 * out with "locked by another writer" on exactly the crash-recovery path the
 * staleness rule exists for. */
export const STALE_LOCK_MS = 30_000;
export const LOCK_WAIT_MS = STALE_LOCK_MS + 5_000;
const LOCK_RETRY_MS = 25;
function readEvent(candidate: unknown): BoardEvent | undefined {
  if (!isRecord(candidate) || typeof candidate.kind !== "string")
    return undefined;
  if (candidate.kind === "task") {
    if (candidate.op !== "upsert" && candidate.op !== "remove")
      return undefined;
    const key = typeof candidate.key === "string" ? candidate.key : undefined;
    const by = typeof candidate.by === "string" ? candidate.by : "?";
    const at = isEpochMs(candidate.at) ? candidate.at : Date.now();
    return { kind: "task", op: candidate.op, key, by, at };
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
  if (candidate.kind === "finding" && isRecord(candidate.finding)) {
    const finding = readPersistedFinding(candidate.finding);
    const by =
      typeof candidate.by === "string" ? candidate.by : (finding?.from ?? "?");
    const at = isEpochMs(candidate.at)
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

  /** Cross-process write LEASE: `<file>.lock` is a DIRECTORY (its creation via
   * `mkdir` is atomic) holding a file named after this holder's random token.
   * `append` and `compact` both take it, so a compaction can never race a peer
   * append (previously a write landing between the CAS re-read and the rename
   * went to the unlinked inode and was lost). While held, the holder refreshes
   * its token file's mtime; only a token without a heartbeat for STALE_LOCK_MS
   * may be removed. The directory mtime cannot decide staleness: between
   * checking it and scanning its entries, a new owner may replace the directory.
   *
   * Release is safe by construction — which a `readFile` + `unlink` token check
   * is NOT (it is a TOCTOU: a stalled holder that wakes up between the read and
   * the unlink deletes the lease a peer just stole and recreated, re-opening
   * the append-vs-rename window compact exists to close). A holder only ever
   * (a) unlinks the file named after ITS OWN token, which a stealing peer
   * already removed, and (b) calls `rmdir`, which refuses a non-empty
   * directory — and the peer's token file keeps it non-empty. So a stolen
   * holder's cleanup is a no-op instead of a takeover squash.
   *
   * Reads never lock (O_APPEND makes a single append atomic).
   *
   * ACQUISITION is proved by exclusivity, not by "the mkdir did not throw": a
   * reaper that judged our (still empty) directory stale can `rmdir` it between
   * our `mkdir` and our token write, and the write then lands inside the
   * PEER's replacement directory without an error — two holders, the exact
   * outcome this lease exists to prevent. So after writing the token the
   * directory must hold exactly that token, or the token is an orphan and we
   * retry. `assertHeld` re-runs the same proof before each mutation. */
  private async withLock<T>(
    run: (lease: BoardLease) => Promise<T>,
    allowUnlocked = false,
  ): Promise<T> {
    const lock = `${this.file}.lock`;
    const token = randomUUID();
    const tokenFile = join(lock, token);
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      await mkdir(dirname(this.file), { recursive: true });
    } catch {
      // A directory we cannot create surfaces on the write itself below.
    }
    for (;;) {
      // Deadline is checked EVERY iteration: the steal/back-off paths must not
      // be able to spin forever.
      if (Date.now() > deadline) {
        throw new TowerDoValidationError(
          "board is locked by another writer — retry shortly",
        );
      }
      // `mkdir` is the atomic acquire: it either creates the lease directory or
      // fails. Only `EEXIST` means "someone else holds it"; anything else (a
      // missing parent, a non-directory on the path) is structural and must
      // fail loud rather than masquerade as contention and spin to the
      // deadline with a misleading "locked by another writer".
      let created = false;
      try {
        await mkdir(lock);
        created = true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
          // Locking is impossible (read-only dir / filesystem). An APPEND may
          // degrade to unlocked (O_APPEND keeps a single append atomic), but a
          // COMPACT must fail closed: running it unlocked would re-open the
          // append-vs-rename window this lease exists to close.
          if (allowUnlocked) return run(UNLOCKED_LEASE);
        }
        if (code !== "EEXIST") throw error;
      }
      let acquired = false;
      if (created) {
        let wrote = false;
        try {
          await writeFile(tokenFile, token, "utf8");
          wrote = true;
        } catch (error) {
          // Clean up only a lease directory still holding nothing but our own
          // (absent) token: a reaper may have replaced it already, and `rmdir`
          // would then delete a PEER's lease.
          // Unlink the token BEFORE rmdir: deleting an entry refreshes the
          // directory mtime, and a leftover empty directory with a fresh mtime
          // would not be reapable for a full STALE_LOCK_MS (spinning every
          // waiter to the deadline on a lock nobody holds).
          await unlink(tokenFile).catch(() => {});
          const entries = await this.leaseEntries(lock);
          if (entries !== undefined && entries.every((entry) => entry === token)) {
            await rmdir(lock).catch(() => {});
          }
          const code = errorCode(error);
          if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
            if (allowUnlocked) return run(UNLOCKED_LEASE);
          }
          // ONLY here can ENOENT mean contention: a stealer judged us stale and
          // removed the directory between the mkdir and the token write. Retry
          // instead of surfacing a spurious failure.
          if (code !== "ENOENT") throw error;
        }
        if (wrote) {
          if (await this.leaseIsExclusive(lock, token)) acquired = true;
          // Not exclusive: our token landed in a directory a peer re-created
          // after a reaper removed our empty one. Drop the orphan and retry
          // rather than joining a lease we do not own.
          else await unlink(tokenFile).catch(() => {});
        }
      } else {
        // Held by another writer: reap only token files that themselves
        // stopped heartbeating. A directory observed as stale can be replaced
        // before we scan it, so its mtime cannot authorize deleting its entries.
        await this.breakLock(lock);
      }
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    const lease: BoardLease = {
      assertHeld: async () => {
        if (!(await this.leaseIsExclusive(lock, token))) {
          throw new TowerDoValidationError(
            "board write lease was stolen mid-write (a peer judged this holder dead) — retry the write",
          );
        }
      },
    };
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          // Our token file is gone => we were stolen: stop refreshing, or we
          // would keep a peer's lease artificially fresh (and unstealable).
          await stat(tokenFile);
          const now = new Date();
          await utimes(tokenFile, now, now);
        } catch {
          // Lease gone (stolen or removed): stop refreshing.
        }
      })();
    }, Math.max(1000, Math.floor(STALE_LOCK_MS / 3)));
    // Never keep the host process alive just for a heartbeat.
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    try {
      return await run(lease);
    } finally {
      clearInterval(heartbeat);
      // Release only OUR lease (see the method docstring): both steps are
      // no-ops when a peer already stole and recreated it.
      await unlink(tokenFile).catch(() => {});
      await rmdir(lock).catch(() => {});
    }
  }

  /** Directory entries of a lease path, or undefined when it is gone or not a
   *  readable directory (legacy file lock / dangling symlink / released). */
  private async leaseEntries(lock: string): Promise<string[] | undefined> {
    try {
      return await readdir(lock);
    } catch {
      return undefined;
    }
  }

  /** Ownership proof for a directory lease: our token file is the ONLY entry.
   *  An empty directory means a creator is mid-acquire; any foreign entry means
   *  the directory was recycled by a peer and this holder no longer owns it. */
  private async leaseIsExclusive(
    lock: string,
    token: string,
  ): Promise<boolean> {
    const entries = await this.leaseEntries(lock);
    return (
      entries !== undefined && entries.length === 1 && entries[0] === token
    );
  }

  /** A stale observation of the directory cannot authorize deleting a new
   * owner's token after release/recreate. Each token is checked by its own
   * mtime and unlinked only by its unique name; `rmdir` can only remove an
   * empty directory. Legacy file locks and dangling symlinks are not followed. */
  private async breakLock(lock: string): Promise<void> {
    let info;
    try {
      info = await lstat(lock);
    } catch {
      return; // already released
    }
    if (!info.isDirectory()) {
      if (info.isSymbolicLink()) {
        // A symlink is never a lease (acquisition uses mkdir). Never follow it
        // into an unrelated directory, regardless of its age.
        await unlink(lock).catch(() => {});
        return;
      }
      if (Date.now() - info.mtimeMs > STALE_LOCK_MS)
        await unlink(lock).catch(() => {}); // stale legacy file lock
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(lock);
    } catch {
      return;
    }
    if (entries.length === 0) {
      // A creator can pause between mkdir and writing its token. Its empty
      // directory gets the same grace; if replaced before rmdir, the new
      // creator's token write either protects it or fails ENOENT and retries.
      if (Date.now() - info.mtimeMs > STALE_LOCK_MS)
        await rmdir(lock).catch(() => {});
      return;
    }
    for (const entry of entries) {
      const tokenFile = join(lock, entry);
      try {
        const tokenInfo = await stat(tokenFile);
        if (Date.now() - tokenInfo.mtimeMs > STALE_LOCK_MS)
          await unlink(tokenFile).catch(() => {});
      } catch {
        // Token disappeared during a concurrent release or steal.
      }
    }
    await rmdir(lock).catch(() => {});
  }

  /** Last-resort reconcile after a rename-window steal (see `compact`).
   *
   *  The rename already happened, so the peer's pre-rename appends (`P`) live
   *  only in the preserved inode while any post-rename appends (`W`) are in
   *  the live file. This restores both ONLY in the case that can be proved by
   *  byte prefixes and a CAS under a FRESHLY taken lease:
   *    - the preserved log is `raw` + `P` (its suffix is what the rename
   *      orphaned),
   *    - the live file is still `content` + `W` (nobody rewrote it), and
   *    - the live file is byte-identical at the moment of the swap.
   *  The result is `content + P + W` (P before W: LWW reads the real order).
   *  Any deviation — a peer that compacted in the window, a truncation, a
   *  lease that cannot be re-taken — returns false and the caller keeps the
   *  evidence and fails loud. Never a blind rollback, never an unlocked write. */
  private async reconcileStolenCompact(args: {
    raw: string;
    content: string;
    prev: string;
  }): Promise<boolean> {
    const { raw, content, prev } = args;
    try {
      const preserved = await readFile(prev, "utf8");
      // `P` is only well-defined as a suffix of the exact bytes we CAS'd.
      if (!preserved.startsWith(raw)) return false;
      const pending = preserved.slice(raw.length);
      if (pending.trim().length === 0) return true; // nothing was orphaned
      return await this.withLock(async (lease) => {
        const live = await readFile(this.file, "utf8");
        // Pure appends on top of our compaction are the only provable shape;
        // a peer compaction (or any rewrite) is not recoverable this way.
        if (!live.startsWith(content)) return false;
        const after = live.slice(content.length);
        const tmp = `${this.file}.reconcile-${randomUUID().slice(0, 8)}`;
        try {
          const handle = await open(tmp, "w");
          try {
            await handle.writeFile(`${content}${pending}${after}`, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          // CAS the live file at the moment of the swap.
          if ((await readFile(this.file, "utf8")) !== live) return false;
          await lease.assertHeld();
          await rename(tmp, this.file);
          // One attempt only: a second steal here is reported as `false`
          // (evidence kept, loud failure) rather than retried in a loop.
          await lease.assertHeld();
          return true;
        } finally {
          await unlink(tmp).catch(() => {});
        }
      });
    } catch {
      return false;
    }
  }

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
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return createEmptyBoard();
      }
      throw error;
    }
    const tasks = new Map<string, TowerDoTask>();
    const messages = new Map<string, TowerDoMessage>();
    const findings = new Map<string, TowerDoFinding>();
    let revision = 0;
    let skipped = 0;
    let index = 0;
    // A compact header line (Layer 3) may open the file. It carries the
    // explicit logical revision and the number of following last-wins
    // snapshot lines. Snapshot lines rebuild the maps WITHOUT bumping the
    // revision (the header already accounts for it); every line after the
    // snapshot block behaves exactly as before. No header -> legacy log.
    const lines = raw.split("\n");
    const firstIndex = lines.findIndex((line) => line.trim().length > 0);
    let start = 0;
    let snapshotLines = 0;
    if (firstIndex >= 0) {
      try {
        const header: unknown = JSON.parse(lines[firstIndex].trim());
        // Only accept a WELL-FORMED header: a compact line without a valid
        // snapshotLines would leave the snapshot block counted as ordinary
        // events (double-counting the revision), so it is ignored instead.
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
          // `header.skipped` is HISTORICAL audit metadata (how many unfoldable
          // lines the compact dropped), NOT live board state: after a
          // dropSkipped compact the board no longer holds those lines, so
          // re-reporting them as `skipped` would be false and would block
          // every future compact forever.
          snapshotLines = header.snapshotLines;
          start = firstIndex + 1;
        }
      } catch {
        // Not JSON: treated as an ordinary (skipped) legacy line below.
      }
    }
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (li === firstIndex && start !== 0) continue; // the compact header itself
      const inSnapshot = li >= start && li < start + snapshotLines;
      let candidate: unknown;
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        // Tolerate foreign/corrupt lines (they never bump the revision), but
        // COUNT them: a silently skipped line is data the board holds and no
        // participant can see, which is the silent-wrong class this extension
        // exists to prevent. `skipped` is disclosed by tower_do_status.
        skipped += 1;
        continue;
      }
      const event = readEvent(candidate);
      if (event === undefined) {
        skipped += 1;
        continue;
      }
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
          const currentOwners = [
            ...new Set(
              [...tasks.values()]
                .map((task) => task.owner)
                .filter((owner): owner is string => owner !== undefined),
            ),
          ];
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
      skipped,
    };
  }

  /** Append board events (one JSON line each), serialized per process. */
  async append(events: readonly BoardEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.serialize(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const lines = events.map((event) => `${JSON.stringify(event)}\n`);
      // Serialize against compact() across processes, not just in-process: a
      // compaction that renames the file would otherwise orphan this append.
      await this.withLock(async (lease) => {
        await lease.assertHeld();
        await appendFile(this.file, lines.join(""), "utf8");
      }, true);
    });
  }

  /** Run `fn` while holding the cross-process write lease, handing it an append
   * that does NOT re-take the lease. Use this when a DECISION must be computed
   * and acted on atomically across processes (e.g. a budget count): checking
   * then calling `append` separately is a race, because `append` only takes the
   * lease after the check. NOTE: inside `fn` you MUST use the handed
   * `appendLocked`; calling `this.append` deadlocks, because both `append` and
   * `withWriteLock` run on the same non-reentrant `serialize` chain. */
  async withWriteLock<T>(
    fn: (append: (events: readonly BoardEvent[]) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.serialize(() =>
      this.withLock(async (lease) => {
        const appendLocked = async (
          events: readonly BoardEvent[],
        ): Promise<void> => {
          if (events.length === 0) return;
          await mkdir(dirname(this.file), { recursive: true });
          const lines = events.map((event) => `${JSON.stringify(event)}\n`);
          // Re-prove ownership immediately before the write: a lease stolen
          // during this (arbitrarily long) critical section must fail loud
          // rather than append concurrently with the peer that took over.
          await lease.assertHeld();
          await appendFile(this.file, lines.join(""), "utf8");
        };
        return fn(appendLocked);
      }),
    );
  }

  /** Full event log (newest lines last). `fold()` already reads the whole
   *  file, so callers needing a COMPLETE activity view (the stale-owner
   *  permission gate, which must never misread an active owner as idle
   *  because their events fell out of a bounded tail) pay no extra
   *  asymptotic cost. I/O errors throw — a missing or unreadable file is
   *  not "no activity". */
  async rawLines(): Promise<string[]> {
    const raw = await readFile(this.file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Raw tail of the event log (newest lines last). */
  async rawTail(lines: number = 50): Promise<string[]> {
    // slice(-0) is slice(0) — the whole log — so a non-positive request must
    // be an empty tail, not a full read that looks bounded.
    if (lines <= 0) return [];
    return (await this.rawLines()).slice(-lines);
  }

  /**
   * Explicit last-wins compaction (Layer 3). Rewrites the live file as one
   * compact header plus one snapshot event per surviving entity, under a
   * content CAS: the live file is re-read after the temp file is fsynced and
   * the rename happens only if it is still byte-identical. Every crash point
   * (archive, temp write, CAS abort) leaves the old file intact. Never
   * periodic — only the orchestrator identity may call it (index.ts enforces
   * that). The header carries the logical `revision`, so a refold after
   * compaction reports exactly the revision it did before.
   *
   * The pre-compact inode is hard-linked before the rename and the lease is
   * re-proven right after it: a holder paused past STALE_LOCK_MS inside that
   * window is detected and the call fails loud. Before failing it attempts a
   * provable reconcile (see `reconcileStolenCompact`) that restores the
   * window's writes as `content + P + W` under a freshly taken lease; when the
   * shape cannot be proved it keeps the preserved log as evidence instead of
   * guessing. Nothing is ever rolled back blindly.
   */
  async compact(options: {
    by: string;
    archive?: boolean;
    dropSkipped?: boolean;
    now?: number;
    /** Test-only seam: async hooks that fire at the CAS and pre-rename crash
     * points so the abort/atomicity behaviour can be asserted deterministically.
     * Never set by production callers. */
    testHooks?: {
      beforeCasCheck?: () => Promise<void> | void;
      beforeRename?: () => Promise<void> | void;
      /** Between the final ownership proof/CAS and the rename: simulates a
       *  steal in the pre-rename window. */
      beforeSwap?: () => Promise<void> | void;
      /** Between the rename and the post-rename ownership re-proof: simulates
       *  a steal whose peer writes land AFTER the rename. */
      afterSwap?: () => Promise<void> | void;
    };
  }): Promise<{
    revision: number;
    kept: { tasks: number; messages: number; findings: number };
    bytesBefore: number;
    bytesAfter: number;
    archived?: string;
  }> {
    return this.serialize(() =>
      this.withLock(async (lease) => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          throw new TowerDoValidationError(
            "nothing to compact: the board file does not exist",
          );
        }
        throw error;
      }
      const sourceSha256 = createHash("sha256").update(raw).digest("hex");
      const bytesBefore = Buffer.byteLength(raw, "utf8");
      const view = await this.fold();
      if (view.skipped > 0 && options.dropSkipped !== true) {
        throw new TowerDoValidationError(
          `refusing to compact: ${String(view.skipped)} log line(s) could not be folded and compaction would drop them. Fix the log, or pass dropSkipped=true to discard them explicitly (recorded in the compact header).`,
        );
      }
      const now = options.now ?? Date.now();
      // Preserve the per-owner/per-task activity clock across the rewrite: the
      // snapshot event's `at` is what the activity feed and the stale-owner
      // takeover derivation read, so stamping every row with `task.updatedAt`
      // would credit an owner with a LATER edit made by someone else (a
      // takeover or a `tower` edit) and silently revoke/grant a takeover
      // after a gc.
      const taskClock = new Map<string, number>();
      // Findings store only the filer (`from`), never the last actor; a
      // snapshot that stamped `by: finding.from` with the transition's `at`
      // would credit a peer's status change to the filer and make a dead filer
      // look freshly active after a gc. Recover the latest event's writer per
      // finding id from the raw log.
      const findingActor = new Map<string, { by: string; at: number }>();
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let candidate: unknown;
        try {
          candidate = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const event = readEvent(candidate);
        if (event === undefined) continue;
        if (event.kind === "task" && event.key !== undefined) {
          const clockKey = `${event.by}\u0000${event.key}`;
          const prior = taskClock.get(clockKey);
          if (prior === undefined || event.at > prior) {
            taskClock.set(clockKey, event.at);
          }
        } else if (event.kind === "finding" && event.finding !== undefined) {
          const id = event.finding.id;
          const prior = findingActor.get(id);
          if (prior === undefined || event.at > prior.at) {
            findingActor.set(id, { by: event.by, at: event.at });
          }
        }
      }
      const snapshotEvents: BoardEvent[] = [];
      for (const task of view.tasks) {
        const clock =
          task.owner === undefined
            ? undefined
            : taskClock.get(`${task.owner}\u0000${task.key}`);
        snapshotEvents.push({
          kind: "task",
          op: "upsert",
          key: task.key,
          task,
          // Attribute the snapshot to the actual owner, not the compactor: the
          // activity feed / presence derivation reads `by`, and crediting
          // `tower` would make every owner look freshly active after a gc.
          by: task.owner ?? options.by,
          // The owner's real last activity on this task when the log has it;
          // the row's `updatedAt` only when the owner never touched it.
          at: clock ?? task.updatedAt,
        });
      }
      for (const message of view.messages) {
        snapshotEvents.push({
          kind: "message",
          message,
          by: message.from,
          at: message.at,
        });
      }
      for (const finding of view.findings) {
        snapshotEvents.push({
          kind: "finding",
          finding,
          by: findingActor.get(finding.id)?.by ?? finding.from,
          at: finding.at,
        });
      }
      const header = {
        kind: "compact",
        revision: view.revision,
        at: now,
        by: options.by,
        sourceSha256,
        skipped: view.skipped,
        snapshotLines: snapshotEvents.length,
        counts: {
          tasks: view.tasks.length,
          messages: view.messages.length,
          findings: view.findings.length,
        },
      };
      const content = `${[JSON.stringify(header), ...snapshotEvents.map((event) => JSON.stringify(event))].join("\n")}\n`;
      // Only the archive PATH is decided here; the write happens after the CAS
      // passes, immediately before the rename. Writing it earlier leaves an
      // archive that claims a compaction which then aborted.
      let archived: string | undefined;
      if (options.archive === true) {
        const dir = join(dirname(this.file), "archive");
        await mkdir(dir, { recursive: true });
        const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        archived = join(
          dir,
          `board-rev${String(view.revision)}-${stamp}.jsonl`,
        );
      }
      const tmp = `${this.file}.tmp`;
      // Track what a failed compact must clean up: an archive written for a
      // swap that never happened describes a compaction that did not occur.
      let archivedWritten = false;
      let renamed = false;
      // CAS: with the write lease held no well-behaved peer can append here,
      // but an unlocked writer (older extension) still could. Re-check right
      // before the rename so the exposure window is one syscall wide.
      const assertUnchanged = async (): Promise<void> => {
        let liveNow: string;
        try {
          liveNow = await readFile(this.file, "utf8");
        } catch {
          throw new TowerDoValidationError(
            "compaction aborted: the board file disappeared mid-compact",
          );
        }
        if (
          createHash("sha256").update(liveNow).digest("hex") !== sourceSha256
        ) {
          throw new TowerDoValidationError(
            "compaction aborted: a peer appended to the board since the fold — re-read and retry",
          );
        }
      };
      try {
        // The WHOLE write is guarded so a failure in open/write/sync/close
        // also removes a partial temp file, not just a CAS/rename failure.
        const handle = await open(tmp, "w");
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await options.testHooks?.beforeCasCheck?.();
        await assertUnchanged();
        await options.testHooks?.beforeRename?.();
        // PRESERVE the pre-compact inode before the swap (hard link): if the
        // lease is stolen in the rename window — this holder paused past
        // STALE_LOCK_MS between the proof below and the rename — a peer's
        // pre-rename appends landed in THIS inode and the rename would
        // orphan them. The link keeps them as evidence.
        const prev = `${this.file}.prev-${randomUUID().slice(0, 8)}`;
        let keepPrev = false;
        await link(this.file, prev);
        try {
          // Final ownership proof: a compact must never rename over a board
          // a peer now owns (its own rename would then land on a lost
          // append).
          await lease.assertHeld();
          let liveNow: string;
          try {
            // Read through the link: these are exactly the bytes the rename
            // will swap away, so the CAS covers the preserved inode too.
            liveNow = await readFile(prev, "utf8");
          } catch {
            throw new TowerDoValidationError(
              "compaction aborted: the board file disappeared mid-compact",
            );
          }
          if (
            createHash("sha256").update(liveNow).digest("hex") !==
            sourceSha256
          ) {
            throw new TowerDoValidationError(
              "compaction aborted: a peer appended to the board since the fold — re-read and retry",
            );
          }
          // Archive LAST before the swap: the CAS just proved `raw` is still
          // the live content, and an abort before the rename must leave no
          // archive behind. The flag is set BEFORE the write so a partial
          // archive is removed on any later abort too.
          if (archived !== undefined) {
            archivedWritten = true;
            await writeFile(archived, raw, "utf8");
          }
          await options.testHooks?.beforeSwap?.();
          // The path must still name the preserved inode. A peer that
          // compacted in this window (stolen lease, or an older unlocked
          // writer) renamed a NEW inode over the path; our rename would then
          // silently swap that peer's board away, and `prev`/`raw` (the OLD
          // inode) cannot reveal it — the reconcile would see an empty
          // `pending` and falsely report a provable recovery. Abort before the
          // swap instead: nothing is lost, the peer's board stays live.
          let liveIno: number;
          let prevIno: number;
          try {
            liveIno = (await stat(this.file)).ino;
            prevIno = (await stat(prev)).ino;
          } catch {
            throw new TowerDoValidationError(
              "compaction aborted: the board file disappeared mid-compact",
            );
          }
          if (liveIno !== prevIno) {
            throw new TowerDoValidationError(
              "compaction aborted: a peer replaced the board in the rename window — re-read and retry (the peer's board is live and untouched)",
            );
          }
          await rename(tmp, this.file);
          renamed = true;
          await options.testHooks?.afterSwap?.();
          // The rename WINDOW closes here. A holder paused past
          // STALE_LOCK_MS between the proof above and this line resumes to
          // find the lease stolen and a peer already writing. Detect it and
          // fail LOUD. Do NOT roll the inode back: the holder that took over
          // may already have written AFTER our rename, and restoring would
          // clobber those writes — a rollback is not a CAS. Instead attempt a
          // PROVABLE reconcile: re-take the lease and, only if the live file
          // is still our compaction plus appends and the preserved log is
          // `raw` plus appends, rebuild `content + P + W` under the same
          // CAS+lease discipline (P before W, preserving real-time LWW
          // order). Anything unprovable keeps the evidence and stays loud.
          try {
            await lease.assertHeld();
          } catch {
            const recovered = await this.reconcileStolenCompact({
              raw,
              content,
              prev,
            });
            keepPrev = !recovered;
            throw new TowerDoValidationError(
              recovered
                ? "board write lease was stolen in the compact's rename window (this holder was paused past the staleness limit) — the compacted board is live and any peer writes from the window were preserved (reconciled under a fresh lease); re-read the board"
                : `board write lease was stolen in the compact's rename window (this holder was paused past the staleness limit) — the compacted board is live, but writes a peer made between the fold and the rename could not be provably restored; the pre-compact log is preserved at ${prev}`,
            );
          }
          await unlink(prev).catch(() => {});
        } catch (error) {
          if (!keepPrev) await unlink(prev).catch(() => {});
          throw error;
        }
      } catch (error) {
        await unlink(tmp).catch(() => {});
        // A compaction that did not swap must not leave an archive claiming it
        // did; also removes a half-written archive from a failed writeFile.
        if (archivedWritten && !renamed && archived !== undefined) {
          await unlink(archived).catch(() => {});
        }
        throw error;
      }
      return {
        revision: view.revision,
        kept: {
          tasks: view.tasks.length,
          messages: view.messages.length,
          findings: view.findings.length,
        },
        bytesBefore,
        bytesAfter: Buffer.byteLength(content, "utf8"),
        ...(archived === undefined ? {} : { archived }),
      };
      }),
    );
  }
}

export interface TowerDoConfig {
  /**
   * Optional fixed identity; otherwise resolved from the session. The ONLY
   * user-configurable key — every other tuning constant lives in index.ts
   * (internal, never user-facing; see DECISIONS.md).
   */
  identity?: string;
}

/**
 * Validate config.json. Fail loud: a silently-reset config would drop a
 * pinned identity and corrupt owner matching / message addressing. Unknown
 * keys are ignored (forward compatibility after retired knobs).
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
