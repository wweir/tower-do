/**
 * tower-do finding exit-mechanism regression (Layer 1/2, pure logic).
 *
 * Bug context: findings were the only record class with NO exit at all —
 * append-only, no budget, no close reason, and the dashboard rendered the 20
 * NEWEST, so the oldest debt was permanently invisible. This file locks the
 * replacement:
 *   1. The budget is charged to every NON-closed finding — a snooze is not a
 *      free way to clear it (otherwise a session could defer 500 rows and the
 *      checkpoint digest would be unbounded again).
 *   2. The rejection names the OLDEST rows by pressure, never the newest.
 *   3. Liveness decides who to route to, never whether a finding is resolved:
 *      a dead owner's `accepted` collapses to `actionable`.
 *   4. Nothing actionable is ever retired by age; only closed rows leave the
 *      default view, after the grace.
 *   5. Legacy finding rows (pre-`owner`) still fold instead of being skipped.
 *
 * Run: bun test/finding-exit.ts
 */
import {
  checkpointDigest,
  deriveFindingState,
  findingBudgetRejection,
  findingPressureOrder,
  findingViewRetired,
  findingCountsFor,
  FINDING_CLOSE_GRACE_MS,
  isFindingClosed,
  latestBoardCheckpoint,
  MAX_FINDING_TITLE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_TASK_SUBJECT_CHARS,
  MAX_TOWER_DO_OPEN_FINDINGS,
  MAX_TOWER_DO_OPEN_TASKS,
  openFindingCount,
  parseActivityLine,
  readPersistedFinding,
  readPersistedMessage,
  retainFindings,
  summarizeFindings,
  textLength,
  TOWER_DO_BOARD_DIGEST_TYPE,
  type TowerBoardView,
  type TowerDoFinding,
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
    console.log(`FAIL  ${label} ${extra ? "— " + extra : ""}`);
  }
}

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const live = new Set(["alice"]);

function finding(over: Partial<TowerDoFinding> = {}): TowerDoFinding {
  return {
    id: over.id ?? `f-${Math.random().toString(36).slice(2, 10)}`,
    kind: over.kind ?? "bug",
    title: over.title ?? "title",
    severity: over.severity ?? "medium",
    status: over.status ?? "open",
    summary: over.summary ?? "summary",
    from: over.from ?? "reporter",
    at: over.at ?? NOW,
    ...over,
  };
}

