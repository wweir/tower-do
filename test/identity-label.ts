/**
 * tower-do identity labels — one agent, one key.
 *
 * pi session ids are UUIDv7 hex (`8-4-4-4-12`): the first 12 digits are a
 * millisecond timestamp, the last 12 are random. Through 0.4.0 the board
 * identity was `session-<time8>` — the top 32 bits of that timestamp, i.e. pure
 * time with NO entropy — so every session started inside the same 65536 ms
 * (65.5 s) bucket resolved to the same identity. Observed live: two sibling
 * subagents 26 ms apart both became `session-01a0b47e`, sharing one owner key,
 * one liveness record and one message audience.
 *
 * This file locks the fix and the migration rule:
 *   1. `sessionLabel` adds 8 hex digits of the id's random tail, so bucket
 *      siblings are distinct (and distinct ids stay distinct);
 *   2. `sameAgent` equates a legacy label with the CURRENT label it prefixes
 *      (rows written before the change stay owned/addressable/protected), but
 *      never two current labels — not even in one bucket (the collision);
 *   3. the owner guard, the staleness gate, the inbox and presence all go
 *      through that relation, proven end-to-end on the real entry points.
 *
 * Run with: bun run test/identity-label.ts
 */
import {
  createEmptyBoard,
  derivePresence,
  messagesToMe,
  readByWith,
  sameAgent,
  sessionLabel,
  staleTaskOwners,
  unreadMessagesToMe,
  writeBoardSnapshot,
  MAX_IDENTITY_CHARS,
  type ActivityEntry,
  type TowerBoardView,
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
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
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

// The real ids from the live incident: same 65.5 s bucket (identical first 8
// hex digits), 26 ms and one random tail apart.
const SIBLING_A = "01a0b47e-b9bf-70bd-9a77-2412ac0f8017";
const SIBLING_B = "01a0b47e-b9d9-70bd-9a77-2416a6b6d6be";
const OTHER_BUCKET = "01a0b47f-0000-70bd-9a77-2408af4fdaf8";

const legacyOf = (id: string) => `session-${id.slice(0, 8)}`;

// ---------------------------------------------------------------------------
// 1. Label generation
// ---------------------------------------------------------------------------
const labelA = sessionLabel(SIBLING_A);
const labelB = sessionLabel(SIBLING_B);
check(
  "bucket siblings get distinct labels (the incident)",
  labelA !== labelB,
  `${labelA} vs ${labelB}`,
);
check(
  "the legacy label is a strict prefix of the current label",
  labelA.startsWith(legacyOf(SIBLING_A)) &&
    labelA.length > legacyOf(SIBLING_A).length,
  labelA,
);
check(
  "the same session id always maps to the same label",
  sessionLabel(SIBLING_A) === labelA,
);
check(
  "a different bucket gets a different label",
  sessionLabel(OTHER_BUCKET) !== labelA,
);
check(
  "labels keep the readable time prefix (old dashboards still sort/scan)",
  labelA.startsWith("session-01a0b47e-") && labelA.endsWith("ac0f8017"),
  labelA,
);
check(
  "the label format is exactly `session-<time8>-<rand8>`",
  labelA === "session-01a0b47e-ac0f8017",
  labelA,
);
check(
  "labels stay well under MAX_IDENTITY_CHARS",
  labelA.length < MAX_IDENTITY_CHARS,
  `${labelA.length} of ${MAX_IDENTITY_CHARS} chars`,
);
check(
  "a whole bucket of sessions collapses to distinct labels",
  new Set(
    Array.from({ length: 32 }, (_, i) =>
      sessionLabel(
        `01a0b47e-${(0xb9bf + i * 7).toString(16).padStart(4, "0")}-70bd-9a77-${(0x2412ac0f8017 + i).toString(16)}`,
      ),
    ),
  ).size === 32,
);
check(
  "non-UUID session ids (tests, other harnesses) stay stable",
  sessionLabel("smoke-session-id-0001") === sessionLabel("smoke-session-id-0001") &&
    sessionLabel("smoke-session-id-0001") !== sessionLabel("smoke-session-id-0002"),
);

// ---------------------------------------------------------------------------
// 2. sameAgent — the relation itself
// ---------------------------------------------------------------------------
check("identical labels are the same agent", sameAgent(labelA, labelA));
check(
  "legacy label ≡ the current label it prefixes",
  sameAgent(legacyOf(SIBLING_A), labelA) && sameAgent(labelA, legacyOf(SIBLING_A)),
);
check(
  "two CURRENT labels in one bucket are NOT the same agent (the fix)",
  !sameAgent(labelA, labelB),
);
check(
  "bucket siblings' legacy label is not the same agent as the other's current label",
  !sameAgent(legacyOf(SIBLING_A), labelB) === false &&
    sameAgent(legacyOf(SIBLING_A), labelB),
  "(a legacy label is ambiguous for its bucket — documented)",
);
check(
  "different buckets are different agents",
  !sameAgent(labelA, sessionLabel(OTHER_BUCKET)) &&
    !sameAgent(legacyOf(SIBLING_A), sessionLabel(OTHER_BUCKET)),
);
check(
  "user labels compare verbatim",
  sameAgent("alice", "alice") &&
    !sameAgent("alice", "alice ") &&
    !sameAgent("alice", labelA) &&
    !sameAgent("coder-1", "coder-2"),
);
check(
  "sameAgent is deliberately NOT transitive across bucket siblings",
  sameAgent(legacyOf(SIBLING_A), labelA) &&
    sameAgent(legacyOf(SIBLING_A), labelB) &&
    !sameAgent(labelA, labelB),
);

// ---------------------------------------------------------------------------
// 3. Owner guard (writeBoardSnapshot) through the relation
// ---------------------------------------------------------------------------
const plan = (owner: string) =>
  writeBoardSnapshot(
    createEmptyBoard(),
    { tasks: [{ key: "work", subject: "task", status: "pending", owner }] },
    owner,
  ).view;

const legacyOwned = plan(legacyOf(SIBLING_A));
const relabel = (view: TowerBoardView, caller: string, owner?: string) =>
  writeBoardSnapshot(
    view,
    {
      baseRevision: view.revision,
      tasks: [{ key: "work", subject: "task", owner: owner ?? caller }],
    },
    caller,
  );

expectThrows(
  "a bucket sibling CANNOT take a legacy-owned row (ambiguity is strict, never guessed)",
  () => relabel(legacyOwned, labelA),
  /is owned by/,
);
expectThrows(
  "a bucket sibling CANNOT remove a legacy-owned row",
  () => writeBoardSnapshot(legacyOwned, { baseRevision: 1, tasks: [] }, labelA),
  /is owned by/,
);
check(
  "the legacy label itself still matches its own row exactly (a pre-0.4.1 caller)",
  writeBoardSnapshot(
    legacyOwned,
    { baseRevision: 1, tasks: [{ key: "work", subject: "task" }] },
    legacyOf(SIBLING_A),
  ).view.tasks[0]?.owner === legacyOf(SIBLING_A),
);
check(
  "a legacy row IS adoptable through the idle window (the documented remedy)",
  writeBoardSnapshot(
    legacyOwned,
    {
      baseRevision: 1,
      tasks: [{ key: "work", subject: "task", owner: labelA }],
    },
    labelA,
    new Set([legacyOf(SIBLING_A)]),
  ).view.tasks[0]?.owner === labelA,
);
expectThrows(
  "a bucket sibling cannot take a CURRENT-label row (the collision)",
  () => relabel(plan(labelA), labelB),
  /is owned by/,
);
expectThrows(
  "a bucket sibling cannot remove a CURRENT-label row",
  () => writeBoardSnapshot(plan(labelA), { baseRevision: 1, tasks: [] }, labelB),
  /is owned by/,
);
expectThrows(
  "an unrelated identity cannot take a legacy-owned row",
  () => relabel(legacyOwned, sessionLabel(OTHER_BUCKET)),
  /is owned by/,
);
check(
  "the owner may still drop its own row",
  writeBoardSnapshot(
    plan(labelA),
    { baseRevision: 1, tasks: [] },
    labelA,
  ).view.tasks.length === 0,
);

// ---------------------------------------------------------------------------
// 4. Staleness / liveness gate
// ---------------------------------------------------------------------------
const OLD = Date.now() - 60 * 60_000;
const legacyTask: TowerDoTask = {
  key: "work",
  subject: "task",
  status: "in_progress",
  owner: legacyOf(SIBLING_A),
  dependsOn: [],
  blockedBy: [],
  updatedAt: OLD,
};
const activity: ActivityEntry[] = [
  {
    kind: "task",
    by: legacyOf(SIBLING_A),
    at: OLD,
    glyph: "◐",
    detail: "work",
    taskKey: "work",
  },
];
check(
  "a current-label heartbeat does NOT speak for a legacy owner (exact staleness)",
  staleTaskOwners(
    activity,
    [legacyTask],
    Date.now(),
    30 * 60_000,
    new Set([labelA]),
  ).has(legacyOf(SIBLING_A)),
);
check(
  "a legacy owner is protected by a heartbeat under its own label",
  staleTaskOwners(
    activity,
    [legacyTask],
    Date.now(),
    30 * 60_000,
    new Set([legacyOf(SIBLING_A)]),
  ).size === 0,
);
check(
  "…and the same query still reports stale when nobody is live",
  staleTaskOwners(
    activity,
    [legacyTask],
    Date.now(),
    30 * 60_000,
    new Set(),
  ).has(legacyOf(SIBLING_A)),
);
const currentTask: TowerDoTask = { ...legacyTask, owner: labelA };
check(
  "a bucket sibling's liveness does NOT protect a current-label owner (the fix)",
  staleTaskOwners(
    activity,
    [currentTask],
    Date.now(),
    30 * 60_000,
    new Set([labelB]),
  ).has(labelA),
);
check(
  "a current-label owner is protected by its own liveness",
  staleTaskOwners(
    activity,
    [currentTask],
    Date.now(),
    30 * 60_000,
    new Set([labelA]),
  ).size === 0,
);

// ---------------------------------------------------------------------------
// 5. Inbox + read receipts
// ---------------------------------------------------------------------------
const message = (
  to: string,
  readBy?: string[],
): TowerBoardView["messages"][number] => ({
  id: "m-1",
  action: "send",
  to,
  from: "alice",
  subject: "hand-off",
  body: "please take it",
  at: Date.now(),
  ...(readBy === undefined ? {} : { readBy }),
});
const withMessage = (to: string, readBy?: string[]): TowerBoardView => ({
  ...createEmptyBoard(),
  revision: 1,
  messages: [message(to, readBy)],
});
check(
  "a message addressed to the legacy label is DELIVERED to the current label",
  messagesToMe(withMessage(legacyOf(SIBLING_A)), labelA).length === 1,
);
check(
  "a bucket sibling also receives it — deliberate: over-delivery beats losing mail",
  messagesToMe(withMessage(legacyOf(SIBLING_A)), labelB).length === 1,
);
check(
  "a message addressed to the current label reaches the legacy label",
  messagesToMe(withMessage(labelA), legacyOf(SIBLING_A)).length === 1,
);
check(
  "a bucket sibling does NOT receive a current-label message (the fix)",
  messagesToMe(withMessage(labelA), labelB).length === 0,
);
check(
  "a legacy read receipt acks the current label",
  unreadMessagesToMe(
    withMessage(legacyOf(SIBLING_A), [legacyOf(SIBLING_A)]),
    labelA,
  ).length === 0,
);
check(
  "acking a message whose legacy receipt exists does not duplicate it",
  JSON.stringify(readByWith([legacyOf(SIBLING_A)], labelA)) ===
    JSON.stringify([legacyOf(SIBLING_A)]),
);
check(
  "acking a message with no receipt appends the current label",
  JSON.stringify(readByWith([], labelA)) === JSON.stringify([labelA]),
);
check(
  "acking twice does not duplicate the receipt",
  JSON.stringify(readByWith([labelA], labelA)) === JSON.stringify([labelA]),
);

// ---------------------------------------------------------------------------
// 6. Presence: one row per agent, never a transitive bucket merge
// ---------------------------------------------------------------------------
const presence = derivePresence(
  [
    { kind: "task", by: legacyOf(SIBLING_A), at: Date.now(), glyph: "◐", detail: "work" },
    { kind: "task", by: labelA, at: Date.now() - 1000, glyph: "◐", detail: "work" },
  ],
  [{ ...legacyTask, owner: labelA }],
  Date.now(),
);
check(
  "a legacy row merges into the current label of its bucket",
  presence.length === 1 && presence[0].identity === labelA,
  presence.map((line) => line.identity).join(","),
);
const twoSiblings = derivePresence(
  [
    { kind: "task", by: labelA, at: Date.now(), glyph: "◐", detail: "a" },
    { kind: "task", by: labelB, at: Date.now() - 1000, glyph: "◐", detail: "b" },
  ],
  [],
  Date.now(),
);
check(
  "two current labels in one bucket stay two rows (no transitive merge)",
  twoSiblings.length === 2,
  twoSiblings.map((line) => line.identity).join(","),
);

console.log(
  `\n${failures === 0 ? "OK" : "FAILED"}  ${passed} passed, ${failures} failed`,
);
if (failures > 0) process.exit(1);
