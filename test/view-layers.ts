/**
 * Layered dashboard view:
 *
 *  1. classifyTaskLayers splits unfinished tasks into mine / needs / other and
 *     receipts into completed.
 *  2. `needs` is peer unfinished work the caller is coupled to: its own work
 *     awaits it (`await`), unread mail threads under it (`unread`), or it
 *     awaits the caller's unfinished work (`blocking`).
 *  3. Order inside every layer is recency-first: `updatedAt` DESC, `key` ASC.
 *  4. Unowned is not mine; `alice` does not match `alice-2`; empty identity
 *     treats nothing as mine; the input is never mutated.
 *  5. The reminder renders the caller's own rows plus the coupled peer rows;
 *     the unrelated layer folds into one key line (formatOtherKeysLine) or a
 *     shape summary (formatLayerSummary). A peer whose declared scope
 *     intersects the caller's own unfinished scope lands in `needs` too
 *     (reason `scope`). The widget's equivalent lines live inline in index.ts
 *     (theme + width handling) and have no unit test of their own — they are
 *     exercised by the live end-to-end smoke (a fresh pi process rendering
 *     the real widget), not here.
 *  6. orderTasksByLayer still flattens mine / needs / other for callers that
 *     want the whole order.
 *  7. formatLedgerRow / formatLedgerKeyRows keep every key enumerable, so a
 *     full-replacement write can still name the whole board from a folded view.
 *  8. Dashboard budget slice/note (formerly covered by test/mine-first.ts).
 *
 * Run: bun run test/view-layers.ts
 */
import {
  DASHBOARD_FINDING_LINE_CHARS,
  DASHBOARD_ROW_BUDGET,
  TOWER_DO_SCHEMA_VERSION,
  classifyTaskLayers,
  foldDashboardSections,
  formatBoardReminder,
  formatDashboardHiddenNote,
  formatLayerSummary,
  formatLedgerKeyRows,
  formatLedgerRow,
  formatOtherKeysLine,
  orderTasksByLayer,
  sliceTaskDashboard,
  sliceScopeConflicts,
  truncateChars,
  type TowerBoardView,
  type TowerDoMessage,
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
  extra: Partial<TowerDoTask> = {},
): TowerDoTask {
  return {
    key,
    subject: key,
    status: "pending",
    dependsOn: [],
    blockedBy: [],
    updatedAt,
    ...(owner === undefined ? {} : { owner }),
    ...extra,
  };
}

const completed = (
  key: string,
  owner: string | undefined = "peer",
  updatedAt = 0,
): TowerDoTask =>
  task(key, owner, updatedAt, { status: "completed" as const });

const board = (
  tasks: TowerDoTask[],
  messages: TowerDoMessage[] = [],
): TowerBoardView => ({
  schemaVersion: TOWER_DO_SCHEMA_VERSION,
  revision: 1,
  tasks,
  messages,
  findings: [],
  skipped: 0,
});

const keys = (items: readonly { key: string }[]): string[] =>
  items.map((item) => item.key);

// --- 1. layering -----------------------------------------------------------

const simple = classifyTaskLayers(
  [task("m", "me", 1), task("p", "bob", 2), completed("done")],
  board([task("m", "me", 1), task("p", "bob", 2), completed("done")]),
  "me",
);
eq("mine holds the caller's unfinished task", keys(simple.mine).join(","), "m");
eq("others hold unrelated unfinished work", keys(simple.other).join(","), "p");
eq(
  "completed rows land in their own layer",
  keys(simple.completed).join(","),
  "done",
);

const ownCompletedView = board([
  task("open", "me", 1),
  completed("mine-done", "me", 2),
]);
const ownCompleted = classifyTaskLayers(
  ownCompletedView.tasks,
  ownCompletedView,
  "me",
);
check(
  "my completed work is a receipt, not a mine row",
  keys(ownCompleted.mine).join(",") === "open" &&
    keys(ownCompleted.completed).join(",") === "mine-done",
  `${keys(ownCompleted.mine)}|${keys(ownCompleted.completed)}`,
);

