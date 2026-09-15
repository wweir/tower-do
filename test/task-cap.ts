/**
 * tower-do open-task budget regression.
 *
 * Bug context (f-902d6eb6-4ab): the batch cap (`MAX_TOWER_DO_TASKS`) counted
 * EVERY row, so a board whose 50 rows were all completed became unwritable for
 * any session that was neither the owner of a row nor `tower`: adding a task
 * needed a 51st row, and freeing a row was rejected by the completed-row
 * owner guard. Real boards reached exactly that state, and sessions dropped
 * the board for local plans.
 *
 * This file locks the budget's shape:
 *   1. Capacity is charged to NON-completed rows only.
 *   2. Completed rows replay free, however many the board holds — a
 *      finished board can always take a new plan.
 *   3. Batch LENGTH is never a budget: a full replay is always legal however
 *      long the history. Only fabricated history is bounded — at most the open
 *      quota of NEW completed keys per write.
 *   4. The completed-row owner guard is unchanged (receipt integrity), and
 *      the cap error names the remediation (drop own/unowned rows, compact
 *      as "tower").
 *
 * Run: bun test/task-cap.ts
 */
import {
  createEmptyBoard,
  MAX_TOWER_DO_OPEN_TASKS,
  writeBoardSnapshot,
  type TowerBoardView,
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
    check(label, match.test(message), message.slice(0, 160));
  }
}

function task(
  key: string,
  status: TowerDoStatus,
  owner?: string,
): {
  key: string;
  subject: string;
  status: TowerDoStatus;
  owner?: string;
  changedFiles?: string[];
} {
  return {
    key,
    subject: `subject ${key}`,
    status,
    ...(owner === undefined ? {} : { owner }),
    // A receipt on every completed row: the guard exists to protect these.
    ...(status === "completed" ? { changedFiles: [`${key}.ts`] } : {}),
  };
}

/** Replay every row the board holds, plus the extra tasks (new work). */
function replay(view: TowerBoardView, extra: ReturnType<typeof task>[] = []) {
  return {
    tasks: [
      ...view.tasks.map((t) => ({ key: t.key })),
      ...extra.map((t) => ({ ...t })),
    ],
  };
}

function seeded(
  rows: Array<{ key: string; status: TowerDoStatus; owner?: string }>,
): TowerBoardView {
  // Seed in open-quota-sized chunks: one write may introduce at most that
  // many NEW completed rows (replaying existing ones is free).
  let view = createEmptyBoard();
  for (let i = 0; i < rows.length; i += MAX_TOWER_DO_OPEN_TASKS) {
    const chunk = rows.slice(i, i + MAX_TOWER_DO_OPEN_TASKS);
    view = writeBoardSnapshot(
      view,
      {
        tasks: [
          ...view.tasks.map((t) => ({ key: t.key })),
          ...chunk.map((r) => task(r.key, r.status, r.owner)),
        ],
      },
      "seed",
    ).view;
  }
  return view;
}

