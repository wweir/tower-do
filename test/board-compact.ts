/**
 * tower-do log compaction (Layer 3) regression.
 *
 * The board log is append-only, so view retirement alone never shrinks it. The
 * compact is the ONLY mechanism that bounds the file, and it is deliberately
 * explicit (never periodic), `tower`-only, CAS-guarded, and crash-safe. This
 * file locks:
 *   1. A refold after compaction reports exactly the revision it did before
 *      (so a caller's `baseRevision` is never invalidated by a compact).
 *   2. Every surviving entity (completed tasks, messages, findings) is kept.
 *   3. A peer append between the fold and the rename aborts the compact and
 *      leaves the live file untouched.
 *   4. A crash before the rename leaves the live file untouched.
 *   5. Unfoldable lines block compaction unless explicitly dropped, and the
 *      dropped count stays disclosed in the header.
 *   6. Appends after a compact keep the revision monotonic.
 *   7. A stolen lease survives the old holder's release (a read-then-unlink
 *      token check would delete it and re-open the compaction race).
 *   8. Ownership is proved by EXCLUSIVITY: an empty stale lease directory is
 *      reaped and its reaper becomes the sole owner, and a foreign token in
 *      the directory (a token that landed in a peer's re-created lease) makes
 *      the holder fail loud instead of renaming over the board.
 *   9. A lease steal inside the rename window (holder paused past
 *      STALE_LOCK_MS) fails LOUD. When provable it reconciles the window's
 *      writes back into the live fold under a fresh lease (`content + P + W`);
 *      when not (a peer compacted in the window) it keeps the pre-compact log
 *      as a hard-linked evidence file — it never rolls back, so a holder that
 *      took over mid-window keeps every post-rename write.
 *
 * Run: bun test/board-compact.ts
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TowerBoard, LOCK_WAIT_MS, STALE_LOCK_MS } from "../board.ts";
import {
  claimKey,
  parseActivityLine,
  staleTaskClaims,
  writeBoardSnapshot,
  type ActivityEntry,
} from "../state.ts";

let failures = 0;
let passed = 0;

function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label} ${extra ? "— " + extra : ""}`);
  }
}

async function expectRejects(
  label: string,
  fn: () => Promise<unknown>,
  match: RegExp,
): Promise<void> {
  try {
    await fn();
    check(label, false, "expected a rejection but it resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), message.slice(0, 140));
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tower-do-compact-"));
  const file = join(dir, "board.jsonl");
  const board = new TowerBoard(file);
  const now = Date.now();

  // Seed: an in-progress + completed task (with a receipt), a message, a
  // finding, plus a couple of superseded upserts to make the log span lines.
  const seed = writeBoardSnapshot(
    await board.fold(),
    {
      tasks: [
        { key: "live", subject: "in progress", status: "in_progress", owner: "alice" },
        {
          key: "done",
          subject: "delivered",
          status: "completed",
          owner: "alice",
          changedFiles: ["src/x.ts"],
        },
      ],
    },
    "tower",
  );
  await board.append(seed.taskEvents);
  const mid = writeBoardSnapshot(
    await board.fold(),
    {
      tasks: [
        { key: "live", subject: "in progress (edited)", status: "in_progress", owner: "alice" },
        {
          key: "done",
          subject: "delivered",
          status: "completed",
          owner: "alice",
          changedFiles: ["src/x.ts"],
        },
      ],
    },
    "tower",
  );
  await board.append(mid.taskEvents);
  // Churn the same row so superseded upserts dominate the log — the case
  // compaction exists for.
  for (let i = 0; i < 40; i += 1) {
    const churn = writeBoardSnapshot(
      await board.fold(),
      {
        tasks: [
          {
            key: "live",
            subject: `in progress ${String(i)}`,
            status: "in_progress",
            owner: "alice",
          },
          {
            key: "done",
            subject: "delivered",
            status: "completed",
            owner: "alice",
            changedFiles: ["src/x.ts"],
          },
        ],
      },
      "tower",
    );
    await board.append(churn.taskEvents);
  }
  await board.append([
    {
      kind: "message",
      message: {
        id: "m-1",
        to: "all",
        from: "alice",
        subject: "hello",
        body: "body",
        at: now,
      },
      by: "alice",
      at: now,
    },
    {
      kind: "finding",
      finding: {
        id: "f-1",
        kind: "bug",
        title: "a bug",
        severity: "high",
        status: "open",
        summary: "s",
        from: "alice",
        at: now,
      },
      by: "alice",
      at: now,
    },
  ]);

  const before = await board.fold();
  const preCompactRaw = readFileSync(file, "utf8");
  const bytesBefore = preCompactRaw.length;
  check(
    "pre-compact board is not empty",
    before.revision > 0 && before.tasks.length === 2,
    `rev=${before.revision}`,
  );

  const result = await board.compact({ by: "tower", archive: true });
  const after = await board.fold();
  check(
    "compact preserves the logical revision",
    after.revision === before.revision,
    `${after.revision} vs ${before.revision}`,
  );
  check(
    "compact keeps every surviving entity (incl. the completed receipt)",
    after.tasks.length === 2 &&
      after.messages.length === 1 &&
      after.findings.length === 1 &&
      after.tasks.find((task) => task.key === "done")?.changedFiles?.[0] ===
        "src/x.ts",
  );
  check(
    "compact shrinks the file but keeps the current text",
    result.bytesAfter < bytesBefore &&
      after.tasks.find((task) => task.key === "live")?.subject ===
        "in progress 39",
    `${result.bytesBefore} -> ${result.bytesAfter}`,
  );
  check(
    "compact archives the previous log",
    result.archived !== undefined && existsSync(result.archived),
    result.archived,
  );
  const compactHead = JSON.parse(
    readFileSync(file, "utf8").split("\n")[0],
  ) as { snapshotLines?: number; sourceSha256?: string };
  check(
    "the compact header records the source hash and kept counts",
    (compactHead.snapshotLines ?? 0) === 4,
    JSON.stringify(compactHead.snapshotLines),
  );
  check(
    "the compact header's sourceSha256 hashes the exact pre-compact bytes",
    compactHead.sourceSha256 ===
      createHash("sha256").update(preCompactRaw).digest("hex"),
    String(compactHead.sourceSha256),
  );
  // A snapshot task event must be attributed to its real owner, not `tower`:
  // the activity feed / presence derivation reads `by`, and crediting the
  // compactor would make every owner look freshly active after a gc.
  const snapshotTaskLine = readFileSync(file, "utf8")
    .split("\n")
    .slice(1, 1 + JSON.parse(readFileSync(file, "utf8").split("\n")[0]).snapshotLines)
    .map((line) => JSON.parse(line) as { kind?: string; key?: string; by?: string })
    .find((event) => event.kind === "task" && event.key === "done");
  check(
    "a compact snapshot task keeps its real owner as `by`",
    snapshotTaskLine?.by === "alice",
    JSON.stringify(snapshotTaskLine),
  );

  // Appends after a compact stay monotonic.
  const third = writeBoardSnapshot(
    after,
    {
      tasks: [
        { key: "live", subject: "in progress (edited)", status: "in_progress", owner: "alice" },
        {
          key: "done",
          subject: "delivered",
          status: "completed",
          owner: "alice",
          changedFiles: ["src/x.ts"],
        },
        { key: "new", subject: "new row", status: "pending" },
      ],
    },
    "tower",
  );
  await board.append(third.taskEvents);
  const after2 = await board.fold();
  check(
    "appends after a compact keep the revision monotonic",
    after2.revision === after.revision + third.taskEvents.length,
    `${after2.revision} vs ${after.revision + third.taskEvents.length}`,
  );

  // CAS: a peer appends between the fold and the rename -> abort, live intact.
  const casDir = mkdtempSync(join(tmpdir(), "tower-do-compact-cas-"));
  const casFile = join(casDir, "board.jsonl");
  const casBoard = new TowerBoard(casFile);
  await casBoard.append(seed.taskEvents);
  const casRawBefore = readFileSync(casFile, "utf8");
  await expectRejects(
    "a concurrent peer append aborts the compact",
    () =>
      casBoard.compact({
        by: "tower",
        testHooks: {
          beforeCasCheck: async () => {
            await appendFile(
              casFile,
              `${JSON.stringify({
                kind: "message",
                message: {
                  id: "m-race",
                  to: "all",
                  from: "bob",
                  subject: "raced",
                  body: "b",
                  at: now,
                },
                by: "bob",
                at: now,
              })}\n`,
              "utf8",
            );
          },
        },
      }),
    /a peer appended/,
  );
  check(
    "an aborted compact leaves the live file (with the peer row) intact",
    readFileSync(casFile, "utf8") !== casRawBefore &&
      readFileSync(casFile, "utf8").includes("m-race") &&
      (await new TowerBoard(casFile).fold()).messages.some(
        (message) => message.id === "m-race",
      ) &&
      !existsSync(`${casFile}.tmp`),
  );

  // Crash before the rename -> live file untouched.
  const crashDir = mkdtempSync(join(tmpdir(), "tower-do-compact-crash-"));
  const crashFile = join(crashDir, "board.jsonl");
  const crashBoard = new TowerBoard(crashFile);
  await crashBoard.append(seed.taskEvents);
  const crashRawBefore = readFileSync(crashFile, "utf8");
  await expectRejects(
    "a crash before the rename aborts without touching the live file",
    () =>
      crashBoard.compact({
        by: "tower",
        testHooks: {
          beforeRename: () => {
            throw new Error("simulated crash");
          },
        },
      }),
    /simulated crash/,
  );
  check(
    "the live file is byte-identical after a pre-rename crash",
    readFileSync(crashFile, "utf8") === crashRawBefore,
  );

  // --- Lease steal in the rename window ------------------------------------
  // A holder paused past STALE_LOCK_MS between the final proof and the
  // rename resumes to find a peer stole the lease. The compact must fail
  // LOUD, must NOT roll back or write the live path (the new holder's
  // post-rename writes survive), and must preserve the pre-compact log as
  // evidence.
  const stealLease = (target: string): void => {
    const lock = `${target}.lock`;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "peer-token"), "peer");
  };
  /** Release a lease the way a real holder's critical section ends. */
  const releaseLease = (target: string): void => {
    rmSync(`${target}.lock`, { recursive: true, force: true });
  };
  const peerLine = (id: string): string =>
    `${JSON.stringify({
      kind: "message",
      message: {
        id,
        to: "all",
        from: "eve",
        subject: "steal window",
        body: "b",
        at: now,
      },
      by: "eve",
      at: now,
    })}\n`;
  const evidenceName = (d: string): string =>
    readdirSync(d).find((n) => n.includes(".prev-")) ?? "";

  // Steal BEFORE the rename: the peer's append lands in the PRESERVED inode.
  // The compact detects the steal, reconciles under a fresh lease, and the
  // peer's write ends up in the live fold again.
  const s1Dir = mkdtempSync(join(tmpdir(), "tower-do-compact-steal1-"));
  const s1File = join(s1Dir, "board.jsonl");
  const s1Board = new TowerBoard(s1File);
  await s1Board.append(seed.taskEvents);
  const s1Tasks = (await s1Board.fold()).tasks.length;
  await expectRejects(
    "a steal in the pre-rename window fails loud and reconciles the peer write",
    () =>
      s1Board.compact({
        by: "tower",
        testHooks: {
          beforeSwap: async () => {
            stealLease(s1File);
            await appendFile(s1File, peerLine("m-steal1"), "utf8");
            releaseLease(s1File);
          },
        },
      }),
    /reconciled under a fresh lease/,
  );
  const s1Fold = await new TowerBoard(s1File).fold();
  check(
    "pre-rename steal: the peer write is back in the live fold, no evidence residue",
    s1Fold.messages.some((message) => message.id === "m-steal1") &&
      s1Fold.tasks.length === s1Tasks &&
      evidenceName(s1Dir) === "",
  );

  // Steal AFTER the rename: the new holder's append landed in the compacted
  // inode and must survive (no rollback), and the pre-rename peer write (none
  // here) is absent. Detection must never clobber the new holder.
  const s2Dir = mkdtempSync(join(tmpdir(), "tower-do-compact-steal2-"));
  const s2File = join(s2Dir, "board.jsonl");
  const s2Board = new TowerBoard(s2File);
  await s2Board.append(seed.taskEvents);
  await expectRejects(
    "a steal in the post-rename window fails loud without clobbering new writes",
    () =>
      s2Board.compact({
        by: "tower",
        testHooks: {
          afterSwap: async () => {
            stealLease(s2File);
            await appendFile(s2File, peerLine("m-steal2"), "utf8");
            releaseLease(s2File);
          },
        },
      }),
    /reconciled under a fresh lease/,
  );
  const s2Fold = await new TowerBoard(s2File).fold();
  check(
    "post-rename steal: the new holder's writes survive the loud abort",
    s2Fold.messages.some((message) => message.id === "m-steal2") &&
      s2Fold.tasks.length === s1Tasks &&
      evidenceName(s2Dir) === "",
  );

  // A peer that COMPACTED in the window cannot be reconciled provably: the
  // live file no longer starts with our compaction, so the compact must keep
  // the evidence and fail loud instead of guessing.
  const s3Dir = mkdtempSync(join(tmpdir(), "tower-do-compact-steal3-"));
  const s3File = join(s3Dir, "board.jsonl");
  const s3Board = new TowerBoard(s3File);
  await s3Board.append(seed.taskEvents);
  await expectRejects(
    "an unprovable window rewrite keeps the evidence and fails loud",
    () =>
      s3Board.compact({
        by: "tower",
        testHooks: {
          beforeSwap: async () => {
            stealLease(s3File);
            await appendFile(s3File, peerLine("m-steal3"), "utf8");
            releaseLease(s3File);
          },
          afterSwap: async () => {
            // Simulate a peer compaction: rewrite the live file so it no
            // longer starts with our compacted content.
            writeFileSync(
              s3File,
              `${JSON.stringify({ kind: "compact", revision: 1, snapshotLines: 0, at: now, by: "eve" })}\n`,
              "utf8",
            );
          },
        },
      }),
    /could not be provably restored/,
  );
  const s3Evidence = evidenceName(s3Dir);
  check(
    "unprovable window rewrite: the pre-compact log is preserved as evidence",
    s3Evidence !== "" &&
      readFileSync(join(s3Dir, s3Evidence), "utf8").includes("m-steal3"),
  );

  // BOTH window writes non-empty: P landed in the preserved inode and W in the
  // compacted one. The reconcile must produce `content + P + W` — the order is
  // observable because both upsert the SAME task key (LWW: W wins), and P must
  // not be dropped at all (its own key survives). s1 only has P, s2 returns
  // before the merge, s3 returns before the swap — none of them can catch a
  // dropped `pending` or a swapped concatenation.
  const taskLine = (key: string, subject: string): string =>
    `${JSON.stringify({
      kind: "task",
      op: "upsert",
      key,
      task: {
        key,
        subject,
        status: "in_progress",
        owner: "eve",
        dependsOn: [],
        blockedBy: [],
        updatedAt: now,
      },
      by: "eve",
      at: now,
    })}\n`;
  const s4Dir = mkdtempSync(join(tmpdir(), "tower-do-compact-steal4-"));
  const s4File = join(s4Dir, "board.jsonl");
  const s4Board = new TowerBoard(s4File);
  await s4Board.append(seed.taskEvents);
  await expectRejects(
    "both window writes are reconciled in real-time order",
    () =>
      s4Board.compact({
        by: "tower",
        testHooks: {
          beforeSwap: async () => {
            stealLease(s4File);
            // P: a key of its own (must not be dropped) plus a shared key.
            await appendFile(s4File, taskLine("p-only", "kept"), "utf8");
            await appendFile(s4File, taskLine("p-order", "from-P"), "utf8");
            releaseLease(s4File);
          },
          afterSwap: async () => {
            stealLease(s4File);
            // W: same shared key, later in real time — LWW must keep this.
            await appendFile(s4File, taskLine("p-order", "from-W"), "utf8");
            releaseLease(s4File);
          },
        },
      }),
    /reconciled under a fresh lease/,
  );
  const s4Fold = await new TowerBoard(s4File).fold();
  const s4ByKey = new Map(s4Fold.tasks.map((task) => [task.key, task]));
  check(
    "both-window reconcile: P is preserved and P-before-W ordering holds",
    s4ByKey.get("p-only")?.subject === "kept" &&
      s4ByKey.get("p-order")?.subject === "from-W" &&
      evidenceName(s4Dir) === "",
    JSON.stringify({
      pOnly: s4ByKey.get("p-only")?.subject,
      pOrder: s4ByKey.get("p-order")?.subject,
    }),
  );

  // Happy path: no preserve link is left behind.
  const cleanDir = mkdtempSync(join(tmpdir(), "tower-do-compact-clean-"));
  const cleanFile = join(cleanDir, "board.jsonl");
  const cleanBoard = new TowerBoard(cleanFile);
  await cleanBoard.append(seed.taskEvents);
  await cleanBoard.compact({ by: "tower" });
  check(
    "a successful compact leaves no preserve link behind",
    !readdirSync(cleanDir).some((n) => n.includes(".prev-")),
  );

  // Unfoldable lines: blocked by default, explicitly droppable with disclosure.
  const dirtyDir = mkdtempSync(join(tmpdir(), "tower-do-compact-dirty-"));
  const dirtyFile = join(dirtyDir, "board.jsonl");
  await writeFileSync(dirtyFile, `${JSON.stringify({ kind: "task", op: "upsert", key: "k", task: { key: "k", subject: "s", status: "pending", dependsOn: [], blockedBy: [] }, by: "x", at: now })}\n{ this is not json }\n`, "utf8");
  const dirtyBoard = new TowerBoard(dirtyFile);
  await expectRejects(
    "compaction refuses to drop unfoldable lines by default",
    () => dirtyBoard.compact({ by: "tower" }),
    /refusing to compact/,
  );
  const dropped = await dirtyBoard.compact({ by: "tower", dropSkipped: true });
  const dirtyAfter = await new TowerBoard(dirtyFile).fold();
  const dirtyHeader = JSON.parse(
    readFileSync(dirtyFile, "utf8").split("\n")[0],
  ) as { skipped?: number };
  check(
    "a dropSkipped compact records the dropped count in the header and clears live skipped",
    dropped.revision === dirtyAfter.revision &&
      dirtyAfter.skipped === 0 &&
      dirtyHeader.skipped === 1,
    `live=${dirtyAfter.skipped} header=${dirtyHeader.skipped}`,
  );
  // The historical count must not make dropSkipped sticky.
  const secondCompact = await new TowerBoard(dirtyFile).compact({
    by: "tower",
  });
  check(
    "a later compact without dropSkipped still succeeds",
    secondCompact.revision === dirtyAfter.revision,
    `rev=${secondCompact.revision}`,
  );

  // A malformed compact header (no valid snapshotLines) must be ignored, not
  // trusted: otherwise the snapshot block would be counted as ordinary events
  // and double-count the revision.
  const badHeaderDir = mkdtempSync(join(tmpdir(), "tower-do-compact-badhead-"));
  const badHeaderFile = join(badHeaderDir, "board.jsonl");
  writeFileSync(
    badHeaderFile,
    `${JSON.stringify({ kind: "compact", revision: 5 })}\n${JSON.stringify({
      kind: "task",
      op: "upsert",
      key: "k",
      task: {
        key: "k",
        subject: "s",
        status: "pending",
        dependsOn: [],
        blockedBy: [],
      },
      by: "a",
      at: now,
    })}\n`,
    "utf8",
  );
  const badHeaderFold = await new TowerBoard(badHeaderFile).fold();
  check(
    "a compact header without snapshotLines is ignored (no revision double-count)",
    badHeaderFold.revision === 1 &&
      badHeaderFold.skipped === 1 &&
      badHeaderFold.tasks.length === 1,
    `rev=${badHeaderFold.revision} skipped=${badHeaderFold.skipped}`,
  );

  // The snapshot must preserve the OWNER's real last activity on the task, not
  // the row's updatedAt (which a later tower/takeover edit bumps) — otherwise
  // a gc silently flips the takeover permission.
  const clockDir = mkdtempSync(join(tmpdir(), "tower-do-compact-clock-"));
  const clockFile = join(clockDir, "board.jsonl");
  const clockBoard = new TowerBoard(clockFile);
  const aliceAt = now - 7 * 60 * 60_000;
  const parseAll = async (): Promise<ActivityEntry[]> =>
    (await clockBoard.rawLines())
      .reverse()
      .map((line) => parseActivityLine(line))
      .filter((entry): entry is ActivityEntry => entry !== undefined);
  await writeFileSync(
    clockFile,
    `${[
      JSON.stringify({
        kind: "task",
        op: "upsert",
        key: "k",
        task: {
          key: "k",
          subject: "s",
          status: "in_progress",
          owner: "alice",
          dependsOn: [],
          blockedBy: [],
          updatedAt: aliceAt,
        },
        by: "alice",
        at: aliceAt,
      }),
      JSON.stringify({
        kind: "task",
        op: "upsert",
        key: "k",
        task: {
          key: "k",
          subject: "s2",
          status: "in_progress",
          owner: "alice",
          dependsOn: [],
          blockedBy: [],
          updatedAt: now,
        },
        by: "tower",
        at: now,
      }),
    ].join("\n")}\n`,
    "utf8",
  );
  check(
    "pre-compact: a later tower edit does not keep the owner's row alive",
    staleTaskClaims(await parseAll(), (await clockBoard.fold()).tasks, now).has(
      claimKey("alice", "k"),
    ),
  );
  await clockBoard.compact({ by: "tower" });
  check(
    "post-compact: the owner's stale activity clock is preserved",
    staleTaskClaims(
      await parseAll(),
      (await clockBoard.fold()).tasks,
      now,
    ).has(claimKey("alice", "k")),
  );

  // A dead holder's lease is stolen; an active one is not (token + heartbeat).
  const leaseDir = mkdtempSync(join(tmpdir(), "tower-do-compact-lease-"));
  const leaseFile = join(leaseDir, "board.jsonl");
  await writeFileSync(
    leaseFile,
    `${JSON.stringify({
      kind: "task",
      op: "upsert",
      key: "k",
      task: {
        key: "k",
        subject: "s",
        status: "pending",
        dependsOn: [],
        blockedBy: [],
      },
      by: "a",
      at: now,
    })}\n`,
    "utf8",
  );
  const leaseLock = `${leaseFile}.lock`;
  writeFileSync(leaseLock, "dead-holder", "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(leaseLock, old, old);
  const stolen = await new TowerBoard(leaseFile).compact({ by: "tower" });
  check(
    "a stale lease is stolen and compaction proceeds",
    stolen.revision >= 1 && !existsSync(leaseLock),
    `rev=${stolen.revision} lock=${String(existsSync(leaseLock))}`,
  );

  // Cross-instance concurrency: interleaved appends (two instances) and
  // compacts (a third) must lose no events — the lease is what makes this
  // safe, since a compact renames the file under a concurrent append.
  const concDir = mkdtempSync(join(tmpdir(), "tower-do-compact-conc-"));
  const concFile = join(concDir, "board.jsonl");
  const instA = new TowerBoard(concFile);
  const instB = new TowerBoard(concFile);
  const instC = new TowerBoard(concFile);
  const taskEvent = (key: string): Record<string, unknown> => ({
    kind: "task",
    op: "upsert",
    key,
    task: {
      key,
      subject: key,
      status: "pending",
      dependsOn: [],
      blockedBy: [],
      updatedAt: now,
    },
    by: "a",
    at: now,
  });
  // A stale DIRECTORY lease is reaped by its token's age, not the directory's.
  const staleDir = mkdtempSync(join(tmpdir(), "tower-do-stale-token-"));
  const staleFile = join(staleDir, "board.jsonl");
  const staleLock = `${staleFile}.lock`;
  mkdirSync(staleLock);
  const staleToken = join(staleLock, "old-holder");
  writeFileSync(staleToken, "", "utf8");
  utimesSync(staleToken, old, old);
  await new TowerBoard(staleFile).append([taskEvent("after-stale")] as never);
  check(
    "a stale directory token is reaped",
    !existsSync(staleLock) &&
      (await new TowerBoard(staleFile).fold()).tasks.some((task) => task.key === "after-stale"),
  );

  // The directory can be old while its token is fresh: e.g. the old holder
  // released and a new holder recreated it between stat and readdir. A reaper
  // must never delete the new token based only on the directory's old mtime.
  const freshLock = join(staleDir, "fresh.lock");
  mkdirSync(freshLock);
  const freshToken = join(freshLock, "new-holder");
  writeFileSync(freshToken, "", "utf8");
  utimesSync(freshLock, old, old);
  await (new TowerBoard(staleFile) as unknown as {
    breakLock: (path: string) => Promise<void>;
  }).breakLock(freshLock);
  check(
    "a stale directory observation cannot delete a fresh token",
    existsSync(freshToken),
  );

  // An EMPTY lease directory is what a creator leaves between `mkdir` and its
  // token write. It is reapable, and the reaper must end up as the EXCLUSIVE
  // owner — the same proof that catches a paused creator whose token write
  // lands in a peer's re-created directory.
  const emptyDir = mkdtempSync(join(tmpdir(), "tower-do-empty-lease-"));
  const emptyFile = join(emptyDir, "board.jsonl");
  const emptyLock = `${emptyFile}.lock`;
  await writeFileSync(
    emptyFile,
    `${JSON.stringify(taskEvent("seed"))}\n`,
    "utf8",
  );
  mkdirSync(emptyLock);
  utimesSync(emptyLock, old, old);
  let sawExclusive = false;
  await new TowerBoard(emptyFile).withWriteLock(async (append) => {
    sawExclusive = readdirSync(emptyLock).length === 1;
    // The write path itself re-proves ownership before appending.
    await append([
      taskEvent("after-empty-reap") as never,
    ]);
  });
  check(
    "an empty stale lease is reaped and its reaper owns it exclusively",
    sawExclusive && !existsSync(emptyLock),
    `exclusive=${String(sawExclusive)} left=${String(existsSync(emptyLock))}`,
  );

  // A foreign token inside the lease directory means this holder is NOT the
  // owner (it was recycled by a peer after a reaper removed the empty one).
  // The holder must fail loud before the rename, never rename over a board a
  // peer owns.
  const clashDir = mkdtempSync(join(tmpdir(), "tower-do-lease-clash-"));
  const clashFile = join(clashDir, "board.jsonl");
  const clashLock = `${clashFile}.lock`;
  await writeFileSync(
    clashFile,
    `${JSON.stringify(taskEvent("keep"))}\n`,
    "utf8",
  );
  const clashBefore = readFileSync(clashFile, "utf8");
  await expectRejects(
    "a foreign token in the lease directory aborts the compact",
    () =>
      new TowerBoard(clashFile).compact({
        by: "tower",
        testHooks: {
          beforeRename: () => {
            writeFileSync(join(clashLock, "peer-token"), "", "utf8");
          },
        },
      }),
    /lease was stolen/,
  );
  check(
    "the aborted compact keeps the live board and the peer's token",
    readFileSync(clashFile, "utf8") === clashBefore &&
      existsSync(join(clashLock, "peer-token")),
    `same=${String(readFileSync(clashFile, "utf8") === clashBefore)}`,
  );

  await instA.append([taskEvent("seed")] as never);
  const concurrent: Array<Promise<unknown>> = [];
  for (let i = 0; i < 20; i += 1) {
    concurrent.push(instA.append([taskEvent(`a-${String(i)}`)] as never));
    concurrent.push(instB.append([taskEvent(`b-${String(i)}`)] as never));
    if (i % 7 === 0) {
      concurrent.push(
        (async () => {
          try {
            await instC.compact({ by: "tower" });
          } catch {
            // A compact may find nothing new; not an event loss.
          }
        })(),
      );
    }
  }
  await Promise.all(concurrent);
  const concFold = await new TowerBoard(concFile).fold();
  const concKeys = new Set(concFold.tasks.map((task) => task.key));
  let missing = 0;
  for (let i = 0; i < 20; i += 1) {
    if (!concKeys.has(`a-${String(i)}`)) missing += 1;
    if (!concKeys.has(`b-${String(i)}`)) missing += 1;
  }
  check(
    "concurrent appends + compacts lose no events",
    missing === 0 && concFold.skipped === 0 && !existsSync(`${concFile}.lock`),
    `missing=${missing} skipped=${concFold.skipped} lock=${String(existsSync(`${concFile}.lock`))}`,
  );

  // The task full-replacement gate must run under the SAME cross-instance
  // lease as its append. Two writers using the same baseRevision cannot both
  // pass the gate and commit different replacements.
  const gateFile = join(mkdtempSync(join(tmpdir(), "tower-do-gate-")), "board.jsonl");
  const gateA = new TowerBoard(gateFile);
  const gateB = new TowerBoard(gateFile);
  const baseRevision = (await gateA.fold()).revision;
  const gateResults = await Promise.allSettled(
    ([
      [gateA, "first"],
      [gateB, "second"],
    ] as const).map(async ([board, key]) =>
      board.withWriteLock(async (appendLocked) => {
        const fresh = await board.fold();
        const change = writeBoardSnapshot(
          fresh,
          { tasks: [{ key, subject: key, status: "pending" }], baseRevision },
          "tower",
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        await appendLocked(change.taskEvents);
      }),
    ),
  );
  const gateView = await new TowerBoard(gateFile).fold();
  check(
    "two task replacements with one base revision cannot both commit",
    gateResults.filter((result) => result.status === "fulfilled").length === 1 &&
      gateResults.filter((result) => result.status === "rejected").length === 1 &&
      gateView.revision === 1 && gateView.tasks.length === 1,
    `outcomes=${gateResults.map((result) => result.status).join(",")} revision=${gateView.revision}`,
  );

  // A dangling symlink at the lock path must be cleared in one retry, not spun
  // on (the old steal/stat `continue` branches bypassed the deadline).
  const linkDir = mkdtempSync(join(tmpdir(), "tower-do-compact-link-"));
  const linkFile = join(linkDir, "board.jsonl");
  await writeFileSync(
    linkFile,
    `${JSON.stringify(taskEvent("seed"))}\n`,
    "utf8",
  );
  symlinkSync(join(linkDir, "does-not-exist"), `${linkFile}.lock`);
  await new TowerBoard(linkFile).append([taskEvent("after-link")] as never);
  check(
    "a dangling lock symlink is cleared without spinning",
    (await new TowerBoard(linkFile).fold()).tasks.some(
      (task) => task.key === "after-link",
    ) && !readdirSync(linkDir).includes("board.jsonl.lock"),
    readdirSync(linkDir).join(","),
  );

  // When the lock cannot be created, a COMPACT must fail closed (running it
  // unlocked would re-open the append-vs-rename window) while an APPEND may
  // degrade to unlocked (O_APPEND is atomic).
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const roDir = mkdtempSync(join(tmpdir(), "tower-do-compact-ro-"));
    const roFile = join(roDir, "board.jsonl");
    await writeFileSync(roFile, `${JSON.stringify(taskEvent("seed"))}\n`, "utf8");
    chmodSync(roDir, 0o555);
    try {
      let compactErr = "";
      try {
        await new TowerBoard(roFile).compact({ by: "tower" });
      } catch (error) {
        compactErr = error instanceof Error ? error.message : String(error);
      }
      check(
        "a compact fails closed when the lock cannot be created",
        /EACCES|EPERM|EROFS/.test(compactErr),
        compactErr.slice(0, 80),
      );
      let appendErr = "";
      try {
        await new TowerBoard(roFile).append([taskEvent("ro-append")] as never);
      } catch (error) {
        appendErr = error instanceof Error ? error.message : String(error);
      }
      check(
        "an append still lands when the lock cannot be created",
        appendErr === "" &&
          (await new TowerBoard(roFile).fold()).tasks.some(
            (task) => task.key === "ro-append",
          ),
        appendErr,
      );
    } finally {
      chmodSync(roDir, 0o755);
    }
  }

  // A stalled holder that wakes up must NOT delete the lease a peer stole:
  // the removed `readFile === token` then `unlink` release was a TOCTOU (a peer
  // could recreate the lease between the read and the unlink). A's cleanup is
  // now a no-op — its own token file is already gone and `rmdir` refuses B's
  // non-empty directory.
  const stealDir = mkdtempSync(join(tmpdir(), "tower-do-compact-steal-"));
  const stealFile = join(stealDir, "board.jsonl");
  const stealLock = `${stealFile}.lock`;
  await writeFileSync(stealFile, `${JSON.stringify(taskEvent("seed"))}\n`, "utf8");
  const holderA = new TowerBoard(stealFile);
  const holderB = new TowerBoard(stealFile);
  let signalBHold!: () => void;
  const bHold = new Promise<void>((resolve) => {
    signalBHold = resolve;
  });
  let signalBRelease!: () => void;
  const bMayRelease = new Promise<void>((resolve) => {
    signalBRelease = resolve;
  });
  let bRun: Promise<void> | undefined;
  const aRun = holderA.withWriteLock(async () => {
    // Simulate a stall: past STALE_LOCK_MS, so B is allowed to steal.
    const old = new Date(Date.now() - 60_000);
    const [aToken] = readdirSync(stealLock);
    utimesSync(join(stealLock, aToken), old, old);
    bRun = holderB.withWriteLock(async () => {
      signalBHold();
      await bMayRelease; // stay holding while A runs its release path
    });
    await bHold;
  });
  await aRun; // A's critical section ended, so A's release path already ran
  const bLeaseSurvived =
    existsSync(stealLock) && readdirSync(stealLock).length === 1;
  signalBRelease();
  await bRun;
  check(
    "a stolen lease survives the old holder's release",
    bLeaseSurvived && !existsSync(stealLock),
    `survived=${String(bLeaseSurvived)} after=${String(existsSync(stealLock))}`,
  );

  // A STRUCTURAL failure (missing/non-directory parent) must fail loud, not be
  // mistaken for lock contention: the old `ENOENT => retry` branch spun to the
  // 30s deadline and then reported "board is locked by another writer". Only an
  // ENOENT from the token write (a stealer removing the fresh directory) is
  // contention; an ENOENT from `mkdir` itself is a broken path.
  const nodirBase = mkdtempSync(join(tmpdir(), "tower-do-lock-nodir-"));
  symlinkSync(join(nodirBase, "missing-target"), join(nodirBase, "dangling"));
  const nodirFile = join(nodirBase, "dangling", "board.jsonl");
  const nodirStart = Date.now();
  let nodirErr = "";
  try {
    await new TowerBoard(nodirFile).withWriteLock(async () => {});
  } catch (error) {
    nodirErr = error instanceof Error ? error.message : String(error);
  }
  check(
    "a structural lock failure fails loud instead of faking contention",
    nodirErr !== "" &&
      !nodirErr.includes("locked by another writer") &&
      Date.now() - nodirStart < 5_000,
    `${nodirErr.slice(0, 48)} (${String(Date.now() - nodirStart)}ms)`,
  );

  // An aborted compact must not leave an archive claiming a compaction that
  // never happened.
  const abortDir = mkdtempSync(join(tmpdir(), "tower-do-archive-abort-"));
  const abortFile = join(abortDir, "board.jsonl");
  await writeFileSync(
    abortFile,
    `${JSON.stringify(taskEvent("seed"))}\n`,
    "utf8",
  );
  await expectRejects(
    "an aborted compact propagates its failure",
    () =>
      new TowerBoard(abortFile).compact({
        by: "tower",
        archive: true,
        testHooks: {
          beforeRename: () => {
            throw new Error("boom");
          },
        },
      }),
    /boom/,
  );
  const abortArchive = join(abortDir, "archive");
  check(
    "the aborted compact leaves no archive behind",
    !existsSync(abortArchive) || readdirSync(abortArchive).length === 0,
    existsSync(abortArchive) ? readdirSync(abortArchive).join(",") : "(none)",
  );

  // An abort AFTER the archive write (rename failure) must remove the archive
  // too: it describes a compaction that never happened.
  const swapAbortDir = mkdtempSync(join(tmpdir(), "tower-do-archive-swap-abort-"));
  const swapAbortFile = join(swapAbortDir, "board.jsonl");
  await writeFileSync(
    swapAbortFile,
    `${JSON.stringify(taskEvent("seed"))}\n`,
    "utf8",
  );
  await expectRejects(
    "a compact aborted after the archive write propagates its failure",
    () =>
      new TowerBoard(swapAbortFile).compact({
        by: "tower",
        archive: true,
        testHooks: {
          beforeSwap: () => {
            throw new Error("boom-swap");
          },
        },
      }),
    /boom-swap/,
  );
  const swapArchive = join(swapAbortDir, "archive");
  check(
    "an abort after the archive write removes the orphan archive",
    !existsSync(swapArchive) || readdirSync(swapArchive).length === 0,
    existsSync(swapArchive) ? readdirSync(swapArchive).join(",") : "(none)",
  );

  // A peer that REPLACED the board in the rename window (stolen lease or an
  // older unlocked writer) must abort the compact BEFORE the swap: `prev` and
  // `raw` are the OLD inode and cannot reveal the replacement, so the
  // post-rename reconcile would see an empty `pending` and falsely report a
  // provable recovery while silently swapping the peer's board away.
  const inoDir = mkdtempSync(join(tmpdir(), "tower-do-rename-window-"));
  const inoFile = join(inoDir, "board.jsonl");
  const inoBoard = new TowerBoard(inoFile);
  await inoBoard.append(seed.taskEvents);
  const peerBoard = `${JSON.stringify({ kind: "compact", revision: 99, snapshotLines: 0, at: now, by: "eve" })}\n`;
  await expectRejects(
    "a peer replacing the board in the rename window aborts before the swap",
    () =>
      inoBoard.compact({
        by: "tower",
        testHooks: {
          beforeSwap: async () => {
            writeFileSync(`${inoFile}.peer`, peerBoard, "utf8");
            renameSync(`${inoFile}.peer`, inoFile);
            await appendFile(inoFile, peerLine("m-peer"), "utf8");
          },
        },
      }),
    /replaced the board in the rename window/,
  );
  const inoFold = await new TowerBoard(inoFile).fold();
  check(
    "the peer's replacement board stays live (no clobber, no evidence arm)",
    inoFold.revision === 99 &&
      inoFold.messages.some((message) => message.id === "m-peer") &&
      evidenceName(inoDir) === "",
    JSON.stringify({ rev: inoFold.revision, ev: evidenceName(inoDir) }),
  );

  // Non-finite timestamps (`1e999` → Infinity) must not survive a fold: an
  // Infinity `at`/`updatedAt` permanently defeats every time-based exit. The
  // literal is written raw because JSON.stringify(Infinity) is `null`.
  // A task event whose `at` is unusable is NOT salvaged with `Date.now()`:
  // that `at` IS the ownership clock (the fold falls back to it for a missing
  // `updatedAt`, and `staleTaskClaims` reads it), so fabricating one makes the
  // fold non-deterministic between reads AND reports a corrupt line as
  // permanently fresh, so the takeover window never opens. It is skipped and
  // disclosed instead (CONTRACTS.md "unfolded log lines are disclosed").
  const infDir = mkdtempSync(join(tmpdir(), "tower-do-nonfinite-"));
  const infFile = join(infDir, "board.jsonl");
  await writeFileSync(
    infFile,
    '{"kind":"task","op":"upsert","key":"k","task":{"key":"k","subject":"s","status":"pending","dependsOn":[],"blockedBy":[]},"by":"alice","at":1e999}\n',
    "utf8",
  );
  const infBoard = new TowerBoard(infFile);
  const infFold = await infBoard.fold();
  const infFoldAgain = await infBoard.fold();
  check(
    "a non-finite task event timestamp is skipped, not salvaged with now()",
    infFold.tasks.length === 0 &&
      infFold.skipped === 1 &&
      JSON.stringify(infFold) === JSON.stringify(infFoldAgain),
    JSON.stringify({ tasks: infFold.tasks.length, skipped: infFold.skipped }),
  );
  // The clock must agree with the presence/activity derivation, which rejects
  // the same line: otherwise the row is invisible to presence yet permanent in
  // the fold.
  check(
    "...and the activity parser rejects the same line (one clock, not two)",
    parseActivityLine(
      '{"kind":"task","op":"upsert","key":"k","task":{"key":"k","subject":"s","status":"pending","dependsOn":[],"blockedBy":[]},"by":"alice","at":1e999}',
    ) === undefined,
  );

  // A waiter must outlast one FULL staleness window: otherwise two writers that
  // arrive together (the waiter loses the mkdir race by a few ms) reach their
  // own deadline before a crashed holder's lease becomes reapable, and fail
  // with "locked by another writer" on exactly the recovery path the staleness
  // rule exists for.
  check(
    "the lock wait outlasts one full staleness window",
    LOCK_WAIT_MS > STALE_LOCK_MS,
    `wait=${String(LOCK_WAIT_MS)} stale=${String(STALE_LOCK_MS)}`,
  );

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