const unownedView = board([task("u", undefined, 1), task("m", "me", 2)]);
const unowned = classifyTaskLayers(unownedView.tasks, unownedView, "me");
check(
  "unowned is not mine",
  keys(unowned.mine).join(",") === "m" &&
    keys(unowned.other).join(",") === "u",
  `${keys(unowned.mine)}|${keys(unowned.other)}`,
);

const siblingView = board([
  task("other", "alice-2", 1),
  task("mine", "alice", 2),
]);
const sibling = classifyTaskLayers(siblingView.tasks, siblingView, "alice");
check(
  "alice does not match alice-2",
  keys(sibling.mine).join(",") === "mine" &&
    keys(sibling.other).join(",") === "other",
  `${keys(sibling.mine)}|${keys(sibling.other)}`,
);

const noIdentityView = board([task("m", "me", 1), task("u", undefined, 2)]);
const noIdentity = classifyTaskLayers(noIdentityView.tasks, noIdentityView, "");
eq(
  "empty identity treats nothing as mine",
  keys(noIdentity.mine).join(","),
  "",
);

const recencyView = board([
  task("old", "bob", 1),
  task("new-b", "bob", 9),
  task("new-a", "bob", 9),
  task("mine-old", "me", 1),
  task("mine-new", "me", 5),
]);
const recency = classifyTaskLayers(recencyView.tasks, recencyView, "me");
eq(
  "layers are recency-first with a key tiebreaker",
  keys(recency.other).join(","),
  "new-a,new-b,old",
);
eq(
  "mine keeps the same recency order",
  keys(recency.mine).join(","),
  "mine-new,mine-old",
);

// --- 2. needs --------------------------------------------------------------

const awaitView = board([
  task("mine", "me", 10, { dependsOn: ["peer-dep"] }),
  task("peer-dep", "bob", 5),
  completed("done-dep", "bob", 4),
]);
const awaited = classifyTaskLayers(awaitView.tasks, awaitView, "me");
check(
  "needs: my unfinished work awaits a peer key",
  awaited.needs.length === 1 &&
    awaited.needs[0]?.task.key === "peer-dep" &&
    awaited.needs[0]?.reason === "await",
  JSON.stringify(awaited.needs.map((entry) => [entry.task.key, entry.reason])),
);
const resolved = classifyTaskLayers(
  board([
    task("mine", "me", 10, { dependsOn: ["done-dep"] }),
    completed("done-dep"),
  ]).tasks,
  board([
    task("mine", "me", 10, { dependsOn: ["done-dep"] }),
    completed("done-dep"),
  ]),
  "me",
);
eq(
  "a completed dependency is not a needs row",
  resolved.needs.length,
  0,
);

const mailView = board(
  [task("peer-msg", "bob", 5), task("unrelated", "carol", 5)],
  [
    {
      id: "m1",
      from: "bob",
      to: "me",
      subject: "ping",
      body: "hello",
      at: 1,
      taskKey: "peer-msg",
    },
  ],
);
const mailed = classifyTaskLayers(mailView.tasks, mailView, "me");
check(
  "needs: unread mail threads under a peer key",
  mailed.needs.length === 1 &&
    mailed.needs[0]?.task.key === "peer-msg" &&
    mailed.needs[0]?.reason === "unread",
  JSON.stringify(mailed.needs.map((entry) => [entry.task.key, entry.reason])),
);

const blockingView = board([
  task("mine", "me", 1),
  task("waits-on-me", "bob", 2, { dependsOn: ["mine"] }),
  task("free", "carol", 3),
]);
const blocking = classifyTaskLayers(blockingView.tasks, blockingView, "me");
check(
  "needs: a peer task awaits my unfinished key",
  blocking.needs.length === 1 &&
    blocking.needs[0]?.task.key === "waits-on-me" &&
    blocking.needs[0]?.reason === "blocking",
  JSON.stringify(blocking.needs.map((entry) => [entry.task.key, entry.reason])),
);

