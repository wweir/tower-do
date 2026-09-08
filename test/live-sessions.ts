/**
 * live-session segment regression — the widget's `live N` count:
 *
 *  1. liveSessionCount over the per-session liveness sidecar: distinct
 *     identities with a record fresh within LIVE_WINDOW_MS, plus self
 *     (own write failed / not landed yet); stale records are excluded,
 *     self never is.
 *  2. window invariants: expiry covers several missed heartbeats; the GC
 *     prune threshold stays far beyond the window.
 *  3. parseLiveRecord: valid records pass; corrupt/foreign JSON, missing
 *     or empty identity, and non-finite `at` are rejected.
 *  4. formatLiveSegment: 0 renders empty (keeps the widget gate honest),
 *     non-zero renders `live N` through the em/label wrappers.
 *
 * Run: bun test/live-sessions.ts
 */
import {
  formatLiveSegment,
  LIVE_HEARTBEAT_MS,
  LIVE_PRUNE_MS,
  LIVE_WINDOW_MS,
  liveSessionCount,
  parseLiveRecord,
  type LiveRecord,
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

/** Structural equality for parsed-record assertions (eq uses ===). */
function eqJson(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const NOW = 1_000_000;
const rec = (identity: string, at: number): LiveRecord => ({ identity, at });

// 1. distinct fresh identities; stale ones excluded; self always live.
eq(
  "two fresh identities plus self count as 3",
  liveSessionCount([rec("a", NOW), rec("b", NOW - 1)], "me", NOW),
  3,
);
eq(
  "same identity twice counts once",
  liveSessionCount([rec("a", NOW), rec("a", NOW - 5)], "me", NOW),
  2,
);
eq(
  "stale identities are excluded",
  liveSessionCount(
    [rec("a", NOW - LIVE_WINDOW_MS - 1), rec("b", NOW - 1)],
    "me",
    NOW,
  ),
  2,
);

// window boundary: exactly at the edge still counts.
eq(
  "record exactly at the window edge counts",
  liveSessionCount([rec("a", NOW - LIVE_WINDOW_MS)], "me", NOW),
  2,
);

// self union keeps this session counted even with no record of its own.
eq("self with no records counts as 1", liveSessionCount([], "me", NOW), 1);
eq(
  "self plus one peer counts as 2",
  liveSessionCount([rec("a", NOW)], "me", NOW),
  2,
);
eq(
  "self also seen in the sidecar still counts once",
  liveSessionCount([rec("me", NOW)], "me", NOW),
  1,
);
eq(
  "stale peers plus self counts as 1",
  liveSessionCount([rec("a", NOW - LIVE_WINDOW_MS - 1)], "me", NOW),
  1,
);
eq(
  "empty self still counts peers only",
  liveSessionCount([rec("a", NOW)], "", NOW),
  1,
);
eq(
  "stale peers and empty self count as 0",
  liveSessionCount([rec("a", NOW - LIVE_WINDOW_MS - 1)], "", NOW),
  0,
);

// 2. window invariants: a crashed session is expired only after several
// missed heartbeats; residue GC never races a live heartbeat.
check(
  "window covers 4+ missed heartbeats",
  LIVE_WINDOW_MS >= 4 * LIVE_HEARTBEAT_MS,
);
check(
  "prune threshold is far beyond the window",
  LIVE_PRUNE_MS > 3 * LIVE_WINDOW_MS,
);

// 3. parseLiveRecord.
eqJson("valid record parses", parseLiveRecord('{"identity":"a b","at":42}'), {
  identity: "a b",
  at: 42,
});
eq("corrupt JSON rejected", parseLiveRecord("{oops"), undefined);
eq("non-object rejected", parseLiveRecord("42"), undefined);
eq("null rejected", parseLiveRecord("null"), undefined);
eq("missing identity rejected", parseLiveRecord('{"at":1}'), undefined);
eq(
  "empty identity rejected",
  parseLiveRecord('{"identity":"  ","at":1}'),
  undefined,
);
eq("missing at rejected", parseLiveRecord('{"identity":"a"}'), undefined);
eq(
  "non-number at rejected",
  parseLiveRecord('{"identity":"a","at":"x"}'),
  undefined,
);
eq("NaN at rejected", parseLiveRecord('{"identity":"a","at":NaN}'), undefined);

// 4. formatLiveSegment.
eq("zero renders empty", formatLiveSegment(0), "");
eq("one renders live 1", formatLiveSegment(1), "live 1");
eq(
  "wrappers apply",
  formatLiveSegment(
    3,
    (n) => `<${n}>`,
    (s) => `[${s}]`,
  ),
  "[live ]<3>",
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
