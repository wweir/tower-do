/**
 * Push-wake pure logic (state.ts):
 *
 *  1. selectWakeMessages delivers DIRECT unread mail only, oldest first, and
 *     never re-delivers an id already pushed on this branch. Broadcasts are
 *     excluded by policy (they would start a turn in every live session at
 *     once); the pull path still surfaces them.
 *  2. formatWakeMail names the provenance (peer board message, not user input),
 *     the message ids, the thread, and a bounded body (WAKE_BODY_CHARS per
 *     message, with a visible truncation marker) — the model must be able to
 *     reply and to ack without a second read.
 *  3. deliveredMailIds reads the ids back from this branch's own
 *     `TOWER_DO_MAIL_TYPE` custom messages and their `TOWER_DO_MAIL_PENDING_TYPE`
 *     markers (restore suppression across a deferred send / reload), tolerating
 *     foreign/malformed entries.
 *
 * Run: bun test/wake-mail.ts
 */
import {
  createEmptyBoard,
  deliveredMailIds,
  formatWakeMail,
  selectWakeMessages,
  TOWER_DO_MAIL_PENDING_TYPE,
  TOWER_DO_MAIL_TYPE,
  WAKE_BODY_CHARS,
  type TowerBoardView,
  type TowerDoMessage,
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

function message(
  partial: Pick<TowerDoMessage, "id" | "to" | "from" | "subject" | "body" | "at"> &
    Partial<TowerDoMessage>,
): TowerDoMessage {
  return { ...partial };
}

function board(messages: TowerDoMessage[]): TowerBoardView {
  return { ...createEmptyBoard(), messages };
}

// --- selectWakeMessages ---------------------------------------------------

const direct = message({
  id: "m-direct",
  to: "alice",
  from: "bob",
  subject: "please review",
  body: "the diff is on branch x",
  at: 100,
});
const older = message({
  id: "m-older",
  to: "alice",
  from: "carol",
  subject: "earlier",
  body: "first",
  at: 50,
});
const broadcast = message({
  id: "m-all",
  to: "all",
  from: "bob",
  subject: "team update",
  body: "heads up",
  at: 75,
  audience: ["alice"],
});
const acked = message({
  id: "m-acked",
  to: "alice",
  from: "bob",
  subject: "done",
  body: "already read",
  at: 90,
  readBy: ["alice"],
});
const mine = message({
  id: "m-mine",
  to: "alice",
  from: "alice",
  subject: "note to self",
  body: "self send never reaches inbox",
  at: 95,
});
const toOther = message({
  id: "m-other",
  to: "dave",
  from: "bob",
  subject: "for dave",
  body: "not mine",
  at: 96,
});

const view = board([direct, older, broadcast, acked, mine, toOther]);

eq(
  "direct unread mail is selected, oldest first",
  selectWakeMessages(view, "alice", new Set()).map((m) => m.id).join(","),
  "m-older,m-direct",
);
eq(
  "a broadcast never wakes",
  selectWakeMessages(view, "alice", new Set()).some((m) => m.id === "m-all"),
  false,
);
eq(
  "an acked direct message never wakes",
  selectWakeMessages(view, "alice", new Set()).some((m) => m.id === "m-acked"),
  false,
);
eq(
  "a self-sent message never wakes",
  selectWakeMessages(view, "alice", new Set()).some((m) => m.id === "m-mine"),
  false,
);
eq(
  "a message addressed to a peer never wakes",
  selectWakeMessages(view, "alice", new Set()).some((m) => m.id === "m-other"),
  false,
);
eq(
  "an already-pushed id is suppressed",
  selectWakeMessages(view, "alice", new Set(["m-direct"])).map((m) => m.id).join(","),
  "m-older",
);
eq(
  "all delivered ids suppress everything",
  selectWakeMessages(view, "alice", new Set(["m-older", "m-direct"])).length,
  0,
);

// Tie on `at` breaks by id, so a burst is delivered in a deterministic order.
const tieB = message({ id: "m-b", to: "alice", from: "bob", subject: "b", body: "", at: 10 });
const tieA = message({ id: "m-a", to: "alice", from: "bob", subject: "a", body: "", at: 10 });
eq(
  "same-timestamp mail is ordered by id",
  selectWakeMessages(board([tieB, tieA]), "alice", new Set())
    .map((m) => m.id)
    .join(","),
  "m-a,m-b",
);

// Legacy label forms must still match (delivery is aliased, permission is not).
const legacy = message({
  id: "m-legacy",
  to: "session-01a0b444",
  from: "bob",
  subject: "legacy label",
  body: "",
  at: 120,
});
check(
  "a legacy session label is recognized as the same agent",
  selectWakeMessages(board([legacy]), "session-01a0b444-ef71fa71", new Set()).length === 1,
);

eq(
  "select never mutates the input order",
  view.messages.map((m) => m.id).join(","),
  "m-direct,m-older,m-all,m-acked,m-mine,m-other",
);

// --- formatWakeMail -------------------------------------------------------

const rendered = formatWakeMail([older, direct], "alice");
check(
  "the render names the provenance (peer message, not user input)",
  rendered.includes("not user input") &&
    rendered.includes("tower_do_talk action=inbox"),
);
check(
  "the render carries every message id and sender",
  rendered.includes("[m-older]") &&
    rendered.includes("[m-direct]") &&
    rendered.includes("carol → alice") &&
    rendered.includes("bob → alice"),
);
check(
  "the render carries the subject and full body",
  rendered.includes("please review") && rendered.includes("the diff is on branch x"),
);
eq(
  "the one-message render reports the count",
  formatWakeMail([direct], "alice").includes("1 board message(s)"),
  true,
);
const threaded = formatWakeMail(
  [message({ ...direct, id: "m-t", taskKey: "auth-refactor" })],
  "alice",
);
check("the render names the task thread", threaded.includes("(task auth-refactor)"));
eq(
  "no trailing blank line",
  formatWakeMail([direct], "alice").endsWith("\n"),
  false,
);
eq("an empty list renders nothing", formatWakeMail([], "alice"), "");

// A body can be up to 32 KiB and a wake merges up to 5 of them; the render must
// stay bounded while keeping every header.
const longBody = "x".repeat(WAKE_BODY_CHARS + 50);
const renderedLong = formatWakeMail(
  [message({ ...direct, id: "m-long", body: longBody })],
  "alice",
);
check("a long body is capped", renderedLong.includes("body truncated"));
check(
  "a capped render keeps the header",
  renderedLong.includes("[m-long]") && renderedLong.includes("please review"),
);
check(
  "a capped render stays near the cap",
  renderedLong.length < WAKE_BODY_CHARS + 500,
  `got ${String(renderedLong.length)} chars`,
);
eq(
  "a short body is never marked truncated",
  formatWakeMail([direct], "alice").includes("body truncated"),
  false,
);
const exactBody = "y".repeat(WAKE_BODY_CHARS);
eq(
  "a body exactly at the cap is not truncated",
  formatWakeMail([message({ ...direct, id: "m-exact", body: exactBody })], "alice").includes(
    "body truncated",
  ),
  false,
);
check(
  "an empty body still renders its header",
  formatWakeMail([message({ ...direct, id: "m-empty", body: "" })], "alice").includes(
    "[m-empty]",
  ),
);

// --- deliveredMailIds -----------------------------------------------------

const mailEntry = {
  type: "custom_message",
  customType: TOWER_DO_MAIL_TYPE,
  details: { messageIds: ["m-a", "m-b"] },
};
// The durable marker written before the deferred push is persisted.
const pendingEntry = {
  type: "custom",
  customType: TOWER_DO_MAIL_PENDING_TYPE,
  data: { messageIds: ["m-a"] },
};
eq(
  "ids are read back from a pending marker's data",
  [...deliveredMailIds([pendingEntry])].join(","),
  "m-a",
);
eq(
  "push and pending markers union",
  [...deliveredMailIds([mailEntry, pendingEntry])].sort().join(","),
  "m-a,m-b",
);
eq(
  "a pending marker with the push type is ignored",
  deliveredMailIds([{ ...pendingEntry, customType: TOWER_DO_MAIL_TYPE }]).size,
  0,
);
eq(
  "ids are read back from this branch's own mail entries",
  [...deliveredMailIds([mailEntry])].sort().join(","),
  "m-a,m-b",
);
eq(
  "ids union across entries",
  [...deliveredMailIds([mailEntry, { ...mailEntry, details: { messageIds: ["m-c"] } }])]
    .sort()
    .join(","),
  "m-a,m-b,m-c",
);
eq(
  "a foreign customType is ignored",
  deliveredMailIds([{ ...mailEntry, customType: "someone-else" }]).size,
  0,
);
eq(
  "a custom entry (not custom_message) is ignored",
  deliveredMailIds([{ ...mailEntry, type: "custom" }]).size,
  0,
);
eq(
  "a missing details object is ignored",
  deliveredMailIds([{ type: "custom_message", customType: TOWER_DO_MAIL_TYPE }]).size,
  0,
);
eq(
  "a non-array messageIds is ignored",
  deliveredMailIds([
    { type: "custom_message", customType: TOWER_DO_MAIL_TYPE, details: { messageIds: "m-a" } },
  ]).size,
  0,
);
eq(
  "non-string ids are dropped",
  [...deliveredMailIds([
    {
      type: "custom_message",
      customType: TOWER_DO_MAIL_TYPE,
      details: { messageIds: ["m-a", 7, null, { id: "x" }] },
    },
  ])].join(","),
  "m-a",
);
eq("an empty branch delivers nothing", deliveredMailIds([]).size, 0);

// The pushed message must round-trip through the details shape the extension
// sends and the reader expects.
const roundTrip = deliveredMailIds([
  {
    type: "custom_message",
    customType: TOWER_DO_MAIL_TYPE,
    details: { messageIds: selectWakeMessages(view, "alice", new Set()).map((m) => m.id) },
  },
]);
eq(
  "select → details → deliveredMailIds round-trips",
  selectWakeMessages(view, "alice", roundTrip).length,
  0,
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