const emptyLayers = classifyTaskLayers([], board([]), "me");
check(
  "an empty board has four empty layers",
  emptyLayers.mine.length === 0 &&
    emptyLayers.needs.length === 0 &&
    emptyLayers.other.length === 0 &&
    emptyLayers.completed.length === 0,
  JSON.stringify(emptyLayers),
);
const parkedView = board([
  task("mine", "me", 5, { blockedBy: ["peer"] }),
  task("peer", "bob", 1),
  task("unrelated", "carol", 2),
]);
const parked = classifyTaskLayers(parkedView.tasks, parkedView, "me");
check(
  "needs: a board task named in blockedBy counts as awaited",
  parked.needs.length === 1 &&
    parked.needs[0]?.task.key === "peer" &&
    parked.needs[0]?.reason === "await",
  JSON.stringify(parked.needs.map((entry) => [entry.task.key, entry.reason])),
);

const priorityView = board(
  [
    task("mine", "me", 1, { dependsOn: ["both"] }),
    task("both", "bob", 2),
  ],
  [
    {
      id: "m2",
      from: "bob",
      to: "me",
      subject: "ping",
      body: "hello",
      at: 1,
      taskKey: "both",
    },
  ],
);
const priority = classifyTaskLayers(priorityView.tasks, priorityView, "me");
eq(
  "await outranks unread when both apply",
  priority.needs[0]?.reason,
  "await",
);

const overlapView = board([
  task("mine", "me", 1, { dependsOn: ["shared"] }),
  task("shared", "bob", 2, { dependsOn: ["mine"] }),
]);
const overlapLayers = classifyTaskLayers(overlapView.tasks, overlapView, "me");
eq(
  "a needs row appears once, not per reason",
  overlapLayers.needs.length,
  1,
);

const immutable = [task("a", "bob", 1), task("b", "me", 2)];
const snapshot = keys(immutable).join(",");
classifyTaskLayers(immutable, board(immutable), "me");
orderTasksByLayer(immutable, board(immutable), "me");
eq("layering does not mutate the input array", keys(immutable).join(","), snapshot);

const flatView = board([
  task("other", "carol", 1),
  task("mine", "me", 2),
  task("needs", "bob", 3, { dependsOn: ["mine"] }),
]);
eq(
  "orderTasksByLayer flattens mine, then needs, then other",
  keys(orderTasksByLayer(flatView.tasks, flatView, "me")).join(","),
  "mine,needs,other",
);

// --- 3. ledger -------------------------------------------------------------

eq(
  "ledger row carries key, status and owner",
  formatLedgerRow(task("k", "bob", 1)),
  "- k pending @bob",
);
eq(
  "ledger row tolerates an unowned task",
  formatLedgerRow(task("k", undefined, 1)),
  "- k pending",
);

const manyKeys = Array.from({ length: 25 }, (_, i) =>
  task(`key-${String(i).padStart(2, "0")}`, "bob", i),
);
const ledgerRows = formatLedgerKeyRows(manyKeys, 40);
check(
  "key ledger rows stay inside their width",
  ledgerRows.every((row) => row.length <= 40),
  ledgerRows.map((row) => row.length).join(","),
);
const longKey = "x".repeat(60);
const longRows = formatLedgerKeyRows([task(longKey, "bob", 1)], 40);
check(
  "a key longer than the ledger width still gets its own line",
  longRows.length === 1 && longRows[0] === `- ${longKey}`,
  longRows.join(" / "),
);
const mixedRows = formatLedgerKeyRows(
  [task(longKey, "bob", 1), task("short", "bob", 2)],
  40,
);
check(
  "a long key does not absorb the next key onto its line",
  mixedRows.length === 2 && mixedRows[1] === "- short",
  mixedRows.join(" / "),
);
const ledgerText = ledgerRows.join(" ");
check(
  "key ledger loses no key",
  manyKeys.every((item) => ledgerText.includes(item.key)),
  `${ledgerRows.length} rows`,
);
eq(
  "an empty ledger renders nothing",
  formatLedgerKeyRows([]).length,
  0,
);

