/**
 * tower-do ownership-guard regression — proves the guard covers EVERY field
 * of an owned task (subject/description/status/owner/dependsOn/scope/
 * blockedBy), not just status/owner/scope.
 *
 * Bug context (Bug-1/Bug-2): the old guard compared only status/owner/scope.
 * Because tower_do is a FULL replacement, a worker who wanted to touch its
 * own task had to replay the whole board — and while replaying could
 * silently rewrite ANOTHER owner's content (subject/deps/blockedBy/…) or
 * roll back its concurrent update with a stale snapshot, because content
 * fields were unguarded. This file locks the fix.
 *
 * Run: bun test/owner-guard.ts
 */
import {
  createEmptyBoard,
  staleTaskOwners,
  writeBoardSnapshot,
  type ActivityEntry,
  type TowerDoStatus,
  type TowerDoTask,
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
  description?: string;
  dependsOn: string[];
  scope?: string[];
  blockedBy: string[];
}> {
  return view.tasks.map((t) => ({
    key: t.key,
    subject: t.subject,
    status: t.status,
    ...(t.owner === undefined ? {} : { owner: t.owner }),
    ...(t.description === undefined ? {} : { description: t.description }),
    dependsOn: t.dependsOn,
    ...(t.scope === undefined ? {} : { scope: t.scope }),
    blockedBy: t.blockedBy,
  }));
}