function main(): void {
  // --- derived state: liveness routes, it never resolves ---
  check(
    "open → actionable",
    deriveFindingState(finding({ status: "open" }), NOW, live) === "actionable",
  );
  check(
    "accepted with a live owner → claimed",
    deriveFindingState(
      finding({ status: "accepted", owner: "alice" }),
      NOW,
      live,
    ) === "claimed",
  );
  check(
    "accepted with a dead owner collapses back to actionable",
    deriveFindingState(
      finding({ status: "accepted", owner: "ghost" }),
      NOW,
      live,
    ) === "actionable",
  );
  check(
    "accepted without an owner is actionable (adoptable)",
    deriveFindingState(finding({ status: "accepted" }), NOW, live) ===
      "actionable",
  );
  check(
    "unexpired snooze → snoozed",
    deriveFindingState(
      finding({ status: "snoozed", snoozeUntil: NOW + DAY }),
      NOW,
      live,
    ) === "snoozed",
  );
  check(
    "expired snooze flows back to actionable",
    deriveFindingState(
      finding({ status: "snoozed", snoozeUntil: NOW - DAY }),
      NOW,
      live,
    ) === "actionable",
  );
  check(
    "done/rejected are closed",
    isFindingClosed(finding({ status: "done" })) &&
      isFindingClosed(finding({ status: "rejected" })) &&
      !isFindingClosed(finding({ status: "open" })),
  );

  // --- view retirement: closed only, and only past the grace ---
  const closedFresh = finding({
    id: "f-fresh",
    status: "done",
    at: NOW - DAY,
  });
  const closedOld = finding({
    id: "f-old",
    status: "rejected",
    at: NOW - FINDING_CLOSE_GRACE_MS - DAY,
  });
  check(
    "closed within grace stays in the default view",
    !findingViewRetired(closedFresh, NOW) &&
      retainFindings([closedFresh, closedOld], NOW).length === 1,
  );
  check(
    "closed past the grace leaves the default view",
    findingViewRetired(closedOld, NOW) &&
      retainFindings([closedFresh, closedOld], NOW)[0].id === "f-fresh",
  );
  check(
    "an action-able finding is never retired by age",
    retainFindings(
      [finding({ at: NOW - 365 * DAY }), finding({ at: NOW - 365 * DAY })],
      NOW,
    ).length === 2,
  );
  const counts = summarizeFindings(
    [
      finding({ status: "open" }),
      finding({ status: "accepted", owner: "alice" }),
      finding({ status: "snoozed", snoozeUntil: NOW + DAY }),
      closedFresh,
      closedOld,
    ],
    NOW,
    live,
  );
  check(
    "summarize counts actionable/claimed/snoozed/closed/retired",
    counts.actionable === 1 &&
      counts.claimed === 1 &&
      counts.snoozed === 1 &&
      counts.closed === 1 &&
      counts.retired === 1,
    JSON.stringify(counts),
  );

  // --- budget: every non-closed row is charged ---
  const snoozed50 = Array.from({ length: MAX_TOWER_DO_OPEN_FINDINGS }, (_, i) =>
    finding({
      id: `f-snooze${i}`,
      status: "snoozed",
      snoozeUntil: NOW + 30 * DAY,
      at: NOW - i * 1000,
    }),
  );
  check(
    "snooze does not clear the budget",
    openFindingCount(snoozed50) === MAX_TOWER_DO_OPEN_FINDINGS &&
      findingBudgetRejection(snoozed50, NOW, live, "repoter") !== undefined,
  );
  check(
    "closing one frees exactly one slot",
    findingBudgetRejection(
      [...snoozed50.slice(0, MAX_TOWER_DO_OPEN_FINDINGS - 1), closedFresh],
      NOW,
      live,
      "reporting-session",
    ) === undefined,
  );
  const open200 = Array.from({ length: 200 }, (_, i) =>
    finding({ id: `f-open${i}`, at: NOW - i * DAY }),
  );
  const rejection = findingBudgetRejection(open200, NOW, live, "repoter");
  check(
    "the budget rejection names the OLDEST rows, not the newest",
    rejection !== undefined &&
      rejection.includes("f-open199") &&
      !rejection.includes("f-open0") &&
      /budget \(50\)/.test(rejection),
    rejection?.slice(0, 120),
  );
  check(
    "the budget rejection carries the batch remedy",
    rejection?.includes("findingIds=") === true,
  );
  // The remedy must be executable when every slot is a snooze: snoozing frees
  // nothing, so offering it would be a dead end (the row count never drops).
  check(
    "the budget remedy is executable (a snooze frees nothing)",
    rejection !== undefined &&
      /close one first/.test(rejection) &&
      !/snooze one first/.test(rejection) &&
      !rejection.includes("status=done|rejected|snoozed"),
    rejection?.split("\n")[0],
  );

  // Close obligation: a live owner holding an overdue claim is blocked until
  // it closes or holds it — but a dead owner never blocks a peer.
  const overdueClaim = finding({
    id: "f-owed",
    status: "accepted",
    owner: "alice",
    at: NOW - FINDING_CLOSE_GRACE_MS - DAY,
  });
  check(
    "an overdue claimed finding blocks its own owner from filing",
    findingBudgetRejection([overdueClaim], NOW, live, "alice")?.includes(
      "f-owed",
    ) === true,
  );
  check(
    "an overdue claimed finding does not block a different reporter",
    findingBudgetRejection([overdueClaim], NOW, live, "bob") === undefined,
  );
  check(
    "a dead owner's overdue claim does not block anyone",
    findingBudgetRejection(
      [{ ...overdueClaim, owner: "ghost" }],
      NOW,
      live,
      "ghost",
    ) === undefined,
  );

  // --- pressure order: oldest overdue first, newest plain actionable last ---
  const order = findingPressureOrder(
    [
      finding({ id: "f-new", at: NOW - 1 * DAY }),
      finding({ id: "f-ancient", at: NOW - 30 * DAY }),
      finding({ id: "f-claimed", status: "accepted", owner: "alice" }),
      finding({ id: "f-gone", status: "accepted", owner: "ghost" }),
    ],
    NOW,
    live,
  ).map((entry) => entry.id);
  check(
    "overdue actionable sorts before fresh/claimed rows",
    order[0] === "f-ancient" && order[1] === "f-gone",
    order.join(","),
  );

  // --- persistence: legacy rows fold, new fields round-trip ---
  const legacy = readPersistedFinding({
    id: "f-legacy",
    kind: "bug",
    title: "t",
    severity: "low",
    status: "open",
    summary: "s",
    from: "old",
    at: 1,
  });
  check(
    "legacy finding rows (no owner/reason) still fold",
    legacy !== undefined && legacy.owner === undefined,
  );
  const rich = readPersistedFinding({
    id: "f-rich",
    kind: "vuln",
    title: "t",
    severity: "high",
    status: "snoozed",
    summary: "s",
    from: "alice",
    at: 2,
    owner: "alice",
    reason: "waiting on release",
    snoozeUntil: 999,
  });
  check(
    "owner/reason/snoozeUntil round-trip through the fold reader",
    rich?.owner === "alice" &&
      rich.reason === "waiting on release" &&
      rich.snoozeUntil === 999 &&
      deriveFindingState(rich, 100, live) === "snoozed",
  );
  check(
    "a foreign status is still rejected",
    readPersistedFinding({
      id: "f-bad",
      kind: "bug",
      title: "t",
      severity: "low",
      status: "nope",
      summary: "s",
      from: "x",
      at: 1,
    }) === undefined,
  );

  // --- Layer 4: the digest is bounded by board history, not by its tip ---
  const openTask = (key: string): TowerDoTask => ({
    key,
    subject: "open subject",
    status: "pending",
    dependsOn: [],
    blockedBy: [],
    updatedAt: NOW,
  });
  const completedTask = (key: string): TowerDoTask => ({
    ...openTask(key),
    status: "completed",
    changedFiles: ["src/long-path-that-would-inflate-the-digest.ts"],
  });
  const digestFor = (extraTasks: TowerDoTask[], extraFindings: TowerDoFinding[]) => {
    const view: TowerBoardView = {
      schemaVersion: 1 as const,
      revision: 5,
      tasks: [openTask("a"), openTask("b"), ...extraTasks],
      messages: [],
      findings: [
        finding({ id: "f-open", status: "open" }),
        ...extraFindings,
      ],
      skipped: 0,
    };
    return JSON.stringify(checkpointDigest(view, NOW, live, "alice"));
  };
  const small = digestFor([], []);
  const huge = digestFor(
    Array.from({ length: 1000 }, (_, i) => completedTask(`done-${String(i)}`)),
    Array.from({ length: 1000 }, (_, i) =>
      finding({
        id: `f-closed-${String(i)}`,
        status: "done",
        at: NOW - 30 * DAY,
        summary: "x".repeat(200),
      }),
    ),
  );
  const smallDigest = JSON.parse(small) as {
    openTasks: unknown[];
    findings: unknown[];
  };
  const hugeDigest = JSON.parse(huge) as {
    openTasks: unknown[];
    findings: unknown[];
  };
  check(
    "the digest's arrays stay bounded regardless of history",
    hugeDigest.openTasks.length === smallDigest.openTasks.length &&
      hugeDigest.findings.length === smallDigest.findings.length &&
      hugeDigest.findings.length === 1,
    `open ${String(hugeDigest.openTasks.length)} / findings ${String(hugeDigest.findings.length)}`,
  );
  check(
    "the digest grows only by the digits of its counts",
    huge.length - small.length < 64,
    `${small.length} vs ${huge.length}`,
  );
  const digestJson = JSON.parse(small) as Record<string, unknown>;
  check(
    "the digest exposes only bounded arrays at the top level",
    Object.keys(digestJson).filter((key) => Array.isArray(digestJson[key])).length ===
      2,
    Object.keys(digestJson).join(","),
  );
  const countsJson = (digestJson.counts ?? {}) as Record<string, unknown>;
  const countsKeySet = Object.keys(countsJson).sort().join(",");
  check(
    "the digest's counts record is a fixed shape with no array field",
    countsKeySet === "findings,tasks,unread" &&
      !JSON.stringify(countsJson).includes("["),
    `${countsKeySet} ${String(JSON.stringify(countsJson).includes("["))}`,
  );

  // The `huge` case above cannot detect a REMOVED cap: completed/closed rows
  // are filtered out BEFORE the slice, so both sides stay at 1-2 rows. These
  // rows survive the writer's filter, so the caps are the only thing bounding
  // them.
  const capped = JSON.parse(
    digestFor(
      Array.from({ length: 60 }, (_, i) => openTask(`open-${String(i)}`)),
      Array.from({ length: 60 }, (_, i) =>
        finding({ id: `f-open-${String(i)}`, status: "open" }),
      ),
    ),
  ) as { openTasks: unknown[]; findings: unknown[] };
  check(
    "the open-task cap actually clamps surviving non-completed rows",
    capped.openTasks.length === MAX_TOWER_DO_OPEN_TASKS,
    String(capped.openTasks.length),
  );
  check(
    "the finding cap actually clamps surviving non-closed rows",
    capped.findings.length === MAX_TOWER_DO_OPEN_FINDINGS,
    String(capped.findings.length),
  );

  // The READ side must reject an over-cap forged digest, not just the writer
  // produce a capped one: a hand-written transcript entry is untrusted input.
  const pristine = JSON.parse(digestFor([], [])) as {
    openTasks: Record<string, unknown>[];
    findings: Record<string, unknown>[];
  };
  const restoresDigest = (data: unknown): boolean =>
    latestBoardCheckpoint([
      { type: "custom", customType: TOWER_DO_BOARD_DIGEST_TYPE, data },
    ]) !== undefined;
  check(
    "a forged digest with 51 open tasks is refused on read",
    !restoresDigest({
      ...pristine,
      openTasks: Array.from({ length: 51 }, (_, i) => ({
        ...pristine.openTasks[0],
        key: `k-${String(i)}`,
      })),
    }),
  );
  check(
    "a forged digest with 51 findings is refused on read",
    !restoresDigest({
      ...pristine,
      findings: Array.from({ length: 51 }, (_, i) => ({
        ...pristine.findings[0],
        id: `f-${String(i)}`,
      })),
    }),
  );

  digestRoundTrip();
  digestFieldBounds();
  nonFiniteTimestamps();

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

/**
 * Digest → view round-trip (the board file is gone, so the ONLY record of the
 * board is what the checkpoint carried). Two shapes must survive it truthfully:
 * a dead owner's claim must not come back as an owned `open` row, and the
 * closed/retired counts must not silently zero out.
 */
/**
 * A digest is read back from a persisted session entry that any writer sharing
 * the customType can forge. Array LENGTH is bounded; the rendered single fields
 * must be too — a newline-injecting key or an oversized subject/title would
 * otherwise materialize an unbounded, injectable view.
 */
function digestFieldBounds(): void {
  const view: TowerBoardView = {
    schemaVersion: 1 as const,
    revision: 3,
    tasks: [
      {
        key: "t-live",
        subject: "live",
        status: "in_progress",
        owner: "alice",
        dependsOn: [],
        blockedBy: [],
        updatedAt: NOW,
      },
    ],
    messages: [],
    findings: [finding({ id: "f-one", status: "accepted", owner: "alice" })],
    skipped: 0,
  };
  const digest = checkpointDigest(view, NOW, live, "alice");
  const restores = (
    mutate: (data: {
      openTasks: Array<Record<string, unknown>>;
      findings: Array<Record<string, unknown>>;
    }) => void,
  ): boolean => {
    const data = JSON.parse(JSON.stringify(digest)) as {
      openTasks: Array<Record<string, unknown>>;
      findings: Array<Record<string, unknown>>;
    };
    mutate(data);
    return (
      latestBoardCheckpoint([
        { type: "custom", customType: TOWER_DO_BOARD_DIGEST_TYPE, data },
      ]) !== undefined
    );
  };
  check(
    "a pristine digest restores through the field bounds",
    restores(() => {}),
  );
  check(
    "a digest row with a newline-injecting key is refused (illegal key)",
    !restores((data) => {
      data.openTasks[0]!.key = "bad\nkey";
    }),
  );
  check(
    "a digest row whose key is not a task key is refused",
    !restores((data) => {
      data.openTasks[0]!.key = "Not A Key";
    }),
  );
  check(
    "a digest row with an oversized subject is refused",
    !restores((data) => {
      data.openTasks[0]!.subject = "s".repeat(MAX_TASK_SUBJECT_CHARS + 1);
    }),
  );
  check(
    "a digest finding with an oversized title is refused",
    !restores((data) => {
      data.findings[0]!.title = "t".repeat(MAX_FINDING_TITLE_CHARS + 1);
    }),
  );
  check(
    "a digest finding with a newline in the owner is refused",
    !restores((data) => {
      data.findings[0]!.owner = "a\nb";
    }),
  );

  // The WRITER must never emit a digest its own READER rejects: the fold does
  // not bound a finding's id/title/owner (a legacy or hand-written row may
  // carry more), so an over-long one would otherwise make the reader discard
  // the ENTIRE checkpoint and a session with a missing board file would
  // silently restore an empty board. Every emitted field is truncated to the
  // bound instead.
  const longView: TowerBoardView = {
    ...view,
    findings: [
      finding({
        // Over-long in EVERY bounded field, or the truncation of one is not
        // actually exercised (a short `id` passed even with the bound removed).
        id: "f-" + "i".repeat(MAX_IDENTITY_CHARS + 40),
        title: "t".repeat(MAX_FINDING_TITLE_CHARS + 40),
        status: "accepted",
        owner: "o".repeat(MAX_IDENTITY_CHARS + 40),
      }),
    ],
  };
  const longDigest = checkpointDigest(longView, NOW, live, "alice");
  const longRow = longDigest.findings[0]!;
  check(
    "the digest writer respects every bound its reader enforces",
    textLength(longRow.title) <= MAX_FINDING_TITLE_CHARS &&
      textLength(longRow.id) <= MAX_IDENTITY_CHARS &&
      (longRow.owner === undefined ||
        textLength(longRow.owner) <= MAX_IDENTITY_CHARS) &&
      latestBoardCheckpoint([
        { type: "custom", customType: TOWER_DO_BOARD_DIGEST_TYPE, data: longDigest },
      ]) !== undefined,
    JSON.stringify({
      title: textLength(longRow.title),
      owner: longRow.owner === undefined ? 0 : textLength(longRow.owner),
      restored:
        latestBoardCheckpoint([
          { type: "custom", customType: TOWER_DO_BOARD_DIGEST_TYPE, data: longDigest },
        ]) !== undefined,
    }),
  );
  // A digest whose own counts disagree with its rows is corrupt: accepting it
  // would restore a task count the writer could never have produced.
  check(
    "a digest whose open count contradicts its byStatus tally is refused",
    !restores((data) => {
      (data as { counts: { tasks: { open: number } } }).counts.tasks.open = 999;
    }),
  );
}

/**
 * A non-finite timestamp (`1e999` → Infinity, or NaN) would permanently defeat
 * every time-based exit — staleness, overdue, message retirement — so the
 * parsers must reject it exactly like any other malformed field.
 */
function nonFiniteTimestamps(): void {
  const message = {
    id: "m",
    to: "all",
    from: "a",
    subject: "s",
    body: "b",
  };
  check(
    "a non-finite message timestamp is rejected",
    readPersistedMessage({ ...message, at: Number.POSITIVE_INFINITY }) ===
      undefined &&
      readPersistedMessage({ ...message, at: Number.NaN }) === undefined,
  );
  check(
    "a non-finite finding timestamp is rejected",
    readPersistedFinding({
      id: "f",
      kind: "bug",
      title: "t",
      severity: "low",
      status: "open",
      summary: "s",
      from: "a",
      at: Number.NaN,
    }) === undefined,
  );
  check(
    "a non-finite activity timestamp is rejected",
    parseActivityLine(
      '{"kind":"task","op":"upsert","key":"k","task":{"subject":"s"},"by":"a","at":1e999}',
    ) === undefined,
  );
}

function digestRoundTrip(): void {
  const view: TowerBoardView = {
    schemaVersion: 1 as const,
    revision: 7,
    tasks: [],
    messages: [],
    findings: [
      // Claimed by a dead owner: derives `actionable` (adoptable), so the
      // digest must not carry the dead claim's owner.
      finding({ id: "f-dead", status: "accepted", owner: "ghost" }),
      // Live claim: owner belongs to the row.
      finding({ id: "f-live", status: "accepted", owner: "alice" }),
      // A snooze whose deadline already passed derives `actionable`; its stale
      // deadline must not ride along.
      finding({
        id: "f-expired-snooze",
        status: "snoozed",
        snoozeUntil: NOW - DAY,
      }),
      // Closed but still INSIDE the grace: counted as `closed` (not retired),
      // and never serialized as a row. Without it, `closed` is 0 everywhere and
      // the carry-vs-re-summarize assertion below cannot tell them apart.
      finding({ id: "f-recent-done", status: "done", at: NOW - DAY }),
      // Closed and past the grace: counted, but never serialized as a row.
      finding({ id: "f-retired", status: "done", at: NOW - 30 * DAY }),
    ],
    skipped: 0,
  };
  const digest = checkpointDigest(view, NOW, live, "alice");
  const restored = latestBoardCheckpoint([
    { type: "custom", customType: TOWER_DO_BOARD_DIGEST_TYPE, data: digest },
  ]);
  const restoredById = new Map(
    (restored?.findings ?? []).map((row) => [row.id, row]),
  );
  const digestById = new Map(digest.findings.map((row) => [row.id, row]));
  check(
    "a dead claim's owner never reaches the digest (writer-side)",
    digestById.get("f-dead")?.owner === undefined &&
      digestById.get("f-dead")?.state === "actionable",
    JSON.stringify(digestById.get("f-dead")),
  );
  check(
    "an expired snooze's deadline never reaches the digest (writer-side)",
    digestById.get("f-expired-snooze")?.snoozeUntil === undefined,
    JSON.stringify(digestById.get("f-expired-snooze")),
  );
  check(
    "a live claim does carry its owner into the digest",
    digestById.get("f-live")?.owner === "alice" &&
      digestById.get("f-live")?.state === "claimed",
    JSON.stringify(digestById.get("f-live")),
  );
  check(
    "a dead claim does not round-trip into an owned open row",
    restored?.incomplete === true &&
      restoredById.get("f-dead")?.status === "open" &&
      restoredById.get("f-dead")?.owner === undefined,
    JSON.stringify(restoredById.get("f-dead")),
  );
  check(
    "a live claim keeps its owner through the round-trip",
    restoredById.get("f-live")?.status === "accepted" &&
      restoredById.get("f-live")?.owner === "alice",
    JSON.stringify(restoredById.get("f-live")),
  );
  check(
    "an expired snooze keeps no stale deadline",
    restoredById.get("f-expired-snooze")?.status === "open" &&
      restoredById.get("f-expired-snooze")?.snoozeUntil === undefined,
    JSON.stringify(restoredById.get("f-expired-snooze")),
  );
  check(
    "the checkpoint's closed count survives (a re-summarize would zero it)",
    restored?.findingCountsAtCheckpoint?.retired === 1 &&
      summarizeFindings(restored?.findings ?? [], NOW, live).retired === 0,
    JSON.stringify({
      carried: restored?.findingCountsAtCheckpoint,
      recomputed: summarizeFindings(restored?.findings ?? [], NOW, live),
    }),
  );
  // The missing-board path rebuilds the digest FROM the restored view, so a
  // re-checkpoint must carry closed/retired through instead of re-summarizing
  // the (closed-row-less) restored rows and persisting zero.
  const reDigest = checkpointDigest(restored!, NOW, live, "alice");
  check(
    "a digest rebuilt from a digest-only view keeps closed/retired",
    reDigest.counts.findings.retired === 1 &&
      reDigest.counts.findings.closed === 1 &&
      summarizeFindings(restored?.findings ?? [], NOW, live).closed === 0,
    JSON.stringify({
      carried: restored?.findingCountsAtCheckpoint,
      rebuilt: reDigest.counts.findings,
      reSummarized: summarizeFindings(restored?.findings ?? [], NOW, live),
    }),
  );
  // Liveness moved on since the checkpoint: the live states must be recomputed
  // (the header may not contradict the rows on the same screen), while only the
  // two unrecomputable fields come from the checkpoint.
  const atCheckpoint = findingCountsFor(restored!, NOW, live);
  const afterOwnerDied = findingCountsFor(restored!, NOW, new Set());
  check(
    "live counts stay fresh while closed/retired come from the checkpoint",
    atCheckpoint.claimed === 1 &&
      atCheckpoint.actionable === 2 &&
      afterOwnerDied.claimed === 0 &&
      afterOwnerDied.actionable === 3 &&
      afterOwnerDied.closed === atCheckpoint.closed &&
      afterOwnerDied.retired === 1,
    JSON.stringify({ atCheckpoint, afterOwnerDied }),
  );
}

main();