eq(
  "truncateChars leaves a short string alone",
  truncateChars("abc", 5),
  "abc",
);
eq(
  "truncateChars marks the cut",
  truncateChars("abcdef", 3),
  "abc…",
);
eq(
  "truncateChars counts code points, not UTF-16 units",
  truncateChars("😀😀😀", 2),
  "😀😀…",
);
check(
  "the finding line limit is a real bound",
  DASHBOARD_FINDING_LINE_CHARS > 0 && DASHBOARD_FINDING_LINE_CHARS <= 1000,
  String(DASHBOARD_FINDING_LINE_CHARS),
);

// --- 4. folded TUI dashboard ------------------------------------------------

const folded = foldDashboardSections(
  [
    "head-1",
    "head-2",
    "",
    "## Mine (5)",
    "- m1",
    "- m2",
    "- m3",
    "- m4",
    "- m5",
    "## Needs you (3)",
    "- n1",
    "- n2",
    "- n3",
    "## Messages for me (0; 0 unread)",
    "(none)",
    "## Open findings (1)",
    "- f1",
    "## Completed (2)",
    "- c1, c2",
  ],
  14,
);
check(
  "folded dashboard keeps every must-see section readable",
  folded.length <= 14 &&
    folded.includes("- m1") &&
    folded.includes("- n1") &&
    folded.includes("(none)") &&
    folded.includes("- f1") &&
    !folded.includes("## Completed"),
  folded.join(" / "),
);
const atSection = (prefix: string): number =>
  folded.findIndex((line) => line.startsWith(prefix));
check(
  "folded dashboard keeps the original section order",
  atSection("## Mine") < atSection("## Needs you") &&
    atSection("## Needs you") < atSection("## Messages for") &&
    atSection("## Messages for") < atSection("## Open findings"),
  folded.join(" / "),
);
const foldedNotes = foldDashboardSections(
  [
    "head",
    "",
    "## Completed (2)",
    "- c1, c2",
    "… +40 more row(s) hidden by the 200-row budget",
    "## Recent activity (newest first)",
    "(no recent activity)",
  ],
  4,
);
check(
  "a budget disclosure survives the fold",
  foldedNotes.includes("… +40 more row(s) hidden by the 200-row budget"),
  foldedNotes.join(" / "),
);
// The scope-conflict cut is a section-internal disclosure (`  … +N more`), so
// the fold must match past its indent as well — it is a cut notice, not content
// the budget may drop.
const foldedIndented = foldDashboardSections(
  [
    "head",
    "## Scope conflicts (73, 5 shown) — advisory",
    "- ⛔ overlap: a plans to touch what b already changed — src/a.ts",
    "  … +68 more conflict(s) not shown — view=all lists every one",
    "  (advisory: scope is self-declared, changedFiles is self-reported — resolve by messaging the owner or re-scoping, not by gate)",
    "## Recent activity (newest first)",
    "(no recent activity)",
  ],
  4,
);
check(
  "an indented in-section cut notice survives the fold",
  foldedIndented.includes(
    "  … +68 more conflict(s) not shown — view=all lists every one",
  ),
  foldedIndented.join(" / "),
);
// A budget smaller than the head must still bound the output: the contract is
// "at most `budget` lines", not "at most `budget` lines once a section exists".
eq(
  "a budget smaller than the head still bounds the output",
  foldDashboardSections(["h1", "h2", "## Mine (1)", "- m: x"], 2).length,
  2,
);
const foldedEmpty = foldDashboardSections(
  ["head", "", "## Others (0)", "(no tasks match the filter)"],
  3,
);
check(
  "an empty-filter note is never folded away",
  foldedEmpty.includes("(no tasks match the filter)"),
  foldedEmpty.join(" / "),
);
const foldedCrowded = foldDashboardSections(
  [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "",
    "## Mine (4)",
    "- m1",
    "- m2",
    "- m3",
    "- m4",
    "## Needs you (2)",
    "- n1",
    "- n2",
    "## Open findings (1)",
    "- f1",
    "## Messages for me (1; 1 unread)",
    "- msg1",
    "… +53 more row(s) hidden by the 200-row budget",
  ],
  16,
);
check(
  "a long header plus a disclosure note cannot starve a must-see section",
  ["## Mine", "## Needs you", "## Open findings", "## Messages for"].every(
    (title) => foldedCrowded.some((line) => line.startsWith(title)),
  ) &&
    foldedCrowded.includes("- n1") &&
    foldedCrowded.includes("- f1") &&
    foldedCrowded.includes("- msg1") &&
    foldedCrowded.includes("… +53 more row(s) hidden by the 200-row budget"),
  foldedCrowded.join(" / "),
);
// The renderer emits TWO findings spellings: the folded view uses
// "## Open findings" and `view=all` uses "## Findings", and presence is
// "## Who is around". Every one of them is an action section and must outrank
// history, or a finite budget spends itself on `## Completed` and the reader
// never sees the findings they were told to triage.
const foldedAllFindings = foldDashboardSections(
  [
    "head-1",
    "head-2",
    "## Who is around (2)",
    "- alice — just now",
    "## Findings (3/50 non-closed · 2 actionable · 0 claimed · 0 snoozed · 1 closed<7d)",
    "- f1",
    "## Completed (9)",
    "- c1, c2, c3, c4, c5",
    "## Recent activity (newest first)",
    "- a1",
  ],
  6,
);
check(
  "view=all action sections (## Findings, ## Who is around) outrank history",
  foldedAllFindings.some((line) => line.startsWith("## Findings")) &&
    foldedAllFindings.some((line) => line.startsWith("## Who is around")) &&
    !foldedAllFindings.some((line) => line.startsWith("## Completed")),
  foldedAllFindings.join(" / "),
);
// Disclosures are kept, but the budget is absolute: with more notes than the
// budget the result must still fit. The renderer can emit up to four.
const foldedNoteOverflow = foldDashboardSections(
  [
    "## Mine (2)",
    "- m1",
    "  … +40 more row(s) hidden by the 200-row budget",
    "  … +68 more conflict(s) not shown — view=all lists every one",
    "  … 3 closed finding(s) retired beyond 7d — view=all lists them, findingId reads full text",
  ],
  2,
);
check(
  "disclosure notes cannot exceed the fold budget",
  foldedNoteOverflow.length <= 2,
  `${String(foldedNoteOverflow.length)} lines: ${foldedNoteOverflow.join(" / ")}`,
);
const foldedDetail = foldDashboardSections(
  Array.from({ length: 30 }, (_, i) => `line-${String(i)}`),
  16,
);
check(
  "a detail read without sections is still cut to the fold budget",
  foldedDetail.length === 16 && foldedDetail[0] === "line-0",
  String(foldedDetail.length),
);

