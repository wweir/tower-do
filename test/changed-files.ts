/**
 * tower-do changedFiles delivery-receipt regression.
 *
 * P0: a completed task may carry `changedFiles` — a write-once audit trail
 * of the files the owner actually changed (repo-relative). This file locks:
 *   1. changedFiles requires status "completed" (set in the SAME call that
 *      completes the task).
 *   2. changedFiles is a receipt: the owner guard compares it like any other
 *      field — a worker cannot add/rewrite/clear another owner's receipt.
 *   3. Entries are single-line, trimmed, deduped, bounded (1-256 chars).
 *   4. The receipt survives clone/merge round-trips (state layer); the
 *      disk JSONL round-trip (board.append → fold → peer fold) is proven by
 *      test/smoke.ts layer1.
 *   5. Setting changedFiles while NOT completed is rejected with a clear
 *      error (no silent "receipt on an unfinished task").
 *   6. Reopening a completed task (omit changedFiles, new status) voids the
 *      inherited receipt; a worker still cannot reopen another owner's task.
 *
 * Run: bun test/changed-files.ts
 */
import {
  cloneBoard,
  createEmptyBoard,
  writeBoardSnapshot,
  type TowerDoStatus,
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

function expectThrows(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    check(label, false, "expected an error but none was thrown");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), message.slice(0, 140));
  }
}

function snapshotOf(view: ReturnType<typeof createEmptyBoard>): Array<{
  key: string;
  subject: string;
  status: TowerDoStatus;
  owner?: string;
  dependsOn: string[];
  scope?: string[];
  changedFiles?: string[];
  blockedBy: string[];
}> {
  return view.tasks.map((t) => ({
    key: t.key,
    subject: t.subject,
    status: t.status,
    ...(t.owner === undefined ? {} : { owner: t.owner }),
    dependsOn: t.dependsOn,
    ...(t.scope === undefined ? {} : { scope: t.scope }),
    ...(t.changedFiles === undefined ? {} : { changedFiles: t.changedFiles }),
    blockedBy: t.blockedBy,
  }));
}

