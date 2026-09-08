/**
 * live-session segment regression — the widget's `live N` count:
 *
 *  1. liveSessionCount: distinct activity identities within the window,
 *     plus self (a fresh session with zero board writes is still live);
 *     stale identities are excluded, self never is.
 *  2. window boundary: an entry exactly at the window edge still counts.
 *  3. formatLiveSegment: 0 renders empty (keeps the widget gate honest),
 *     non-zero renders `live N` through the em/label wrappers.
 *
 * Run: bun test/live-sessions.ts
 */
import {
  formatLiveSegment,
  liveSessionCount,
  SESSION_LIVE_WINDOW_MS,
  type ActivityEntry,
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

const NOW = 1_000_000;
const entry = (by: string, at: number): ActivityEntry => ({
  kind: "task",
  by,
  at,
  glyph: "◐",
  detail: "k: subject",
});

// 1. distinct identities within the window; stale ones excluded.
eq(
  "two recent identities plus self count as 3",
  liveSessionCount([entry("a", NOW), entry("b", NOW - 1)], "me", NOW),
  3,
);
eq(
  "same identity twice counts once",
  liveSessionCount([entry("a", NOW), entry("a", NOW - 5)], "me", NOW),
  2,
);
eq(
  "stale identities are excluded",
  liveSessionCount(
    [entry("a", NOW - SESSION_LIVE_WINDOW_MS - 1), entry("b", NOW - 1)],
    "me",
    NOW,
  ),
  2,
);

// 2. window boundary: exactly at the edge still counts.
eq(
  "entry exactly at the window edge counts",
  liveSessionCount([entry("a", NOW - SESSION_LIVE_WINDOW_MS)], "me", NOW),
  2,
);

// 3. self is always live, even with no board writes at all.
eq("self with no entries counts as 1", liveSessionCount([], "me", NOW), 1);
eq(
  "self plus one peer counts as 2",
  liveSessionCount([entry("a", NOW)], "me", NOW),
  2,
);
eq(
  "self also seen in the log still counts once",
  liveSessionCount([entry("me", NOW)], "me", NOW),
  1,
);
eq(
  "stale peers plus self counts as 1",
  liveSessionCount([entry("a", NOW - SESSION_LIVE_WINDOW_MS - 1)], "me", NOW),
  1,
);
eq(
  "empty self still counts peers only",
  liveSessionCount([entry("a", NOW)], "", NOW),
  1,
);

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
