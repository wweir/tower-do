/**
 * Glance/reminder mine-first order:
 *
 *  1. owner === identity moves to the front; relative order inside each
 *     group is preserved (fold order is updatedAt).
 *  2. unowned is not mine; `alice` does not match `alice-2`.
 *  3. empty / no-mine input is a copy, not a mutation.
 *  4. formatBoardReminder applies the same order before its line cap, so
 *     the caller's rows win the reminder window.
 *
 * Run: bun run test/mine-first.ts
 */
import {
  TOWER_DO_SCHEMA_VERSION,
  formatBoardReminder,
  orderTasksMineFirst,
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
    console.log(`FAIL  ${label}${extra ? " — " + extra : ""}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function task(
  key: string,
  owner: string | undefined,
  updatedAt = 0,
): TowerDoTask {
  return {
    key,
    subject: key,
    status: "pending",
    dependsOn: [],
    blockedBy: [],
    updatedAt,
    ...(owner === undefined ? {} : { owner }),
  };
}

const keys = (tasks: readonly TowerDoTask[]): string[] =>
  tasks.map((item) => item.key);

eq("empty input stays empty", keys(orderTasksMineFirst([], "me")).join(","), "");

const noMine = [task("a", "bob", 1), task("b", undefined, 2), task("c", "x", 3)];
eq(
  "no mine keeps fold order",
  keys(orderTasksMineFirst(noMine, "me")).join(","),
  "a,b,c",
);

const mixed = [
  task("old-peer", "bob", 1),
  task("mine-old", "me", 2),
  task("unowned", undefined, 3),
  task("mine-new", "me", 4),
  task("peer", "carol", 5),
];
eq(
  "mine pulled to front, both groups keep relative order",
  keys(orderTasksMineFirst(mixed, "me")).join(","),
  "mine-old,mine-new,old-peer,unowned,peer",
);

eq(
  "unowned is not mine",
  keys(orderTasksMineFirst([task("u", undefined), task("m", "me")], "me")).join(
    ",",
  ),
  "m,u",
);

eq(
  "alice does not match alice-2",
  keys(
    orderTasksMineFirst(
      [task("other", "alice-2"), task("mine", "alice")],
      "alice",
    ),
  ).join(","),
  "mine,other",
);

const original = [task("a", "bob"), task("b", "me")];
const snapshot = keys(original).join(",");
orderTasksMineFirst(original, "me");
eq("does not mutate the input array", keys(original).join(","), snapshot);

eq(
  "empty identity treats nothing as mine",
  keys(orderTasksMineFirst([task("m", "me"), task("u", undefined)], "")).join(
    ",",
  ),
  "m,u",
);

const reminderView = {
  schemaVersion: TOWER_DO_SCHEMA_VERSION,
  revision: 7,
  tasks: mixed,
  messages: [],
  findings: [],
};
const reminder = formatBoardReminder(reminderView, "me");
const taskLines = reminder
  .split("\n")
  .filter((line) => line.startsWith("- ["));
eq(
  "reminder lists mine rows before peers",
  taskLines.map((line) => line.split(" ")[2]?.replace(":", "")).join(","),
  "mine-old,mine-new,old-peer,unowned,peer",
);
check(
  "reminder header still counts the whole board",
  reminder.includes("5 task(s)") && reminder.includes("you are me"),
  reminder.split("\n")[0],
);

if (failures > 0) {
  console.error(`${failures} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
