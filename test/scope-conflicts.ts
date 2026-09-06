/**
 * tower-do P1 scope-conflict derivation regression.
 *
 * P1 turns the (previously decorative) `scope` declaration into a useful
 * boundary signal. This file locks the pure derivation in state.ts:
 *   1. globMatchesPath — the minimal glob matcher (`*`/`**`/`?`, exact when
 *      no wildcard, `\\` normalized to `/`).
 *   2. findScopeConflicts — completed-task changedFiles that fall inside an
 *      active task's scope (kind "overlap"), and two in-progress tasks whose
 *      scope globs collide (kind "collision").
 * Advisory only: never throws, never writes.
 *
 * Run: bun test/scope-conflicts.ts
 */
import {
  createEmptyBoard,
  findScopeConflicts,
  globMatchesPath,
  writeBoardSnapshot,
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

async function main(): Promise<void> {
  // --- globMatchesPath ---
  check("exact path matches itself", globMatchesPath("src/a.ts", "src/a.ts"));
  check(
    "exact path does not match a different file",
    !globMatchesPath("src/a.ts", "src/b.ts"),
  );
  check("single * matches within a segment", globMatchesPath("src/*.ts", "src/a.ts"));
  check(
    "single * does not cross a segment",
    !globMatchesPath("src/*.ts", "src/sub/a.ts"),
  );
  check("** crosses segments", globMatchesPath("src/**", "src/sub/deep/a.ts"));
  check("** also matches zero segments", globMatchesPath("src/**", "src/"));
  check("? matches one char", globMatchesPath("src/?.ts", "src/a.ts"));
  check("? does not match two chars", !globMatchesPath("src/?.ts", "src/ab.ts"));
  check(
    "backslash normalized to forward slash",
    globMatchesPath("src\\*.ts", "src/a.ts"),
  );
  check("trailing dir glob with **", globMatchesPath("src/**", "src/a.ts"));
  check("extension glob", globMatchesPath("**/*.ts", "a/b/c.ts"));
  check(
    "no wildcard is exact, not prefix",
    !globMatchesPath("src/a", "src/a.ts"),
  );

  // --- findScopeConflicts: overlap (completed receipt inside active scope) ---
  const b0 = createEmptyBoard();
  const w = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "done-api",
          subject: "finish api",
          status: "completed",
          owner: "A",
          scope: ["src/api/**"],
          changedFiles: ["src/api/client.ts", "src/api/types.ts"],
        },
        {
          key: "wip-client",
          subject: "extend client",
          status: "in_progress",
          owner: "B",
          scope: ["src/api/**"], // same dir — planner overlap
        },
        {
          key: "wip-ui",
          subject: "ui",
          status: "in_progress",
          owner: "C",
          scope: ["src/ui/**"], // disjoint — no conflict
        },
      ],
    },
    "A",
  );
  const conflicts = findScopeConflicts(w.view);
  const overlap = conflicts.filter((c) => c.kind === "overlap");
  check(
    "active task whose scope matches a completed receipt is flagged",
    overlap.some(
      (c) => c.taskKey === "wip-client" && c.peerKey === "done-api",
    ),
    JSON.stringify(conflicts),
  );
  check(
    "disjoint scope is not flagged",
    !conflicts.some((c) => c.taskKey === "wip-ui"),
  );

  // --- collision: two in_progress tasks with intersecting scope globs ---
  const w2 = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "t1",
          subject: "one",
          status: "in_progress",
          owner: "A",
          scope: ["lib/core/**"],
        },
        {
          key: "t2",
          subject: "two",
          status: "in_progress",
          owner: "B",
          scope: ["lib/**"], // strictly broader than t1
        },
      ],
    },
    "A",
  );
  const collisions = findScopeConflicts(w2.view).filter(
    (c) => c.kind === "collision",
  );
  check(
    "in_progress tasks with nested scope globs collide (one unordered pair)",
    collisions.length === 1 &&
      ((collisions[0]?.taskKey === "t1" && collisions[0]?.peerKey === "t2") ||
        (collisions[0]?.taskKey === "t2" && collisions[0]?.peerKey === "t1")),
    JSON.stringify(collisions),
  );

  // --- completed tasks are not flagged (no active work to protect) ---
  const w3 = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "c1",
          subject: "old",
          status: "completed",
          owner: "A",
          scope: ["src/**"],
          changedFiles: ["src/x.ts"],
        },
        {
          key: "c2",
          subject: "older",
          status: "completed",
          owner: "B",
          scope: ["src/**"],
        },
      ],
    },
    "A",
  );
  check(
    "no active tasks means no conflicts",
    findScopeConflicts(w3.view).length === 0,
  );

  // --- tasks without scope never produce conflicts ---
  const w4 = writeBoardSnapshot(
    b0,
    {
      tasks: [
        {
          key: "done",
          subject: "x",
          status: "completed",
          owner: "A",
          changedFiles: ["a.ts"],
        },
        { key: "wip", subject: "y", status: "in_progress", owner: "B" },
      ],
    },
    "A",
  );
  check(
    "scope-less active task is not flagged even if a receipt exists",
    findScopeConflicts(w4.view).length === 0,
  );

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