// --- scope coupling --------------------------------------------------------

const scopeView = board([
  task("mine", "me", 10, { scope: ["src/a.ts"] }),
  task("peer-same", "bob", 5, { scope: ["src/a.ts"] }),
  task("peer-other", "carol", 4, { scope: ["src/b.ts"] }),
]);
const scopeLayers = classifyTaskLayers(scopeView.tasks, scopeView, "me");
eq(
  "an intersecting peer scope lands in needs with reason scope",
  scopeLayers.needs.map((entry) => `${entry.task.key}:${entry.reason}`).join(","),
  "peer-same:scope",
);
eq(
  "a disjoint peer scope stays other",
  keys(scopeLayers.other).join(","),
  "peer-other",
);
const noScopeView = board([
  task("mine", "me", 10, { scope: ["src/a.ts"] }),
  task("no-scope", "bob", 5),
]);
eq(
  "scope coupling needs a declared scope on both sides",
  keys(classifyTaskLayers(noScopeView.tasks, noScopeView, "me").other).join(","),
  "no-scope",
);

// --- folded layer helpers --------------------------------------------------

eq(
  "the folded-layer key line names every unrelated key",
  formatOtherKeysLine(["a", "b", "c"]),
  "+3 other task(s): a, b, c",
);
const longKeys = Array.from({ length: 40 }, (_, i) => `key-${String(i)}`);
check(
  "an oversized key line truncates and points at the dashboard",
  formatOtherKeysLine(longKeys, 40).includes("… (+") &&
    !formatOtherKeysLine(longKeys, 40).includes("key-39"),
  formatOtherKeysLine(longKeys, 40),
);
const summaryTasks = [
  task("a", "bob", 1, { status: "in_progress" }),
  task("b", "carol", 2, { status: "pending", dependsOn: ["a"] }),
];
eq(
  "the folded-layer summary counts owners, statuses and derived blocks",
  formatLayerSummary(summaryTasks, board(summaryTasks)),
  "2 owner(s) · 1 in_progress · 1 pending · 1 blocked",
);
eq(
  "the folded-layer summary says unowned when nobody owns the layer",
  formatLayerSummary([task("a", undefined, 1)], board([])),
  "unowned · 1 pending",
);