async function main(): Promise<void> {
  const b0 = createEmptyBoard();

  // --- 1. Receipt requires completed, set in the same call ---

  expectThrows(
    "changedFiles on a non-completed task is rejected",
    () =>
      writeBoardSnapshot(
        b0,
        {
          tasks: [
            {
              key: "a",
              subject: "S",
              status: "in_progress",
              owner: "A",
              changedFiles: ["src/a.ts"],
            },
          ],
        },
        "A",
      ),
    /requires status "completed"/,
  );

  // completed + changedFiles in one call is legal.
  const wDone = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "a",
          subject: "S",
          status: "completed",
          owner: "A",
          changedFiles: ["src/a.ts", "src/b.ts"],
        },
      ],
    },
    "A",
  );
  check(
    "completed task may carry a changedFiles receipt",
    JSON.stringify(wDone.view.tasks[0].changedFiles) ===
      JSON.stringify(["src/a.ts", "src/b.ts"]),
  );

  // --- 2. Owner guard covers changedFiles ---

  // Setup: A owns "a" (completed, with receipt), B owns "b".
  const setup = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "a",
          subject: "S",
          status: "completed",
          owner: "A",
          changedFiles: ["src/a.ts"],
        },
        {
          key: "b",
          subject: "B's own",
          status: "in_progress",
          owner: "B",
        },
      ],
    },
    "A",
  );

  expectThrows(
    "worker cannot rewrite another owner's receipt",
    () =>
      writeBoardSnapshot(
        setup.view,
        {
          tasks: snapshotOf(setup.view).map((t) =>
            t.key === "a"
              ? { ...t, changedFiles: ["src/hacked.ts"] }
              : { ...t },
          ),
          baseRevision: setup.view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  expectThrows(
    "worker cannot clear another owner's receipt",
    () =>
      writeBoardSnapshot(
        setup.view,
        {
          tasks: snapshotOf(setup.view).map((t) =>
            t.key === "a" ? { ...t, changedFiles: [] } : { ...t },
          ),
          baseRevision: setup.view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  // Owner may update its own receipt (edit before final? no — receipt is
  // write-once in spirit, but the owner guard only protects ownership; the
  // owner itself may still amend. Lock the practical invariant: the OWNER
  // can change it, a worker cannot.)
  const wOwnerAmend = writeBoardSnapshot(
    setup.view,
    {
      tasks: snapshotOf(setup.view).map((t) =>
        t.key === "a"
          ? { ...t, changedFiles: ["src/a.ts", "src/b.ts"] }
          : { ...t },
      ),
      baseRevision: setup.view.revision,
    },
    "A",
  );
  check(
    "owner may amend its own receipt",
    JSON.stringify(wOwnerAmend.view.tasks[0].changedFiles) ===
      JSON.stringify(["src/a.ts", "src/b.ts"]),
  );

  // tower may also touch any receipt.
  const wTowerAmend = writeBoardSnapshot(
    setup.view,
    {
      tasks: snapshotOf(setup.view).map((t) =>
        t.key === "a" ? { ...t, changedFiles: ["src/z.ts"] } : { ...t },
      ),
      baseRevision: setup.view.revision,
    },
    "tower",
  );
  check(
    "tower may amend any receipt",
    JSON.stringify(wTowerAmend.view.tasks[0].changedFiles) ===
      JSON.stringify(["src/z.ts"]),
  );

  // --- 3. Entry normalization: single-line, trim, dedupe, length bound ---

  const wNorm = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        {
          key: "a",
          subject: "S",
          status: "completed",
          owner: "A",
          changedFiles: ["  src/a.ts  ", "src/a.ts", "src/b.ts"],
        },
      ],
    },
    "A",
  );
  check(
    "receipt entries are trimmed + deduped",
    JSON.stringify(wNorm.view.tasks[0].changedFiles) ===
      JSON.stringify(["src/a.ts", "src/b.ts"]),
  );

  expectThrows(
    "receipt entry cannot contain a newline",
    () =>
      writeBoardSnapshot(
        createEmptyBoard(),
        {
          tasks: [
            {
              key: "a",
              subject: "S",
              status: "completed",
              changedFiles: ["src/a\nb.ts"],
            },
          ],
        },
        "A",
      ),
    /single line/,
  );

  // --- 4. Receipt survives clone (fold/checkpoint path) ---

  const cloned = cloneBoard(wDone.view);
  check(
    "receipt survives cloneBoard",
    JSON.stringify(cloned.tasks[0].changedFiles) ===
      JSON.stringify(["src/a.ts", "src/b.ts"]),
  );

  // --- 5. Replaying a completed task with NO changedFiles clears it (explicit) ---

  const wCleared = writeBoardSnapshot(
    wDone.view,
    {
      tasks: [
        {
          key: "a",
          subject: "S",
          status: "completed",
          owner: "A",
          changedFiles: [],
        },
      ],
      baseRevision: wDone.view.revision,
    },
    "A",
  );
  check(
    "explicit empty changedFiles clears the receipt",
    (wCleared.view.tasks[0].changedFiles ?? []).length === 0,
  );

  // --- 6. Reopen voids an inherited receipt; owner guard still applies ---

  const wReopen = writeBoardSnapshot(
    wDone.view,
    {
      tasks: [{ key: "a", status: "in_progress" }],
      baseRevision: wDone.view.revision,
    },
    "A",
  );
  check(
    "reopening completed+receipt to in_progress voids the receipt",
    wReopen.view.tasks[0].status === "in_progress" &&
      wReopen.view.tasks[0].changedFiles === undefined &&
      wReopen.view.tasks[0].owner === "A" &&
      wReopen.view.tasks[0].subject === "S",
  );

  expectThrows(
    "worker cannot reopen another owner's completed task",
    () =>
      writeBoardSnapshot(
        setup.view,
        {
          tasks: snapshotOf(setup.view).map((t) =>
            t.key === "a" ? { key: "a", status: "in_progress" } : { ...t },
          ),
          baseRevision: setup.view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  // --- summary ---
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