async function main(): Promise<void> {
  const b0 = createEmptyBoard();

  // A creates an owned task + a second task so B has "its own" to touch.
  const w1 = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "a-task",
          subject: "S1",
          status: "in_progress",
          owner: "A",
          scope: ["extensions/tower-do/**"],
        },
        {
          key: "b-task",
          subject: "B's own",
          status: "in_progress",
          owner: "B",
        },
      ],
    },
    "A",
  );
  const view = w1.view;

  // --- Bug-1: content fields of an owned task are protected from other workers ---

  expectThrows(
    "worker cannot rewrite an owner's subject",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "HACKED-BY-B", // status/owner/scope unchanged
              status: "in_progress",
              owner: "A",
              scope: ["extensions/tower-do/**"],
            },
            {
              key: "b-task",
              subject: "B's own",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  expectThrows(
    "worker cannot add a dependsOn to another owner's task",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "S1",
              status: "in_progress",
              owner: "A",
              scope: ["extensions/tower-do/**"],
              dependsOn: ["b-task"], // a real, existing dep — not a dangling ref
            },
            {
              key: "b-task",
              subject: "B's own",
              status: "completed", // so the dep is not "unresolved"
              owner: "B",
            },
          ],
          baseRevision: view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  expectThrows(
    "worker cannot change another owner's description",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "S1",
              status: "in_progress",
              owner: "A",
              scope: ["extensions/tower-do/**"],
              description: "sneaky description",
            },
            {
              key: "b-task",
              subject: "B's own",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  expectThrows(
    "worker cannot flip another owner's status (status-only guard kept)",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "S1",
              status: "completed", // only status changes
              owner: "A",
              scope: ["extensions/tower-do/**"],
            },
            {
              key: "b-task",
              subject: "B's own",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  expectThrows(
    "worker cannot steal ownership of another owner's task",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "S1",
              status: "in_progress",
              owner: "B", // steal
              scope: ["extensions/tower-do/**"],
            },
            {
              key: "b-task",
              subject: "B's own",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  // --- Bug-2: a stale snapshot cannot silently roll back another owner's update ---

  // A advances its task (subject S1 -> S2).
  const wA = writeBoardSnapshot(
    view,
    {
      tasks: snapshotOf(view).map((t) =>
        t.key === "a-task" ? { ...t, subject: "S2" } : { ...t, dependsOn: [] },
      ),
      baseRevision: view.revision,
    },
    "A",
  );

  // B (fresh rev) replays A's task with the STALE S1 content while touching
  // only its own b-task — the rollback must be rejected, not silent.
  expectThrows(
    "stale replay cannot roll back another owner's concurrent update",
    () =>
      writeBoardSnapshot(
        wA.view,
        {
          tasks: [
            {
              key: "a-task",
              subject: "S1", // stale — A just set S2
              status: "in_progress",
              owner: "A",
              scope: ["extensions/tower-do/**"],
            },
            {
              key: "b-task",
              subject: "B's own (updated)",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: wA.view.revision,
        },
        "B",
      ),
    /owned by "A"/,
  );

  // --- legal paths stay open ---

  // The owner may edit its own task.
  const wOwner = writeBoardSnapshot(
    view,
    {
      tasks: snapshotOf(view).map((t) =>
        t.key === "a-task" ? { ...t, subject: "S2" } : { ...t },
      ),
      baseRevision: view.revision,
    },
    "A",
  );
  check(
    "owner may edit its own task",
    wOwner.view.tasks.find((t) => t.key === "a-task")?.subject === "S2",
  );

  // tower (orchestrator) may edit any owned task.
  const wTower = writeBoardSnapshot(
    wOwner.view,
    {
      tasks: snapshotOf(wOwner.view).map((t) =>
        t.key === "a-task" ? { ...t, subject: "S3" } : { ...t },
      ),
      baseRevision: wOwner.view.revision,
    },
    "tower",
  );
  check(
    "tower may edit any owned task",
    wTower.view.tasks.find((t) => t.key === "a-task")?.subject === "S3",
  );

  // Replaying another owner's task with its CURRENT value while touching
  // one's own is legal (full-replacement semantics require the replay).
  const wLegal = writeBoardSnapshot(
    wTower.view,
    {
      tasks: snapshotOf(wTower.view).map(
        (t) =>
          t.key === "b-task" ? { ...t, subject: "B's own (v2)" } : { ...t }, // a-task replayed as-is
      ),
      baseRevision: wTower.view.revision,
    },
    "B",
  );
  check(
    "replaying another owner's current task while updating one's own is legal",
    wLegal.view.tasks.find((t) => t.key === "b-task")?.subject ===
      "B's own (v2)" &&
      wLegal.view.tasks.find((t) => t.key === "a-task")?.subject === "S3",
  );

  // A worker may freely edit an UNOWNED task's content.
  const wUnowned = writeBoardSnapshot(
    createEmptyBoard(),
    { tasks: [{ key: "open", subject: "x", status: "pending" }] },
    "bob",
  );
  const wUnowned2 = writeBoardSnapshot(
    wUnowned.view,
    {
      tasks: [
        {
          key: "open",
          subject: "rewritten by bob",
          status: "pending",
        },
      ],
      baseRevision: wUnowned.view.revision,
    },
    "bob",
  );
  check(
    "unowned task content may be edited by anyone",
    wUnowned2.view.tasks[0].subject === "rewritten by bob",
  );

  // --- stale-owner takeover: an idle owner's unfinished work is adoptable ---

  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  const activityEntry = (by: string, at: number): ActivityEntry => ({
    kind: "task",
    by,
    at,
    glyph: "○",
    detail: "activity",
  });
  const handTask = (over: Partial<TowerDoTask>): TowerDoTask => ({
    key: "t",
    subject: "t",
    status: "pending",
    dependsOn: [],
    blockedBy: [],
    updatedAt: NOW - 40 * MIN,
    ...over,
  });

  // Pure derivation: idle owner of an open task is stale; completed rows,
  // fresh activity, and freshly assigned never-started work are not.
  const tasksForDerivation = [
    handTask({ key: "idle", subject: "i", status: "in_progress", owner: "A" }),
    handTask({ key: "done", subject: "d", status: "completed", owner: "A" }),
    handTask({
      key: "fresh",
      subject: "f",
      status: "in_progress",
      owner: "B",
      updatedAt: NOW - 40 * MIN,
    }),
    handTask({ key: "never", subject: "n", owner: "C" }),
    handTask({
      key: "assigned",
      subject: "a",
      owner: "D",
      updatedAt: NOW - 1 * MIN, // fresh assignment, not begun yet
    }),
    handTask({ key: "open", subject: "o" }),
  ];
  const stale = staleTaskOwners(
    [activityEntry("A", NOW - 40 * MIN), activityEntry("B", NOW - 1 * MIN)],
    tasksForDerivation,
    NOW,
  );
  check(
    "staleTaskOwners marks idle owner + long-assigned never-started owner",
    stale.has("A") && stale.has("C") && !stale.has("B") && !stale.has("D"),
    [...stale].join(","),
  );

  // Liveness tiebreaker: an owner whose process still heartbeats is never
  // stale, however quiet it has been on the board.
  const withLive = staleTaskOwners(
    [activityEntry("A", NOW - 40 * MIN), activityEntry("B", NOW - 1 * MIN)],
    tasksForDerivation,
    NOW,
    undefined,
    new Set(["A", "C"]),
  );
  check(
    "fresh liveness heartbeat keeps a board-quiet owner from takeover",
    withLive.size === 0,
    [...withLive].join(","),
  );
  check(
    "liveOwners alias protects an as-label owner with stale board activity",
    staleTaskOwners(
      [activityEntry("coder-1", NOW - 40 * MIN)],
      [
        handTask({
          key: "child",
          subject: "c",
          status: "in_progress",
          owner: "coder-1",
        }),
      ],
      NOW,
      undefined,
      new Set(["alice", "coder-1"]),
    ).size === 0,
  );

  // No activity data at all (unreadable/garbage log) disables the exception:
  // the updatedAt fallback is only sound when the log exists.
  check(
    "empty activity log disables the takeover exception entirely",
    staleTaskOwners([], tasksForDerivation, NOW).size === 0,
  );

  // An owner WITH prior activity is judged by that activity alone: a task
  // freshly assigned to an already-quiet owner does not re-protect the row.
  // (The fresh-updatedAt protection is for never-active owners only.)
  check(
    "a quiet owner stays stale for a freshly assigned row too",
    staleTaskOwners(
      [activityEntry("E", NOW - 40 * MIN)],
      [
        handTask({
          key: "e-old",
          subject: "o",
          status: "in_progress",
          owner: "E",
        }),
        handTask({
          key: "e-new",
          subject: "n",
          owner: "E",
          updatedAt: NOW - 1 * MIN,
        }),
      ],
      NOW,
    ).has("E"),
  );

  // Board: A owns an in_progress task and went quiet 40 min ago.
  const idleBoard = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        {
          key: "stale-task",
          subject: "stalled",
          status: "in_progress",
          owner: "A",
        },
        {
          key: "stale-done",
          subject: "delivered",
          status: "completed",
          owner: "A",
          changedFiles: ["x.ts"],
        },
        {
          key: "fresh-task",
          subject: "active",
          status: "in_progress",
          owner: "B",
        },
      ],
    },
    "A",
  );
  const idleView = idleBoard.view;
  const STALE = new Set(["A"]); // A idle; B fresh

  // Takeover: C adopts the idle owner's in_progress task by claiming it.
  const adopted = writeBoardSnapshot(
    idleView,
    {
      tasks: [
        {
          key: "stale-task",
          subject: "stalled",
          status: "in_progress",
          owner: "C", // adopt
        },
        {
          key: "stale-done",
          subject: "delivered",
          status: "completed",
          owner: "A",
          changedFiles: ["x.ts"],
        },
        {
          key: "fresh-task",
          subject: "active",
          status: "in_progress",
          owner: "B",
        },
      ],
      baseRevision: idleView.revision,
    },
    "C",
    STALE,
  );
  check(
    "idle owner's non-completed task may be adopted by setting owner to self",
    adopted.view.tasks.find((t) => t.key === "stale-task")?.owner === "C",
  );

  // But the adopter cannot rewrite the stalled content WITHOUT taking over:
  // the guard stays, only the hint changes.
  expectThrows(
    "idle owner's task content edit without adoption is still rejected",
    () =>
      writeBoardSnapshot(
        idleView,
        {
          tasks: [
            {
              key: "stale-task",
              subject: "HACKED",
              status: "in_progress",
              owner: "A",
            },
            {
              key: "stale-done",
              subject: "delivered",
              status: "completed",
              owner: "A",
              changedFiles: ["x.ts"],
            },
            {
              key: "fresh-task",
              subject: "active",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: idleView.revision,
        },
        "C",
        STALE,
      ),
    /adopt it by setting owner to yourself/,
  );

  // Removal of the idle owner's unfinished task is allowed.
  const dropped = writeBoardSnapshot(
    idleView,
    {
      tasks: [
        {
          key: "stale-done",
          subject: "delivered",
          status: "completed",
          owner: "A",
          changedFiles: ["x.ts"],
        },
        {
          key: "fresh-task",
          subject: "active",
          status: "in_progress",
          owner: "B",
        },
      ],
      baseRevision: idleView.revision,
    },
    "C",
    STALE,
  );
  check(
    "idle owner's non-completed task may be removed by anyone",
    !dropped.view.tasks.some((t) => t.key === "stale-task"),
  );

  // A completed task stays with its owner even when the owner is idle —
  // a peer cannot drop or forge a delivery receipt.
  expectThrows(
    "idle owner's completed task cannot be removed by a peer",
    () =>
      writeBoardSnapshot(
        idleView,
        {
          tasks: [
            {
              key: "stale-task",
              subject: "stalled",
              status: "in_progress",
              owner: "A",
            },
            {
              key: "fresh-task",
              subject: "active",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: idleView.revision,
        },
        "C",
        STALE,
      ),
    /completed task stays with its owner/,
  );
  expectThrows(
    "idle owner's completed task cannot have its owner swapped by a peer",
    () =>
      writeBoardSnapshot(
        idleView,
        {
          tasks: [
            {
              key: "stale-task",
              subject: "stalled",
              status: "in_progress",
              owner: "A",
            },
            {
              key: "stale-done",
              subject: "delivered",
              status: "completed",
              owner: "C",
              changedFiles: ["x.ts"],
            },
            {
              key: "fresh-task",
              subject: "active",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: idleView.revision,
        },
        "C",
        STALE,
      ),
    /owned by "A"/,
  );

  // A fresh owner is not adoptable: takeover attempt is rejected, no hint.
  try {
    writeBoardSnapshot(
      idleView,
      {
        tasks: [
          {
            key: "stale-task",
            subject: "stalled",
            status: "in_progress",
            owner: "A",
          },
          {
            key: "stale-done",
            subject: "delivered",
            status: "completed",
            owner: "A",
            changedFiles: ["x.ts"],
          },
          {
            key: "fresh-task",
            subject: "active",
            status: "in_progress",
            owner: "C", // B is active — this must fail
          },
        ],
        baseRevision: idleView.revision,
      },
      "C",
    );
    check("fresh owner takeover rejected", false, "no error thrown");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      "fresh owner takeover rejected, without takeover hint",
      /owned by "B"/.test(message) && !message.includes("idle"),
      message.slice(0, 140),
    );
  }

  // Adoption is ownership-only: the adopter cannot smuggle a content edit
  // into the same write (it may re-plan in a second write once it owns it).
  expectThrows(
    "adoption cannot carry a content edit in the same write",
    () =>
      writeBoardSnapshot(
        idleView,
        {
          tasks: [
            {
              key: "stale-task",
              subject: "REPLANNED-WHILE-ADOPTING",
              status: "in_progress",
              owner: "C",
            },
            {
              key: "stale-done",
              subject: "delivered",
              status: "completed",
              owner: "A",
              changedFiles: ["x.ts"],
            },
            {
              key: "fresh-task",
              subject: "active",
              status: "in_progress",
              owner: "B",
            },
          ],
          baseRevision: idleView.revision,
        },
        "C",
        STALE,
      ),
    /adopt it by setting owner to yourself/,
  );

  // --- summary ---
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
