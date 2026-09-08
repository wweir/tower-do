/**
 * git-count — pure derivation tests for the TowerDo widget git segment.
 *
 * Covers: porcelain -z parsing (status / untracked / rename / raw special
 * paths), content-hash pairing, session-touched deltas, the attribution
 * re-anchor decision (headMoveIsExternal), and the segment formatting.
 *
 * Run: bun run test/git-count.ts
 */

import {
  ABSENT_HASH,
  EXTERNAL_MOVE_MAX_COMMITS,
  formatGitSegment,
  headMoveIsExternal,
  parseDiffNames,
  parsePorcelain,
  sessionTouchedDelta,
  zipHashObject,
} from "../git-count.ts";

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

// --- parsePorcelain (-z records) ---

const basic = parsePorcelain(
  " M src/a.ts\0M  src/b.ts\0?? scratch.txt\0A  new.ts\0",
);
check(
  "porcelain: tracked changes counted",
  basic.changed.length === 3 &&
    basic.changed.includes("src/a.ts") &&
    basic.changed.includes("src/b.ts") &&
    basic.changed.includes("new.ts"),
  JSON.stringify(basic),
);
check(
  "porcelain: untracked separated",
  basic.untracked.length === 1 && basic.untracked[0] === "scratch.txt",
  JSON.stringify(basic.untracked),
);

const dirtyTotal = basic.changed.length + basic.untracked.length;
check("porcelain: dirty = changed + untracked", dirtyTotal === 4);

const ren = parsePorcelain("R  new name.ts\0old name.ts\0");
check(
  "porcelain: rename is one dirty entry (destination), orig skipped",
  ren.changed.length === 1 && ren.changed[0] === "new name.ts",
  JSON.stringify(ren.changed),
);

const special = parsePorcelain('?? foo"bar.txt\0 M edit ed.ts\0');
check(
  "porcelain: -z keeps quote and space bytes unescaped",
  special.untracked[0] === 'foo"bar.txt' && special.changed[0] === "edit ed.ts",
  JSON.stringify(special),
);

check("porcelain: empty output", parsePorcelain("").changed.length === 0);

const expanded = parsePorcelain("?? dir/a.txt\0?? dir/b.txt\0");
check(
  "porcelain: -uall untracked files stay file-granular",
  expanded.untracked.length === 2 &&
    expanded.untracked[0] === "dir/a.txt" &&
    expanded.untracked[1] === "dir/b.txt",
  JSON.stringify(expanded.untracked),
);

const copy = parsePorcelain("C  dest.ts\0src.ts\0");
check(
  "porcelain: copy is one dirty entry (destination)",
  copy.changed.length === 1 && copy.changed[0] === "dest.ts",
  JSON.stringify(copy.changed),
);

// --- parseDiffNames ---

check("diff names: empty output", parseDiffNames("").length === 0);
check(
  "diff names: NUL-separated paths, trailing NUL dropped",
  JSON.stringify(parseDiffNames("a.ts\0b.ts\0")) ===
    JSON.stringify(["a.ts", "b.ts"]),
);

// --- zipHashObject ---

check(
  "hash: empty path list is an empty map",
  zipHashObject([], "")?.size === 0,
);
check(
  "hash: pairs stdout lines with paths in order",
  JSON.stringify([...(zipHashObject(["a.ts", "b.ts"], "aaa\nbbb\n") ?? [])]) ===
    JSON.stringify([
      ["a.ts", "aaa"],
      ["b.ts", "bbb"],
    ]),
);
check(
  "hash: line-count mismatch is a failure, not padded",
  zipHashObject(["a.ts", "b.ts"], "aaa\n") === undefined,
);

// --- sessionTouchedDelta ---

const start = new Map([
  ["keep.ts", "h1"],
  ["edit.ts", "h2"],
  ["gone.ts", "h3"],
]);
check(
  "session: pre-dirty unchanged path is not touched",
  sessionTouchedDelta(new Map([["keep.ts", "h1"]]), start, new Map()).length ===
    0,
);
check(
  "session: hash change and new path count",
  JSON.stringify(
    sessionTouchedDelta(
      new Map([
        ["keep.ts", "h1"],
        ["edit.ts", "h2b"],
        ["new.ts", "h4"],
      ]),
      start,
      new Map(),
    ).sort(),
  ) === JSON.stringify(["edit.ts", "new.ts"]),
);
check(
  "session: committed with a different blob counts",
  sessionTouchedDelta(new Map(), start, new Map([["edit.ts", "h2b"]]))[0] ===
    "edit.ts",
);
check(
  "session: committed with the start blob does not count",
  sessionTouchedDelta(new Map(), start, new Map([["keep.ts", "h1"]])).length ===
    0,
);
check(
  "session: deleted path (absent vs start hash) counts",
  sessionTouchedDelta(
    new Map([["gone.ts", ABSENT_HASH]]),
    start,
    new Map(),
  )[0] === "gone.ts",
);
check(
  "session: committed-between-refresh path not in lastDirty counts",
  sessionTouchedDelta(new Map(), start, new Map([["new.ts", "h4"]]))[0] ===
    "new.ts",
);

// --- headMoveIsExternal (attribution-window re-anchor decision) ---
// Accepted blind spot: a forward-only move with few commits (fast-forward
// pull, switch to a descendant branch) is indistinguishable from the
// session's own commits — it stays attributed as internal by design.

check(
  "external: small branch switch detected via ancestry (no merge, 3 commits)",
  headMoveIsExternal({ ancestor: false, merges: 0, commits: 3 }),
);
check(
  "external: diverged rebase/pull detected via ancestry",
  headMoveIsExternal({ ancestor: false, merges: 0, commits: 1 }),
);
check(
  "external: merge commit in an ancestral window",
  headMoveIsExternal({ ancestor: true, merges: 1, commits: 5 }),
);
check(
  "external: oversized ancestral batch (over the commit cap)",
  headMoveIsExternal({
    ancestor: true,
    merges: 0,
    commits: EXTERNAL_MOVE_MAX_COMMITS + 1,
  }),
);
check(
  "internal: few own commits on top of lastHead",
  !headMoveIsExternal({ ancestor: true, merges: 0, commits: 3 }),
);
check(
  "internal: commit cap is inclusive (own fast-forward at the cap)",
  !headMoveIsExternal({
    ancestor: true,
    merges: 0,
    commits: EXTERNAL_MOVE_MAX_COMMITS,
  }),
);
check(
  "internal: no movement (empty window)",
  !headMoveIsExternal({ ancestor: true, merges: 0, commits: 0 }),
);

// --- formatGitSegment ---

check("segment: both counts zero hidden", formatGitSegment(0, 0) === "");
check(
  "segment: committed session files still show when dirty is 0",
  formatGitSegment(0, 3) === "mine 3 · dirty 0",
);
check(
  "segment: both viewpoints always labeled",
  formatGitSegment(3, 3) === "mine 3 · dirty 3" &&
    formatGitSegment(8, 3) === "mine 3 · dirty 8",
);
check(
  "segment: em wraps numbers by viewpoint",
  formatGitSegment(8, 3, (n, which) => `${which[0]}${n}`) ===
    "mine s3 · dirty d8",
);
check(
  "segment: label wraps viewpoint words only",
  formatGitSegment(8, 3, String, (s) => `[${s}]`) === "[mine ]3[ · dirty ]8",
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
