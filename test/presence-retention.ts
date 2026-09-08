/**
 * tower-do presence + message-retention regression — locks the interaction
 * layer added on top of the board:
 *
 *  1. read/ack: messages carry `readBy`; inbox reads append an ack (LWW by
 *     message id), broadcast senders are excluded from "who must read", so
 *     broadcasts can retire.
 *  2. retention / exit: fully-read history beyond the budget is retired from
 *     every view, while unread / partially-read traffic always survives.
 *  3. presence: who-is-around is DERIVED from the activity log (zero writes —
 *     a pure read must never mark the reader as active), and idle owners are
 *     flagged.
 *  4. activity rendering: raw JSON event lines fold into compact human lines.
 *  5. backward compatibility: pre-readBy persisted messages stay valid.
 *  6. session checkpoints: restore takes the latest valid compact snapshot
 *     (getBranch is oldest-first), never an earlier cancelled board.
 *
 * Run: bun test/presence-retention.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TowerBoard } from "../board.ts";
import {
  createEmptyBoard,
  derivePresence,
  formatActivityEntry,
  formatActivityFeed,
  formatPresenceLine,
  isCallerLine,
  isMessageFullyRead,
  knownIdentities,
  latestActivity,
  parseActivityLine,
  retainMessages,
  unreadMessagesToMe,
  latestBoardCheckpoint,
  TOWER_DO_BOARD_TYPE,
  writeBoardSnapshot,
  type TowerBoardView,
  type TowerDoMessage,
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

function msg(
  partial: Partial<TowerDoMessage> & { id: string },
): TowerDoMessage {
  return {
    to: "all",
    from: "nobody",
    subject: "subject",
    body: "body",
    at: Date.now(),
    ...partial,
  };
}

// --- layer 1: pure state semantics ------------------------------------------

async function layer1(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tower-msg-"));
  const file = join(dir, "board.jsonl");
  const board = new TowerBoard(file);

  let view: TowerBoardView = createEmptyBoard();
  const details = writeBoardSnapshot(
    view,
    {
      tasks: [
        {
          key: "t1",
          subject: "task one",
          status: "in_progress",
          owner: "alice",
        },
        {
          key: "t2",
          subject: "task two",
          status: "pending",
          owner: "bob",
        },
      ],
    },
    "tower",
  );
  view = details.view;
  await board.append(details.taskEvents);
  const at = Date.now();

  const broadcast = msg({
    id: "m-aaa",
    to: "all",
    from: "alice",
    subject: "hi all",
    at,
  });
  const addressed = msg({
    id: "m-bbb",
    to: "alice",
    from: "bob",
    subject: "hi alice",
    at,
  });
  await board.append([
    { kind: "message", message: broadcast, by: "alice", at },
  ]);
  await board.append([{ kind: "message", message: addressed, by: "bob", at }]);
  view = await board.fold();

  check(
    "unread for bob sees the broadcast",
    unreadMessagesToMe(view, "bob").length === 1,
  );
  check(
    "unread for alice excludes her own broadcast but sees addressed",
    unreadMessagesToMe(view, "alice").length === 1 &&
      unreadMessagesToMe(view, "alice")[0]?.id === "m-bbb",
  );
  check(
    "messagesToMe still sees own broadcasts (read semantics distinct)",
    // messagesToMe counts everything addressed to you from others; here bob
    // sees the broadcast and alice sees both bob's msg AND her own? no — own
    // broadcast filtered by from===identity in messagesToMe too. alice → all
    // is from alice so filtered; bob → alice shown.
    view.messages.length === 2,
  );

  // Broadcast retirement needs the OTHER owners to read, not the sender.
  check(
    "broadcast not fully read until the other owner acks",
    !isMessageFullyRead(broadcast, view),
  );
  const broadcastReadByBob: TowerDoMessage = {
    ...broadcast,
    readBy: ["bob"],
  };
  check(
    "broadcast fully read once the other owner acks",
    isMessageFullyRead(broadcastReadByBob, view),
  );

  // A later-joining owner (carol) was never part of the broadcast audience
  // and must not keep it alive: with an audience snapshot the broadcast is
  // fully read once the snapshot readers ack, even though carol now owns a
  // task and has never read it.
  const broadcastWithAudience: TowerDoMessage = {
    ...broadcast,
    audience: ["bob"],
  };
  const viewWithCarol: TowerBoardView = {
    ...view,
    tasks: [
      ...view.tasks,
      {
        key: "c",
        subject: "carol task",
        status: "in_progress",
        owner: "carol",
        updatedAt: Date.now(),
        dependsOn: [],
        blockedBy: [],
      },
    ],
  };
  check(
    "audience snapshot ignores owners who joined after the broadcast",
    isMessageFullyRead(
      { ...broadcastWithAudience, readBy: ["bob"] },
      viewWithCarol,
    ),
  );

  // Addressed message fully read when its recipient acks.
  const addressedRead: TowerDoMessage = { ...addressed, readBy: ["alice"] };
  check(
    "addressed message fully read when recipient acks",
    isMessageFullyRead(addressedRead, view),
  );

  // Retention: unread survives the budget, only surplus fully-read retires.
  const now = Date.now();
  const done5 = Array.from({ length: 5 }, (_, i) =>
    msg({
      id: `m-old${i}`,
      to: "alice",
      from: "bob",
      subject: `old ${i}`,
      at: 1000 + i,
      readBy: ["alice"],
    }),
  );
  const unread3 = Array.from({ length: 3 }, (_, i) =>
    msg({
      id: `m-new${i}`,
      to: "alice",
      from: "bob",
      subject: `new ${i}`,
      at: now - i,
    }),
  );
  const retained = retainMessages([...done5, ...unread3], view, 4);
  check(
    "retention keeps unread traffic, retires surplus fully-read only",
    retained.length === 4 &&
      retained.some((m) => m.id === "m-new0") &&
      retained.some((m) => m.id === "m-old4") &&
      !retained.some((m) => m.id === "m-old0"),
    `kept ${retained.map((m) => m.id).join(",")}`,
  );
  check(
    "retention 0 keeps everything (legacy)",
    retainMessages([...done5, ...unread3], view, 0).length === 8,
  );
}

// --- layer 2: activity + presence derivation ---------------------------------

function layer2(): void {
  const now = Date.now();
  const taskEvent = JSON.stringify({
    kind: "task",
    op: "upsert",
    key: "feat-x",
    task: {
      key: "feat-x",
      subject: "land feat x",
      status: "in_progress",
      owner: "alice",
      updatedAt: now - 120_000,
    },
    by: "alice",
    at: now - 120_000,
  });
  const msgEvent = JSON.stringify({
    kind: "message",
    message: {
      id: "m-1",
      to: "bob",
      from: "alice",
      subject: "please review",
      body: "…",
      at: now - 60_000,
    },
    by: "alice",
    at: now - 60_000,
  });
  const badLine = "{not json";

  const e1 = parseActivityLine(taskEvent);
  const e2 = parseActivityLine(msgEvent);
  check(
    "activity parses a task upsert",
    e1 !== undefined && e1.kind === "task" && e1.by === "alice",
  );
  check(
    "activity renders a compact line",
    e1 !== undefined &&
      formatActivityEntry(e1, now).includes("feat-x: land feat x"),
  );
  check(
    "activity parses a message",
    e2 !== undefined &&
      e2.kind === "message" &&
      e2.detail.includes("please review"),
  );
  check(
    "activity tolerates corrupt lines",
    parseActivityLine(badLine) === undefined,
  );
  check("activity empty line skipped", parseActivityLine("  ") === undefined);

  // Presence is derived from events only (a status read must not self-mark).
  // Three distinct owners: alice (active just now), carol (worked 12m ago —
  // past the 10m idle threshold → genuinely idle), dave (owns a task but has
  // NEVER acted → unstarted, NOT idle).
  const idleEvent = JSON.stringify({
    kind: "task",
    op: "upsert",
    key: "stale",
    task: {
      key: "stale",
      subject: "stale owned task",
      status: "in_progress",
      owner: "carol",
      updatedAt: now - 720_000,
    },
    by: "carol",
    at: now - 720_000,
  });
  const e3 = parseActivityLine(idleEvent);
  const entries = [e1, e2, e3].filter(
    (e): e is NonNullable<typeof e1> => e !== undefined,
  );
  const tasks = [
    {
      key: "feat-x",
      subject: "land feat x",
      status: "in_progress" as const,
      owner: "alice",
      updatedAt: now,
    },
    {
      key: "stale",
      subject: "stale owned task",
      status: "in_progress" as const,
      owner: "carol",
      updatedAt: now - 720_000,
    },
    {
      key: "fresh",
      subject: "freshly assigned task",
      status: "pending" as const,
      owner: "dave",
      updatedAt: now - 3600_000,
    },
  ];
  const presence = derivePresence(entries, tasks as never, now);
  const alice = presence.find((p) => p.identity === "alice");
  const carol = presence.find((p) => p.identity === "carol");
  const dave = presence.find((p) => p.identity === "dave");
  check(
    "presence derives active owner from activity",
    alice !== undefined && alice.idle === false && alice.unstarted === false,
  );
  check(
    "presence flags owner quiet past the idle threshold as idle",
    carol !== undefined &&
      carol.idle === true &&
      carol.unstarted === false &&
      carol.ownerOf.includes("stale"),
    JSON.stringify(presence.map((p) => formatPresenceLine(p, now))),
  );
  check(
    "presence marks never-active owner as unstarted, not idle",
    dave !== undefined &&
      dave.idle === false &&
      dave.unstarted === true &&
      formatPresenceLine(dave, now).includes("(not started)"),
  );
  check(
    "presence sorts most-recent first",
    presence[0]?.identity === "alice" || presence[0]?.identity === "carol",
  );

  // --- feed rendering: session-break separators + latest-write summary ---
  // All times are newest-first (the status tool reverses the raw tail). A
  // feed whose entries are all within one sitting must stay contiguous; a
  // gap > SESSION_BREAK_GAP_MS between consecutive entries inserts one
  // separator line.
  const burst = [
    {
      kind: "task" as const,
      by: "alice",
      at: now - 30_000,
      glyph: "✓",
      detail: "y: y",
    },
    {
      kind: "task" as const,
      by: "alice",
      at: now - 60_000,
      glyph: "◐",
      detail: "x: x",
    },
  ];
  const olderSitting = [
    {
      kind: "task" as const,
      by: "bob",
      at: now - 2 * 60 * 60_000,
      glyph: "◐",
      detail: "z: z",
    },
    {
      kind: "task" as const,
      by: "bob",
      at: now - (2 * 60 * 60_000 + 61_000),
      glyph: "○",
      detail: "w: w",
    },
  ];
  const contiguous = formatActivityFeed([...burst], now);
  check(
    "feed keeps a same-sitting burst contiguous (no separator)",
    contiguous.length === 2 &&
      !contiguous.some((l) => l.includes("session break")),
    contiguous.join("\n"),
  );
  const breakFeed = formatActivityFeed([...burst, ...olderSitting], now);
  const breakIdx = breakFeed.findIndex((l) =>
    l.includes("── session break ──"),
  );
  const bobIdx = breakFeed.findIndex((l) => l.startsWith("- bob"));
  check(
    "feed inserts one session-break across a 30m+ gap",
    breakFeed.length === 5 &&
      breakFeed.filter((l) => l.includes("── session break ──")).length === 1 &&
      breakIdx !== -1 &&
      bobIdx !== -1 &&
      breakIdx < bobIdx,
    breakFeed.join("\n"),
  );
  // A separate sitting that itself stays under the gap threshold must not
  // sprout a second separator.
  const twoBreaks = formatActivityFeed(
    [
      ...burst,
      ...olderSitting,
      {
        kind: "task" as const,
        by: "bob",
        at: now - (2 * 60 * 60_000 + 61_000) - 30_000,
        glyph: "✓",
        detail: "v: v",
      },
    ],
    now,
  );
  check(
    "no extra separator inside a sitting already past the first gap",
    twoBreaks.filter((l) => l.includes("── session break ──")).length === 1,
    twoBreaks.join("\n"),
  );
  const latest = latestActivity([...burst, ...olderSitting]);
  check(
    "latestActivity returns the newest entry",
    latest !== undefined && latest.by === "alice",
  );
  check(
    "latestActivity empty feed is undefined",
    latestActivity([]) === undefined,
  );
}

// --- layer 3: persistence LWW + backward compatibility ------------------------

async function layer3(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tower-lww-"));
  const file = join(dir, "board.jsonl");
  const board = new TowerBoard(file);

  // Old-format message (no readBy) must fold fine and stay unread.
  const legacyRaw = msg({
    id: "m-legacy",
    to: "bob",
    from: "alice",
    subject: "old",
  });
  const legacy = legacyRaw as unknown as Record<string, unknown>;
  delete legacy.readBy;
  await board.append([
    {
      kind: "message",
      message: legacy as unknown as TowerDoMessage,
      by: "alice",
      at: Date.now(),
    },
  ]);
  let view = await board.fold();
  check(
    "legacy message without readBy folds as unread",
    view.messages.length === 1 &&
      !(view.messages[0]?.readBy ?? []).includes("bob") &&
      unreadMessagesToMe(view, "bob").length === 1,
  );

  // Re-emit the same id with readBy (an ack) → LWW replaces, not duplicates.
  const acked = { ...legacy, readBy: ["bob"] };
  await board.append([
    { kind: "message", message: acked, by: "bob", at: Date.now() },
  ]);
  view = await board.fold();
  check(
    "ack re-emit LWW-replaces by id (no duplicate rows)",
    view.messages.length === 1 && view.messages[0]?.readBy?.includes("bob"),
  );
  check(
    "ack turns a message fully read",
    view.messages[0] !== undefined &&
      (isMessageFullyRead(view.messages[0], view) ?? false),
  );
}

// --- layer 5: caller-line highlight matching ---------------------------------
// The status renderer bolds lines that describe the caller's own session.
// Matching must be token-exact: a caller named "alice" must NOT highlight
// lines about "alice-2" (suffix collision) and vice versa (prefix collision).
function layer5(): void {
  const header = "TowerDo shared board — identity alice, revision 4";
  const headerOther = "TowerDo shared board — identity alice-2, revision 4";
  const ownPresence = "- alice (me) — last seen 5m ago";
  const otherPresence = "- alice-2 — last seen 5m ago";
  const ownTask = "- ◐ key: subject @alice (me)";
  const otherTask = "- ◐ key: subject @alice-2 (me)";
  const msgs = "## Messages for alice (1; 0 unread)";
  const msgsOther = "## Messages for alice-2 (1; 0 unread)";

  check("caller header matches", isCallerLine(header, "alice"));
  check(
    "caller header does not match another identity's suffix",
    !isCallerLine(headerOther, "alice"),
  );
  check(
    "suffix caller matches its own full identity",
    isCallerLine(headerOther, "alice-2"),
  );
  check("caller presence line matches", isCallerLine(ownPresence, "alice"));
  check(
    "caller presence does not match @owner suffix collision",
    !isCallerLine(otherPresence, "alice"),
  );
  check("caller task owner matches", isCallerLine(ownTask, "alice"));
  check(
    "caller owner does not match another owner's suffix",
    !isCallerLine(otherTask, "alice"),
  );
  check(
    "suffix owner matches its own full identity",
    isCallerLine(otherTask, "alice-2"),
  );
  check("caller messages section matches", isCallerLine(msgs, "alice"));
  check(
    "caller messages does not match suffix collision",
    !isCallerLine(msgsOther, "alice"),
  );
  check(
    "unrelated line never matches",
    !isCallerLine("- ○ other: unrelated subject @bob", "alice") &&
      !isCallerLine("(no tasks match the filter)", "alice"),
  );
  check("empty caller never matches", !isCallerLine(header, ""));
  // Regex metacharacters in identities are matched literally.
  const dotted = "- ◐ key: subject @a.b (me)";
  check("regex metachars escaped", isCallerLine(dotted, "a.b"));

  // A subject that merely MENTIONS the caller must not highlight a line
  // owned by someone else — the owner fragment is anchored to the renderer's
  // ` @<owner> (me)` syntax, not a bare @mention.
  const subjectMention = "- ◐ key: ask @alice to review @bob";
  check(
    "subject mention of caller is not a caller line",
    !isCallerLine(subjectMention, "alice"),
  );
  const mentionPlusOwned = "- ◐ key: ask @alice to review @bob (me)";
  check(
    "owner fragment still matches its real owner",
    isCallerLine(mentionPlusOwned, "bob") &&
      !isCallerLine(mentionPlusOwned, "alice"),
  );
  // Unowned tasks have no renderer-owned `@owner (me)` suffix, so a subject
  // that itself ends with that token currently matches (lookahead `$`).
  // Known limitation — not closed without structured line marks.
  check(
    "unowned subject ending with @caller (me) currently matches",
    isCallerLine("- ◐ k: ask @alice (me)", "alice"),
  );

  // Task lines where the owner fragment is followed by each renderer suffix:
  // deps ( ←), scope/files/blocked ( [), a reason ( —), or the line end.
  const ownDep = "- ◐ key: subject @alice (me) ← z, w";
  const ownScope = "- ◐ key: subject @alice (me) [scope: z.ts]";
  const ownFiles = "- ✓ key: subject @alice (me) [files: z.ts]";
  const ownReason = "- ✗ key: subject @alice (me) — waiting for deps: z";
  check(
    "owner fragment before deps matches",
    isCallerLine(ownDep, "alice") && !isCallerLine(ownDep, "bob"),
  );
  check(
    "owner fragment before scope matches",
    isCallerLine(ownScope, "alice") && !isCallerLine(ownScope, "bob"),
  );
  check(
    "owner fragment before changed-files matches",
    isCallerLine(ownFiles, "alice") && !isCallerLine(ownFiles, "bob"),
  );
  check(
    "owner fragment before a reason matches",
    isCallerLine(ownReason, "alice") && !isCallerLine(ownReason, "bob"),
  );

  // Activity feed entries: own byline matches, others' do not, and a detail
  // that merely mentions `@caller (me)` never masquerades as a task line.
  check(
    "caller activity feed line matches",
    isCallerLine("- alice · just now · ◐ key: subject", "alice"),
  );
  check(
    "other's activity feed line does not match",
    !isCallerLine("- bob · just now · ◐ key: subject", "alice"),
  );
  check(
    "mention inside another session's activity detail does not match",
    !isCallerLine("- bob · just now · ◐ key: subject @alice (me)", "alice"),
  );

  // A message body quoting the header format is not the header itself.
  check(
    "header format quoted in a message body does not match",
    !isCallerLine(
      "- [m1] [UNREAD] bob → me: subj — body identity alice, revision 9",
      "alice",
    ),
  );
}

// --- layer 4: orphan / audience retirement semantics -------------------------
// Two ways a message can become unreadable forever; both must retire instead
// of pinning the retention budget:
//  P1: a broadcast whose audience (owners at send time) has all left the
//      board — fold back-fills the audience snapshot for pre-audience logs so
//      a LATER-joining owner cannot keep it alive.
//  P2: an addressed message whose recipient left the board — nobody can ever
//      read it, so it counts as fully read.

async function layer4(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tower-retire-"));
  const file = join(dir, "board.jsonl");
  const board = new TowerBoard(file);
  const now = Date.now();

  // --- P2: orphan addressed message (recipient leaves the board) ---
  let view: TowerBoardView = createEmptyBoard();
  let details = writeBoardSnapshot(
    view,
    {
      tasks: [
        { key: "a", subject: "A", status: "in_progress", owner: "alice" },
        { key: "b", subject: "B", status: "in_progress", owner: "bob" },
      ],
    },
    "tower",
  );
  await board.append(details.taskEvents);
  const toBob = msg({
    id: "m-to-bob",
    to: "bob",
    from: "carol",
    subject: "please review",
    at: now,
  });
  await board.append([
    { kind: "message", message: toBob, by: "carol", at: now },
  ]);

  // Board rebuilt with entirely new owners: bob is gone, so m-to-bob is an
  // orphan — no current identity can ever read it.
  view = await board.fold();
  details = writeBoardSnapshot(
    view,
    {
      tasks: [
        { key: "x", subject: "X", status: "in_progress", owner: "dave" },
        { key: "y", subject: "Y", status: "in_progress", owner: "eve" },
      ],
    },
    "tower",
  );
  await board.append(details.taskEvents);
  view = await board.fold();
  const orphan = view.messages.find((m) => m.id === "m-to-bob");
  check(
    "orphan addressed message (recipient gone) counts as fully read",
    orphan !== undefined && isMessageFullyRead(orphan, view),
  );
  // Retention budget 1 with a live unread message competing for the slot:
  // only the orphan is fully-read, so the budget must retire the orphan and
  // keep the unread one. budget 0 is legacy keep-everything and would make
  // this trivially pass — the survivor check is what catches a regression.
  const liveUnread = msg({
    id: "m-live-keep",
    to: "dave",
    from: "eve",
    subject: "still waiting",
    at: now + 1,
  });
  const budgeted = retainMessages([orphan!, liveUnread], view, 1);
  check(
    "orphan retires under a selective budget, unread survives",
    budgeted.length === 1 && budgeted[0]?.id === "m-live-keep",
    `kept ${budgeted.map((m) => m.id).join(",")}`,
  );
  check(
    "live addressed message still waits for recipient ack",
    !isMessageFullyRead(
      msg({ id: "m-live", to: "dave", from: "eve", subject: "hi", at: now }),
      view,
    ) &&
      isMessageFullyRead(
        msg({
          id: "m-live2",
          to: "dave",
          from: "eve",
          subject: "hi",
          at: now,
          readBy: ["dave"],
        }),
        view,
      ),
  );

  // --- P1: pre-audience broadcast; owners change completely afterwards ---
  const dir2 = mkdtempSync(join(tmpdir(), "tower-aud-"));
  const board2 = new TowerBoard(join(dir2, "board.jsonl"));
  let view2: TowerBoardView = createEmptyBoard();
  const d2 = writeBoardSnapshot(
    view2,
    {
      tasks: [
        { key: "a", subject: "A", status: "in_progress", owner: "alice" },
      ],
    },
    "tower",
  );
  await board2.append(d2.taskEvents);
  // Pre-audience broadcast (no audience field) from alice while she is the
  // only owner.
  const oldBcRaw = msg({
    id: "m-oldbc",
    to: "all",
    from: "alice",
    subject: "old sync",
    at: now,
  }) as unknown as Record<string, unknown>;
  delete oldBcRaw.audience;
  await board2.append([
    {
      kind: "message",
      message: oldBcRaw as unknown as TowerDoMessage,
      by: "alice",
      at: now,
    },
  ]);
  // Board rebuilt under bob/carol — alice is gone. Fold must back-fill
  // audience from the owners at send time (alice only → empty after removing
  // the sender), so the new owners cannot pin it.
  view2 = await board2.fold();
  const d2b = writeBoardSnapshot(
    view2,
    {
      tasks: [
        { key: "x", subject: "X", status: "in_progress", owner: "bob" },
        { key: "y", subject: "Y", status: "pending", owner: "carol" },
      ],
    },
    "tower",
  );
  await board2.append(d2b.taskEvents);
  view2 = await board2.fold();
  const oldBc = view2.messages.find((m) => m.id === "m-oldbc");
  check(
    "fold back-fills audience for pre-audience broadcast",
    oldBc !== undefined &&
      Array.isArray(oldBc.audience) &&
      !oldBc.audience.includes("bob") &&
      !oldBc.audience.includes("carol"),
    oldBc?.audience ? `audience=${oldBc.audience.join(",")}` : "missing",
  );
  check(
    "back-filled broadcast is fully read once send-time owners acked",
    oldBc !== undefined && isMessageFullyRead(oldBc, view2),
  );

  // --- P3: owner transfer (upsert swap, no remove) must not leak the old
  // owner into the audience of a later broadcast that needs back-filling ---
  const dir3 = mkdtempSync(join(tmpdir(), "tower-xfer-"));
  const board3 = new TowerBoard(join(dir3, "board.jsonl"));
  let view3: TowerBoardView = createEmptyBoard();
  let d3 = writeBoardSnapshot(
    view3,
    {
      tasks: [
        { key: "x", subject: "X", status: "in_progress", owner: "alice" },
      ],
    },
    "tower",
  );
  await board3.append(d3.taskEvents);
  // tower transfers x alice → bob (upsert swap, no remove event)
  view3 = await board3.fold();
  d3 = writeBoardSnapshot(
    view3,
    {
      tasks: [{ key: "x", subject: "X", status: "in_progress", owner: "bob" }],
    },
    "tower",
  );
  await board3.append(d3.taskEvents);
  // Broadcast without audience from bob (only owner after transfer)
  view3 = await board3.fold();
  const xferBcRaw = msg({
    id: "m-xfer",
    to: "all",
    from: "bob",
    subject: "sync",
    at: now,
  }) as unknown as Record<string, unknown>;
  delete xferBcRaw.audience;
  await board3.append([
    {
      kind: "message",
      message: xferBcRaw as unknown as TowerDoMessage,
      by: "bob",
      at: now,
    },
  ]);
  view3 = await board3.fold();
  const xferBc = view3.messages.find((m) => m.id === "m-xfer");
  check(
    "owner transfer does not leak the old owner into audience back-fill",
    xferBc !== undefined &&
      Array.isArray(xferBc.audience) &&
      !xferBc.audience.includes("alice"),
    xferBc?.audience ? `audience=${xferBc.audience.join(",")}` : "missing",
  );

  // --- P4: orphaned broadcast (audience members all left the board) ---
  const dir4 = mkdtempSync(join(tmpdir(), "tower-obc-"));
  const board4 = new TowerBoard(join(dir4, "board.jsonl"));
  let view4: TowerBoardView = createEmptyBoard();
  const d4 = writeBoardSnapshot(
    view4,
    {
      tasks: [
        { key: "a", subject: "A", status: "in_progress", owner: "alice" },
        { key: "b", subject: "B", status: "in_progress", owner: "bob" },
      ],
    },
    "tower",
  );
  await board4.append(d4.taskEvents);
  // Broadcast with audience [bob] (alice sends; bob is the pending reader)
  await board4.append([
    {
      kind: "message",
      message: msg({
        id: "m-obs",
        to: "all",
        from: "alice",
        subject: "round done",
        at: now,
        audience: ["bob"],
      }),
      by: "alice",
      at: now,
    },
  ]);
  // bob never reads; board rebuilt under carol/dave — bob (audience) is gone
  view4 = await board4.fold();
  const d4b = writeBoardSnapshot(
    view4,
    {
      tasks: [
        { key: "c", subject: "C", status: "in_progress", owner: "carol" },
        { key: "d", subject: "D", status: "in_progress", owner: "dave" },
      ],
    },
    "tower",
  );
  await board4.append(d4b.taskEvents);
  view4 = await board4.fold();
  const orphanBc = view4.messages.find((m) => m.id === "m-obs");
  check(
    "orphaned broadcast (audience members all gone) counts as fully read",
    orphanBc !== undefined && isMessageFullyRead(orphanBc, view4),
  );
  // Live audience member still pins the broadcast until they read
  const dir5 = mkdtempSync(join(tmpdir(), "tower-lbc-"));
  const board5 = new TowerBoard(join(dir5, "board.jsonl"));
  let view5: TowerBoardView = createEmptyBoard();
  const d5 = writeBoardSnapshot(
    view5,
    {
      tasks: [
        { key: "a", subject: "A", status: "in_progress", owner: "alice" },
        { key: "b", subject: "B", status: "in_progress", owner: "bob" },
      ],
    },
    "tower",
  );
  await board5.append(d5.taskEvents);
  await board5.append([
    {
      kind: "message",
      message: msg({
        id: "m-live-bc",
        to: "all",
        from: "alice",
        subject: "sync",
        at: now,
        audience: ["bob"],
      }),
      by: "alice",
      at: now,
    },
  ]);
  view5 = await board5.fold();
  const liveBc = view5.messages.find((m) => m.id === "m-live-bc");
  check(
    "live audience member pins the broadcast until they read",
    liveBc !== undefined && !isMessageFullyRead(liveBc, view5),
  );
}

// --- layer 7: knownIdentities (tower_do_talk reachable recipients) ----------
// tower_do_talk send must reach current owners PLUS identities with recent
// board activity: a peer whose tasks are all completed is no longer an owner
// but exactly who hand-off coordination needs to reach.
function layer7(): void {
  const view = {
    ...createEmptyBoard(),
    tasks: [
      {
        key: "a",
        subject: "a",
        status: "in_progress" as const,
        owner: "alice",
        updatedAt: 0,
      },
      {
        key: "b",
        subject: "b",
        status: "completed" as const,
        owner: "bob",
        updatedAt: 0,
      },
    ],
  } as TowerBoardView;
  const entries: ActivityEntry[] = [
    {
      kind: "task",
      by: "carol",
      at: 10,
      glyph: "◐",
      detail: "c: worked earlier, owns nothing now",
    },
    { kind: "task", by: "alice", at: 11, glyph: "◐", detail: "a: updated" },
  ];
  const known = knownIdentities(view, entries);
  check(
    "known includes current owners (even completed-task owners)",
    known.has("alice") && known.has("bob"),
  );
  check(
    "known includes recent-activity identity (delivered peer)",
    known.has("carol"),
  );
  check("known excludes strangers", !known.has("stranger"));
  check(
    "known excludes the reserved orchestrator identity",
    !known.has("tower"),
  );
  const empty = knownIdentities(createEmptyBoard(), entries);
  check(
    "empty board falls back to activity bylines only",
    empty.has("carol") && empty.has("alice") && !empty.has("bob"),
  );
}

// --- layer 6: session-checkpoint replay (oldest-first branch) ---------------
// Pi getBranch() is root-to-leaf. Restore must take the LAST valid custom
// board snapshot, otherwise a later compact's cancelled todos come back.
function layer6(): void {
  const board = (key: string, subject: string): TowerBoardView =>
    writeBoardSnapshot(
      createEmptyBoard(),
      {
        tasks: [{ key, subject, status: "in_progress" }],
      },
      "alice",
    ).view;
  const cancelled = board("old", "cancelled work");
  const current = board("new", "current work");
  const picked = latestBoardCheckpoint([
    { type: "custom", customType: TOWER_DO_BOARD_TYPE, data: cancelled },
    { type: "message" },
    {
      type: "custom",
      customType: TOWER_DO_BOARD_TYPE,
      data: { schemaVersion: 1 },
    },
    { type: "custom", customType: TOWER_DO_BOARD_TYPE, data: current },
  ]);
  check(
    "latest valid checkpoint wins over older and malformed",
    picked?.tasks.length === 1 && picked.tasks[0]?.key === "new",
  );
  check(
    "empty branch has no checkpoint",
    latestBoardCheckpoint([]) === undefined,
  );
  check(
    "custom_message steer payload is not a checkpoint",
    latestBoardCheckpoint([
      {
        type: "custom_message",
        customType: TOWER_DO_BOARD_TYPE,
        data: cancelled,
      },
    ]) === undefined,
  );
}

async function main(): Promise<void> {
  await layer1();
  layer2();
  await layer3();
  await layer4();
  layer5();
  layer6();
  layer7();
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