// --- scope-conflict folding ------------------------------------------------

const conflicts = [
  { taskKey: "other-a", kind: "overlap" as const, peerKey: "mine", detail: "x" },
  { taskKey: "peer-1", kind: "collision" as const, peerKey: "peer-2", detail: "y" },
  { taskKey: "mine", kind: "collision" as const, peerKey: "peer-3", detail: "z" },
];
const foldedConflicts = sliceScopeConflicts(conflicts, new Set(["mine"]), 2);
eq(
  "scope-conflict folding keeps the caller's rows first and cuts the rest",
  foldedConflicts.shown.map((conflict) => conflict.taskKey).join(","),
  "other-a,mine",
);
eq("scope-conflict folding reports the cut", foldedConflicts.hidden, 1);
eq(
  "a cap past the row count hides nothing",
  sliceScopeConflicts(conflicts, new Set(), 10).hidden,
  0,
);

// --- 5. reminder -----------------------------------------------------------

const mixedView = board([
  task("old-peer", "bob", 1),
  task("mine-old", "me", 2),
  task("unowned", undefined, 3),
  task("mine-new", "me", 4),
  task("peer", "carol", 5),
]);
const reminder = formatBoardReminder(mixedView, "me");
const reminderLines = reminder.split("\n").filter((line) => line.startsWith("- ["));
eq(
  "reminder lists only the caller's own rows",
  reminderLines
    .map((line) => line.split(" ")[2]?.replace(":", ""))
    .join(","),
  "mine-new,mine-old",
);
check(
  "reminder folds unrelated rows into one key line",
  reminder.includes("+3 other task(s): peer, unowned, old-peer"),
  reminder.split("\n").find((line) => line.startsWith("+")),
);
check(
  "reminder header counts mine, needs and other",
  reminder.includes("5 task(s), 2 mine, 0 need you, 3 other") &&
    reminder.includes("you are me"),
  reminder.split("\n")[0],
);

const coupledView = board([
  task("mine", "me", 10, { dependsOn: ["peer-dep"] }),
  task("peer-dep", "bob", 5),
  task("backlog", "carol", 1),
]);
const coupled = formatBoardReminder(coupledView, "me");
check(
  "reminder marks the coupling reason on needs rows",
  coupled.includes("[needs you: await]"),
  coupled.split("\n").find((line) => line.includes("peer-dep")),
);
check(
  "reminder header counts the needs rows",
  coupled.includes("1 need you"),
  coupled.split("\n")[0],
);
check(
  "reminder keeps coupled work in full and folds the backlog",
  coupled.includes("peer-dep:") &&
    coupled.includes("+1 other task(s): backlog") &&
    !coupled.includes("- [pending] backlog:"),
  coupled.split("\n").slice(1, 4).join(" / "),
);

const scopeCoupledReminder = formatBoardReminder(
  board([
    task("mine-scope", "me", 2, { scope: ["src/auth/**"] }),
    task("peer-scope", "bob", 1, { scope: ["src/auth/login.ts"] }),
  ]),
  "me",
);
check(
  "reminder labels a scope-coupled peer row with its reason",
  scopeCoupledReminder.includes("[needs you: scope]"),
  scopeCoupledReminder
    .split("\n")
    .find((line) => line.includes("peer-scope")),
);

const receiptReminder = formatBoardReminder(
  board([task("open", "me", 2), completed("receipt", "bob", 1)]),
  "me",
);
check(
  "reminder header discloses hidden completed receipts",
  receiptReminder.includes(
    "2 task(s), 1 mine, 0 need you, 0 other, 1 completed hidden",
  ),
  receiptReminder.split("\n")[0],
);

