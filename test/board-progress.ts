/**
 * board-progress segment regression — the widget's remaining-work glance:
 *
 *  1. empty gate: no open work and no unread mail renders nothing
 *     (a board of completed rows shows no progress at all — completed
 *     tasks never counted, unlike the old `x/y done` fraction).
 *  2. composition: `TowerDo N open`, `· M blocked` only when blocked,
 *     `· K msg` only when unread; inbox survives an all-done board.
 *  3. wrappers: em/label receive the segment kind (title / open / blocked /
 *     unread / sep) so callers can emphasize numbers and dim unit words.
 *
 * Run: bun test/board-progress.ts
 */
import { formatBoardProgress } from "../state.ts";

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

// 1. empty gate: a board of completed rows shows no progress at all —
// completed tasks never counted, unlike the old `x/y done` fraction.
eq(
  "completed-only board renders empty (no inbox)",
  formatBoardProgress(0, 0, 0),
  "",
);

// 2. composition.
eq("open only", formatBoardProgress(2, 0, 0), "TowerDo 2 open");
eq(
  "open with blocked subset",
  formatBoardProgress(3, 1, 0),
  "TowerDo 3 open · 1 blocked",
);
eq(
  "open with unread mail",
  formatBoardProgress(2, 0, 4),
  "TowerDo 2 open · 4 msg",
);
eq(
  "full composition",
  formatBoardProgress(3, 1, 2),
  "TowerDo 3 open · 1 blocked · 2 msg",
);
eq(
  "inbox alone survives an all-done board",
  formatBoardProgress(0, 0, 5),
  "TowerDo 5 msg",
);

// 3. wrappers expose the segment kind.
const ems: string[] = [];
const labels: string[] = [];
formatBoardProgress(
  3,
  1,
  2,
  (n, which) => {
    ems.push(`${which}:${n}`);
    return `<${n}>`;
  },
  (s, which) => {
    labels.push(`${which}:${s}`);
    return `[${s}]`;
  },
);
eq("em kinds", ems.join(","), "open:3,blocked:1,unread:2");
eq(
  "label kinds",
  labels.join(","),
  "title:TowerDo,open: open,sep: · ,blocked: blocked,sep: · ,unread: msg",
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
