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
  DASHBOARD_ROW_BUDGET,
  formatDashboardHiddenNote,
  TOWER_DO_SCHEMA_VERSION,
  formatBoardReminder,
  orderTasksMineFirst,
  sliceTaskDashboard,
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

const completed = (key: string, updatedAt = 0): TowerDoTask => ({
  ...task(key, "peer", updatedAt),
  status: "completed",
});

eq(
  "empty input stays empty",
  keys(orderTasksMineFirst([], "me")).join(","),
  "",
);

const noMine = [
  task("a", "bob", 1),
  task("b", undefined, 2),
  task("c", "x", 3),
];
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
const taskLines = reminder.split("\n").filter((line) => line.startsWith("- ["));
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

// Reminder cap is 12. Without mine-first the last fold-order row (the
// caller's) would fall out of the window behind 12 older peers.
const buried = [
  ...Array.from({ length: 12 }, (_, i) =>
    task(`peer-${String(i).padStart(2, "0")}`, "bob", i + 1),
  ),
  task("mine-buried", "me", 100),
];
const buriedReminder = formatBoardReminder(
  {
    schemaVersion: TOWER_DO_SCHEMA_VERSION,
    revision: 1,
    tasks: buried,
    messages: [],
    findings: [],
  },
  "me",
);
const buriedLines = buriedReminder
  .split("\n")
  .filter((line) => line.startsWith("- ["));
check(
  "reminder cap keeps a buried mine row and drops the last peer",
  buriedLines.length === 12 &&
    buriedLines[0]?.includes("mine-buried:") === true &&
    buriedReminder.includes("peer-00:") &&
    !buriedReminder.includes("peer-11:") &&
    buriedReminder.includes("1 more unfinished"),
  buriedLines[0] ?? buriedReminder.split("\n")[0],
);

// --- 5. dashboard budget: open rows are never hidden by the default budget ---

// Worst case for fold order: 250 completed rows first, open work appended
// last (a board that outgrew the old 50-row ceiling).
const longHistory = [
  ...Array.from({ length: 250 }, (_, i) =>
    completed(`done-${String(i).padStart(3, "0")}`, i),
  ),
  task("open-a", "peer", 300),
  task("open-b", "peer", 301),
  task("open-c", "me", 302),
];
const slicedDefault = sliceTaskDashboard(longHistory, undefined);
eq("default budget renders its full budget", slicedDefault.shown.length, DASHBOARD_ROW_BUDGET);
eq("default budget hides only the surplus", slicedDefault.hidden, 53);
check(
  "every open row survives the default budget",
  ["open-a", "open-b", "open-c"].every((key) =>
    slicedDefault.shown.some((item) => item.key === key),
  ),
  keys(slicedDefault.shown.slice(-3)).join(","),
);
check(
  "completed rows keep their relative order inside the budget",
  keys(slicedDefault.shown.filter((item) => item.status === "completed")).every(
    (key, index) => key === `done-${String(index).padStart(3, "0")}`,
  ),
);
check(
  "slicing does not mutate the input",
  longHistory.length === 253 && longHistory[0]?.key === "done-000",
);

const slicedExplicit = sliceTaskDashboard(longHistory, 5);
eq("explicit limit is honoured verbatim", slicedExplicit.shown.length, 5);
eq(
  "explicit limit keeps fold order, open rows included in the cut",
  keys(slicedExplicit.shown).join(","),
  "done-000,done-001,done-002,done-003,done-004",
);
eq("explicit limit reports every hidden row", slicedExplicit.hidden, 248);

const defaultNote = formatDashboardHiddenNote(53, undefined);
check(
  "default-budget note names the widening remedy",
  typeof defaultNote === "string" &&
    defaultNote.includes("hidden by the 200-row budget") &&
    defaultNote.includes("open rows win the default budget") &&
    defaultNote.includes("narrow with owner=/status="),
  defaultNote,
);
const explicitNote = formatDashboardHiddenNote(1, 1);
check(
  "explicit-limit note keeps fold order's own remedy",
  typeof explicitNote === "string" &&
    explicitNote.includes("hidden by the 1-row budget") &&
    explicitNote.includes("pass a larger limit") &&
    !explicitNote.includes("open rows win"),
  explicitNote,
);
eq(
  "no hidden-rows note when nothing was hidden",
  formatDashboardHiddenNote(0, undefined),
  undefined,
);

const slicedSmall = sliceTaskDashboard([task("a", "me"), completed("b")], undefined);
eq("a board inside the budget hides nothing", slicedSmall.hidden, 0);
eq("a board inside the budget renders everything", slicedSmall.shown.length, 2);

if (failures > 0) {
  console.error(`${failures} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