async function main(): Promise<void> {
  const cap = MAX_TOWER_DO_OPEN_TASKS;

  // --- 1. Open-task quota boundary ---
  const openRows = Array.from({ length: cap }, (_, i) =>
    task(`open-${String(i)}`, i % 2 === 0 ? "pending" : "in_progress"),
  );
  const atCap = writeBoardSnapshot(
    createEmptyBoard(),
    { tasks: openRows },
    "worker",
  ).view;
  check("open rows up to the quota are accepted", atCap.tasks.length === cap);

  expectThrows(
    "one open row past the quota is rejected",
    () =>
      writeBoardSnapshot(
        atCap,
        {
          tasks: [
            ...atCap.tasks.map((t) => ({ key: t.key })),
            task("open-extra", "pending"),
          ],
        },
        "worker",
      ),
    /open tasks support at most 50 items \(got 51; completed rows do not count\)/,
  );

  // --- 2. Completed rows do not consume the budget (the reported bug) ---
  const fullCompleted = seeded([
    // The reported board: 43 rows owned by departed sessions, 7 unowned.
    ...Array.from({ length: 43 }, (_, i) => ({
      key: `done-owned-${String(i)}`,
      status: "completed" as const,
      owner: `session-${String(i % 6)}`,
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      key: `done-free-${String(i)}`,
      status: "completed" as const,
    })),
  ]);
  check(
    "seeded board is 50 completed rows",
    fullCompleted.tasks.length === 50 &&
      fullCompleted.tasks.every((t) => t.status === "completed"),
  );

  const withPlan = writeBoardSnapshot(
    fullCompleted,
    replay(fullCompleted, [
      task("plan-1", "pending"),
      task("plan-2", "in_progress"),
    ]),
    "fresh-session",
  );
  check(
    "a board of 50 completed rows still takes a new plan (the bug)",
    withPlan.change.added.join(",") === "plan-1,plan-2" &&
      withPlan.change.removed.length === 0,
  );
  check(
    "completed rows are replayed, not dropped",
    withPlan.view.tasks.filter((t) => t.status === "completed").length === 50,
  );

  // A completed-row board well past the old cap stays writable.
  const bigCompleted = seeded(
    Array.from({ length: 120 }, (_, i) => ({
      key: `done-${String(i)}`,
      status: "completed" as const,
      owner: "gone",
    })),
  );
  check("120 completed rows fold", bigCompleted.tasks.length === 120);
  const afterBig = writeBoardSnapshot(
    bigCompleted,
    replay(bigCompleted, [task("plan-after", "pending")]),
    "fresh-session",
  );
  check(
    "a 120-row completed board still takes a new plan",
    afterBig.change.added.join(",") === "plan-after" &&
      afterBig.view.tasks.length === 121,
  );

  // Quota still applies on top of completed history.
  expectThrows(
    "the open quota holds on a completed-heavy board",
    () =>
      writeBoardSnapshot(
        fullCompleted,
        {
          tasks: [
            ...fullCompleted.tasks.map((t) => ({ key: t.key })),
            ...Array.from({ length: cap + 1 }, (_, i) =>
              task(`plan-${String(i)}`, "pending"),
            ),
          ],
        },
        "fresh-session",
      ),
    /got 51/,
  );

  // --- 3. Fabricated receipts are bounded; batch LENGTH never is ---
  expectThrows(
    "a batch cannot fabricate an unbounded number of completed rows",
    () =>
      writeBoardSnapshot(
        createEmptyBoard(),
        {
          tasks: Array.from({ length: cap + 1 }, (_, i) =>
            task(`made-up-${String(i)}`, "completed", "someone"),
          ),
        },
        "worker",
      ),
    /a write may introduce at most 50 new completed tasks \(got 51; replaying a completed row the board already holds is free/,
  );
  const fabricatedAtBound = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: Array.from({ length: cap }, (_, i) =>
        task(`made-up-${String(i)}`, "completed", "someone"),
      ),
    },
    "worker",
  );
  check(
    "exactly the quota of new receipts is accepted",
    fabricatedAtBound.view.tasks.length === cap,
  );

  // Both bounds may be filled by ONE write: the open quota of new work and its
  // own quota of new receipts (the fabrication bound is per write, not shared
  // with the work the same write adds).
  const combined = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        ...Array.from({ length: cap }, (_, i) =>
          task(`c-${String(i)}`, "completed", "someone"),
        ),
        ...Array.from({ length: cap }, (_, i) =>
          task(`p-${String(i)}`, "pending", "someone"),
        ),
      ],
    },
    "worker",
  );
  check(
    "one write may fill the open quota and introduce its own quota of receipts",
    combined.view.tasks.length === cap * 2,
  );

  // An open -> completed transition is an existing key, so it is not a
  // fabricated receipt: a write may carry 50 new receipts PLUS the transitions.
  const transitionBoard = seeded([
    { key: "started", status: "in_progress" as const, owner: "worker" },
    ...Array.from({ length: cap }, (_, i) => ({
      key: `old-${String(i)}`,
      status: "completed" as const,
      owner: "peer",
    })),
  ]);
  const transitions = writeBoardSnapshot(
    transitionBoard,
    {
      tasks: [
        ...transitionBoard.tasks.map((t) =>
          t.key === "started"
            ? { key: t.key, status: "completed" as const, changedFiles: ["z.ts"] }
            : { key: t.key },
        ),
        ...Array.from({ length: cap }, (_, i) =>
          task(`fresh-${String(i)}`, "completed", "worker"),
        ),
      ],
    },
    "worker",
  );
  check(
    "an open-to-completed transition is not a fabricated receipt",
    transitions.view.tasks.filter((t) => t.status === "completed").length ===
      cap * 2 + 1,
  );

  // The reviewer's repro: a board already at the open quota, everything
  // replayed, plus ONE new receipt — a full replay plus new work must fit,
  // because the replay is not a fabrication.
  const atOpenQuota = seeded([
    ...Array.from({ length: cap }, (_, i) => ({
      key: `open-${String(i)}`,
      status: "pending" as const,
      owner: "peer",
    })),
    { key: "done-a", status: "completed" as const, owner: "peer" },
  ]);
  const replayPlusReceipt = writeBoardSnapshot(
    atOpenQuota,
    {
      tasks: [
        ...atOpenQuota.tasks.map((t) => ({ key: t.key })),
        task("done-b", "completed", "fresh-session"),
      ],
    },
    "fresh-session",
  );
  check(
    "a full replay plus one new receipt fits (batch length is not a budget)",
    replayPlusReceipt.change.added.join(",") === "done-b" &&
      replayPlusReceipt.view.tasks.length === atOpenQuota.tasks.length + 1,
  );

  // --- 4. Completed-row owner guard is unchanged ---
  expectThrows(
    "a peer still cannot drop another session's completed row",
    () =>
      writeBoardSnapshot(
        fullCompleted,
        {
          tasks: fullCompleted.tasks
            .filter((t) => t.key !== "done-owned-0")
            .map((t) => ({ key: t.key })),
        },
        "fresh-session",
      ),
    /owned by "session-0" — only its owner or tower may remove it/,
  );

  const freed = writeBoardSnapshot(
    fullCompleted,
    {
      tasks: fullCompleted.tasks
        .filter((t) => t.owner !== undefined)
        .map((t) => ({ key: t.key })),
    },
    "fresh-session",
  );
  check(
    "the 7 unowned completed rows are the caller's own remediation",
    freed.change.removed.length === 7 &&
      freed.change.removed.every((key) => key.startsWith("done-free-")),
  );

  // The other legal slot: an owner may drop its OWN completed receipt.
  const ownReceipt = writeBoardSnapshot(
    fullCompleted,
    {
      tasks: fullCompleted.tasks
        .filter((t) => t.key !== "done-owned-0")
        .map((t) => ({ key: t.key })),
    },
    "session-0",
  );
  check(
    "an owner may drop its own completed receipt to free a slot",
    ownReceipt.change.removed.join(",") === "done-owned-0",
    ownReceipt.change.removed.join(","),
  );

  // --- 5. The cap error names the remediation ---
  expectThrows(
    "cap error points at the escape hatches",
    () =>
      writeBoardSnapshot(
        atCap,
        {
          tasks: [
            ...atCap.tasks.map((t) => ({ key: t.key })),
            task("open-extra", "pending"),
          ],
        },
        "worker",
      ),
    /omitting your own or an unowned task, or compact a finished board with an as: "tower" write/,
  );

  // --- 6. Dependencies still resolve across the budget ---
  const depBoard = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        // Unowned: only then does the dependency gate (not the owner guard)
        // decide whether the row may leave the batch.
        task("dep-done", "completed"),
        task("dep-open", "pending"),
      ],
    },
    "worker",
  ).view;
  const gated = writeBoardSnapshot(
    depBoard,
    {
      tasks: [
        { key: "dep-done" },
        { key: "dep-open", owner: "worker", status: "in_progress", dependsOn: ["dep-done"] },
      ],
    },
    "worker",
  );
  check(
    "an open task may complete against a replayed completed dependency",
    gated.view.tasks.find((t) => t.key === "dep-open")?.status ===
      "in_progress",
  );
  expectThrows(
    "dropping the completed dependency is still rejected",
    () =>
      writeBoardSnapshot(
        depBoard,
        { tasks: [{ key: "dep-open", dependsOn: ["dep-done"] }] },
        "worker",
      ),
    /cannot remove task dep-done .* still depends on it/,
  );

  // --- summary ---
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