// 13 coupled peers exceed the 12-row attention window. The overflow mixes the
// caller's own rows with coupled peer rows, so it must not call them all
// "yours" — and it names the dropped keys, because a full-replacement write
// replays keys rather than rows.
const manyNeeds = board([
  task("mine", "me", 100, {
    dependsOn: Array.from({ length: 13 }, (_, i) => `need-${String(i)}`),
  }),
  ...Array.from({ length: 13 }, (_, i) =>
    task(`need-${String(i)}`, "bob", i + 1),
  ),
]);
const overflowReminder = formatBoardReminder(manyNeeds, "me");
check(
  "reminder overflow names the dropped coupled keys without claiming them as mine",
  overflowReminder.includes(
    "… and 2 more task(s) you need to see: need-1, need-0",
  ) && !overflowReminder.includes("of your own"),
  overflowReminder
    .split("\n")
    .find((line) => line.includes("more task(s)")),
);

// Reminder cap is 12. Without layering the caller's newest row would fall out
// of the window behind older peer rows.
const buried = [
  ...Array.from({ length: 12 }, (_, i) =>
    task(`peer-${String(i).padStart(2, "0")}`, "bob", i + 1),
  ),
  task("mine-buried", "me", 100),
];
const buriedReminder = formatBoardReminder(board(buried), "me");
const buriedLines = buriedReminder
  .split("\n")
  .filter((line) => line.startsWith("- ["));
check(
  "reminder keeps the caller's buried row and folds the peer backlog",
  buriedLines.length === 1 &&
    buriedLines[0]?.includes("mine-buried:") === true &&
    buriedReminder.includes("+12 other task(s): peer-11, peer-10") &&
    !buriedReminder.includes("- [pending] peer-11:"),
  buriedLines.slice(0, 2).join(" / "),
);
const mailReminder = formatBoardReminder(
  board(
    [task("peer-msg", "bob", 5)],
    [
      {
        id: "m1",
        from: "bob",
        to: "me",
        subject: "ping",
        body: "hi",
        at: 1,
        taskKey: "peer-msg",
      },
    ],
  ),
  "me",
);
check(
  "reminder tags an unread-coupled row",
  mailReminder.includes("[needs you: unread]"),
  mailReminder.split("\n").find((line) => line.includes("peer-msg")),
);
const backReminder = formatBoardReminder(blockingView, "me");
check(
  "reminder tags a row that awaits me",
  backReminder.includes("[needs you: blocking]"),
  backReminder.split("\n").find((line) => line.includes("waits-on-me")),
);

const blockedView = board([
  task("mine", "me", 1, { dependsOn: ["gate"] }),
  task("gate", "bob", 2),
]);
const blockedReminder = formatBoardReminder(blockedView, "me");
check(
  "reminder still counts derived-blocked work board-wide",
  blockedReminder.includes("1 blocked") &&
    blockedReminder.includes("[blocked by: gate]"),
  blockedReminder.split("\n")[0],
);

// --- 5. dashboard budget: open rows are never hidden by the default budget --

// Worst case for fold order: 250 completed rows first, open work appended
// last (a board that outgrew the old 50-row ceiling).
const longHistory = [
  ...Array.from({ length: 250 }, (_, i) =>
    completed(`done-${String(i).padStart(3, "0")}`, "peer", i),
  ),
  task("open-a", "peer", 300),
  task("open-b", "peer", 301),
  task("open-c", "me", 302),
];
const slicedDefault = sliceTaskDashboard(longHistory, undefined);
eq(
  "default budget renders its full budget",
  slicedDefault.shown.length,
  DASHBOARD_ROW_BUDGET,
);
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
  keys(
    slicedDefault.shown.filter((item) => item.status === "completed"),
  ).every((key, index) => key === `done-${String(index).padStart(3, "0")}`),
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

const slicedSmall = sliceTaskDashboard(
  [task("a", "me"), completed("b")],
  undefined,
);
eq("a board inside the budget hides nothing", slicedSmall.hidden, 0);
eq("a board inside the budget renders everything", slicedSmall.shown.length, 2);

if (failures > 0) {
  console.error(`${failures} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
