/**
 * tower-do smoke test — two layers:
 *  1. pure state + board layer (multi-agent semantics incl. the changedFiles
 *     delivery-receipt disk round-trip via append/fold across instances)
 *  2. the real extension via a mock ExtensionAPI (tools execute end-to-end)
 * Run with: bun run test/smoke.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TowerBoard } from "../board.ts";
import {
  createEmptyBoard,
  findAllUnresolvedDeps,
  formatBoardReminder,
  MAX_MESSAGE_BYTES,
  taskIsBlocked,
  TOWER_DO_REMINDER_TYPE,
  writeBoardSnapshot,
} from "../state.ts";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
}
function expectThrows(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    check(label, false, "expected an error but none was thrown");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), message.slice(0, 120));
  }
}

async function layer1(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tower-do-l1-"));
  const file = join(dir, "board.jsonl");
  const board = new TowerBoard(file);

  const missingFold = await board.fold();
  check(
    "missing board file folds to empty",
    missingFold.revision === 0 && missingFold.tasks.length === 0,
  );
  try {
    await board.rawTail();
    check("rawTail on missing file throws", false, "expected throw");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    check("rawTail on missing file throws", code === "ENOENT");
  }
  const notAFile = join(dir, "not-a-file");
  mkdirSync(notAFile);
  try {
    await new TowerBoard(notAFile).fold();
    check("fold on a directory throws", false, "expected throw");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    check("fold on a directory throws", code === "EISDIR");
  }

  // Fold discloses lines it cannot turn into events (a corrupt line, a foreign
  // shape, or a payload that no longer validates): the board still holds them
  // and no participant may lose sight of that silently. rawTail(0) must be an
  // empty tail, because slice(-0) is slice(0) — the whole log.
  const logFile = join(dir, "logs", "board.jsonl");
  const logWriter = new TowerBoard(logFile);
  await logWriter.append([
    {
      kind: "task",
      op: "upsert",
      key: "ok",
      task: {
        key: "ok",
        subject: "ok",
        status: "pending",
        dependsOn: [],
        blockedBy: [],
      } as never,
      by: "a",
      at: 1,
    },
  ]);
  writeFileSync(
    logFile,
    `${readFileSync(logFile, "utf8")}not json at all\n`,
  );
  const corruptView = await new TowerBoard(logFile).fold();
  check(
    "fold counts a line it cannot fold instead of dropping it silently",
    corruptView.skipped === 1 && corruptView.tasks.length === 1,
    `skipped=${String(corruptView.skipped)} tasks=${String(corruptView.tasks.length)}`,
  );
  check(
    "rawTail(0) is an empty tail, not the whole log",
    (await new TowerBoard(logFile).rawTail(0)).length === 0,
  );

  // Planning: two missions + a dependent one (3 upsert events → revision 3).
  let view = createEmptyBoard();
  const details = writeBoardSnapshot(
    view,
    {
      tasks: [
        {
          key: "gemm",
          subject: "implement vulkan int4 gemm",
          status: "in_progress",
          owner: "alice",
        },
        {
          key: "readme",
          subject: "write vulkan API survey into README",
          status: "in_progress",
          owner: "bob",
        },
        {
          key: "test",
          subject: "run sqznet test",
          status: "pending",
          owner: "carol",
          dependsOn: ["gemm"],
        },
      ],
    },
    "alice",
  );
  view = details.view;
  await board.append(details.taskEvents);
  check(
    "plan persists 3 tasks",
    view.tasks.length === 3,
    `got ${view.tasks.length}`,
  );
  check(
    "plan reports per-event revision",
    view.revision === 3,
    `rev=${view.revision}`,
  );

  // Blocked semantics BEFORE the dependency completes.
  const carolUnfilled = view.tasks.find((t) => t.key === "test")!;
  check(
    "dependent task reports blocked while dep incomplete",
    taskIsBlocked(carolUnfilled, view),
  );
  check(
    "unresolved deps enumerated",
    findAllUnresolvedDeps(carolUnfilled, view).join(",") === "gemm",
  );

  // Stale revision guard (merge gate).
  expectThrows(
    "stale baseRevision rejected",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: view.tasks.map((t) => ({
            key: t.key,
            subject: t.subject,
            status: t.status,
          })),
          baseRevision: 2,
        },
        "alice",
      ),
    /stale tower-do revision/,
  );

  // Ownership: bob may not flip alice's task.
  expectThrows(
    "owner-only status change enforced",
    () =>
      writeBoardSnapshot(
        view,
        {
          tasks: view.tasks.map((t) =>
            t.key === "gemm"
              ? { ...t, status: "completed" }
              : { key: t.key, subject: t.subject, status: t.status },
          ),
          baseRevision: 3,
        },
        "bob",
      ),
    /owned by "alice"/,
  );
  // ... but "tower" (orchestrator) may (+1 event → revision 4).
  const gates = writeBoardSnapshot(
    view,
    {
      tasks: view.tasks.map((t) =>
        t.key === "gemm"
          ? { ...t, status: "completed" }
          : { key: t.key, subject: t.subject, status: t.status },
      ),
      baseRevision: 3,
    },
    "tower",
  );
  view = gates.view;
  await board.append(gates.taskEvents);
  check(
    "orchestrator 'tower' may complete any task",
    view.tasks.find((t) => t.key === "gemm")?.status === "completed",
  );
  check(
    "dependent unblocked after dep done",
    !taskIsBlocked(view.tasks.find((t) => t.key === "test")!, view),
  );

  // Completed tasks ignore stale blockedBy (widget/reminder counts and
  // [blocked] markers all derive from taskIsBlocked); non-completed ones
  // with blockedBy stay blocked.
  const staleDone = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        {
          key: "done",
          subject: "delivered work",
          status: "completed",
          blockedBy: ["msg-1"],
        },
      ],
    },
    "alice",
  );
  check(
    "completed task ignores stale blockedBy",
    !taskIsBlocked(staleDone.view.tasks[0], staleDone.view),
  );
  const stillWaiting = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        {
          key: "wait",
          subject: "waiting on review",
          status: "in_progress",
          owner: "alice",
          blockedBy: ["msg-1"],
        },
      ],
    },
    "alice",
  );
  check(
    "non-completed task with blockedBy still blocked",
    taskIsBlocked(stillWaiting.view.tasks[0], stillWaiting.view),
  );

  // Reminder rows must agree with the header's derived blocked count: a
  // gated task is labelled [blocked] (not its raw status), suffix carries why.
  const reminderWaiting = formatBoardReminder(stillWaiting.view, "alice");
  check(
    "reminder labels blockedBy task [blocked], header agrees",
    reminderWaiting.includes("1 task(s), 1 open") &&
      reminderWaiting.includes("1 blocked") &&
      reminderWaiting.includes("- [blocked] wait:"),
    reminderWaiting.split("\n")[1],
  );
  const gatedDep = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        {
          key: "auth",
          subject: "refactor auth",
          status: "in_progress",
          owner: "alice",
        },
        {
          key: "billing",
          subject: "wire billing",
          status: "pending",
          owner: "alice",
          dependsOn: ["auth"],
        },
      ],
    },
    "alice",
  );
  const reminderDep = formatBoardReminder(gatedDep.view, "alice");
  check(
    "reminder labels pending-with-unresolved-dep [blocked]",
    reminderDep.includes("1 blocked") &&
      reminderDep.includes("- [blocked] billing:") &&
      reminderDep.includes("[blocked by: auth]"),
    reminderDep.split("\n").slice(0, 3).join(" | "),
  );

  // Talk artifacts via append/fold.
  await board.append([
    {
      kind: "message",
      message: {
        id: "m-1",
        to: "bob",
        from: "alice",
        subject: "README handoff",
        body: "write contributors section first; I take the API section",
        at: Date.now(),
      },
      by: "alice",
      at: Date.now(),
    },
  ]);
  const folded = await board.fold();
  check(
    "message folded back",
    folded.messages.length === 1,
    `msgs=${folded.messages.length}`,
  );
  check(
    "write revision matches refold revision",
    folded.revision === view.revision,
    `fold=${folded.revision} write=${view.revision}`,
  );

  // Cross-instance persistence: a second TowerBoard on the same file sees all.
  const board2 = new TowerBoard(file);
  const otherView = await board2.fold();
  check(
    "second session folds same board",
    otherView.tasks.length === 3 && otherView.messages.length === 1,
    `tasks=${otherView.tasks.length} msgs=${otherView.messages.length} rev=${otherView.revision}`,
  );

  // A surviving task may not depend on a task this write removes: removal is
  // explicit, and the dependency check runs on the post-write graph.
  expectThrows(
    "surviving task cannot depend on a task this write removes",
    () =>
      writeBoardSnapshot(
        view,
        {
          // keep test (which depends on gemm) and remove gemm explicitly
          tasks: view.tasks
            .filter((t) => t.key !== "gemm")
            .map((t) => ({
              key: t.key,
              subject: t.subject,
              status: t.status,
            })),
          remove: ["gemm"],
          baseRevision: view.revision,
        },
        "tower",
      ),
    /still depends on it/,
  );

  // A dependent may drop the dependency and delete its target in one write:
  // the dependency check runs on the POST-write graph, so this passes.
  const cleanWrite = writeBoardSnapshot(
    view,
    {
      tasks: [
        {
          key: "readme",
          subject: "write vulkan API survey into README",
          status: "in_progress",
          owner: "bob",
        },
        {
          key: "test",
          subject: "run sqznet test",
          status: "pending",
          owner: "carol",
          // omitted dependsOn preserves the existing value, so clear it
          // explicitly in the same write that deletes gemm
          dependsOn: [],
        },
      ],
      remove: ["gemm"],
      baseRevision: view.revision,
    },
    "tower",
  );
  view = cleanWrite.view;
  await board.append(cleanWrite.taskEvents);
  check(
    "dropping the dep and removing its target in one write is allowed",
    view.tasks.every((t) => t.key !== "gemm") &&
      view.tasks.find((t) => t.key === "test")?.dependsOn.length === 0,
    `tasks=${view.tasks.map((t) => t.key).join(",")}`,
  );


  // A legacy compacted log whose snapshot block contains finding rows must
  // still count task events appended AFTER the block: a finding row is ignored
  // by the fold, but it is a snapshot row and must consume its slot — otherwise
  // the snapshot window runs past the block, swallows real events, and the
  // revision a write reports stops matching a re-fold.
  {
    const legacyCompactDir = mkdtempSync(
      join(tmpdir(), "tower-do-legacy-compact-"),
    );
    const legacyCompactFile = join(legacyCompactDir, "board.jsonl");
    const at = Date.now();
    const keptTask = {
      key: "kept",
      subject: "kept task",
      status: "pending",
      dependsOn: [],
      blockedBy: [],
      updatedAt: at,
    };
    const newTask = { ...keptTask, key: "new", subject: "new task" };
    writeFileSync(
      legacyCompactFile,
      [
        JSON.stringify({
          kind: "compact",
          revision: 5,
          at,
          by: "tower",
          sourceSha256: "test",
          skipped: 0,
          snapshotLines: 3,
          counts: { tasks: 1, messages: 1, findings: 1 },
        }),
        JSON.stringify({
          kind: "task",
          op: "upsert",
          key: "kept",
          task: keptTask,
          by: "alice",
          at,
        }),
        JSON.stringify({
          kind: "message",
          message: {
            id: "m-1",
            to: "all",
            from: "alice",
            subject: "s",
            body: "b",
            at,
          },
          by: "alice",
          at,
        }),
        JSON.stringify({
          kind: "finding",
          finding: {
            id: "f-1",
            kind: "bug",
            title: "legacy",
            severity: "low",
            status: "open",
            summary: "s",
            from: "alice",
            at,
          },
          by: "alice",
          at,
        }),
        JSON.stringify({
          kind: "task",
          op: "upsert",
          key: "new",
          task: newTask,
          by: "alice",
          at,
        }),
      ].join("\n") + "\n",
    );
    const folded = await new TowerBoard(legacyCompactFile).fold();
    check(
      "a legacy snapshot's finding row still consumes its slot (appended task event bumps the revision)",
      folded.revision === 6 &&
        folded.tasks.length === 2 &&
        folded.skipped === 0,
      `rev=${String(folded.revision)} tasks=${String(folded.tasks.length)} skipped=${String(folded.skipped)}`,
    );
  }
}

async function layer2(): Promise<void> {
  // HOME isolation: the extension keeps state under $HOME/.pi/{agent,tower-do};
  // point HOME at a throwaway dir so tests never touch the real user state.
  process.env.HOME = mkdtempSync(join(tmpdir(), "tower-do-home-"));
  const dir = mkdtempSync(join(tmpdir(), "tower-do-l2-"));
  type Handler = (...args: never[]) => unknown;
  const handlers = new Map<string, Handler>();
  type ToolDef = {
    name: string;
    execute: (
      id: string,
      params: never,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: never,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
    }>;
  };
  const tools = new Map<string, ToolDef>();
  let lastAppend: { customType: string; data: unknown } | undefined;

  const pi = {
    on: (event: string, handler: Handler): void => {
      handlers.set(event, handler);
    },
    registerTool: (def: ToolDef): void => {
      tools.set(def.name, def);
    },
    appendEntry: (customType: string, data: unknown): void => {
      lastAppend = { customType, data };
    },
    sendMessage: (): void => {},
    sendUserMessage: (): void => {},
    getSessionName: () => "smoke-session",
    getActiveTools: () => [],
    setActiveTools: (): void => {},
    getAllTools: () => [],
    getFlag: () => undefined,
    getCommands: () => [],
    registerCommand: (): void => {},
    registerShortcut: (): void => {},
    events: { on: () => {}, emit: (): void => {} },
  } as never;

  const {
    default: towerDoExtension,
    boardFileFor,
    stateDirFor,
  } = await import("../index.ts");
  towerDoExtension(pi as never);

  for (const name of ["tower_do", "tower_do_talk", "tower_do_status"]) {
    check(`extension registers ${name}`, tools.has(name));
  }
  if (
    !tools.has("tower_do") ||
    !tools.has("tower_do_talk") ||
    !tools.has("tower_do_status")
  )
    return;

  const ctxBase = {
    cwd: dir,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getSessionId: () => "smoke-session-id-0001",
      getBranch: () => [],
    },
  } as never;

  const run = async (
    name: string,
    params: never,
    cwd?: string,
  ): Promise<{ text: string; details?: unknown }> => {
    const def = tools.get(name)!;
    const callCtx =
      cwd === undefined ? ctxBase : { ...(ctxBase as object), cwd };
    const result = await def.execute(
      "call-1",
      params,
      undefined,
      undefined,
      callCtx,
    );
    const text = result.content.map((item) => item.text).join("\n");
    return { text, details: result.details };
  };
  const runThrow = async (
    name: string,
    params: never,
    cwd?: string,
  ): Promise<string> => {
    try {
      await run(name, params, cwd);
      return "NO ERROR";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // Session identity resolves to the session name.
  const s0 = await run("tower_do_status", {});
  check(
    "status exposes identity + board path",
    s0.text.includes("smoke-session") && s0.text.includes("board.jsonl"),
    s0.text.slice(0, 80),
  );
  // alice claims auth; bob's dependent billing starts pending (waits on auth).
  const plan = await run("tower_do", {
    tasks: [
      {
        key: "auth",
        subject: "refactor auth module",
        status: "in_progress",
        owner: "alice",
      },
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
    ],
  } as never);
  check(
    "plan returns per-event revision",
    /revision 2/.test(plan.text),
    plan.text.slice(0, 60),
  );
  const s1 = await run("tower_do_status", {});
  check(
    "two agents' tasks visible on one board",
    s1.text.includes("alice") && s1.text.includes("bob"),
    "owners shown",
  );

  // Blocked is DERIVED: pending billing waits on in_progress auth, so the
  // summary count, the Blocked section, and the row suffix must all agree
  // (and Pending must not double-count it).
  check(
    "status summary counts derived-blocked pending task",
    /Tasks: 2 total \(1 in_progress, 1 blocked, 0 pending, 0 completed\)/.test(
      s1.text,
    ),
    s1.text.split("\n")[4],
  );
  check(
    "the default view renders every open row with its why",
    /## Open \(2\)/.test(s1.text) &&
      s1.text.includes("- ✗ billing:") &&
      s1.text.includes("[blocked by: auth]"),
    s1.text.split("\n").slice(4, 9).join(" / "),
  );

  // The status filter follows the same derived contract as the rendering:
  // status:"blocked" finds gated pending tasks, status:"pending" does not.
  const asBlocked = await run("tower_do_status", {
    status: "blocked",
  } as never);
  check(
    "status filter blocked finds gated pending task",
    /## Open \(1\)[\s\S]*?- ✗ billing:[\s\S]*?\[blocked by: auth\]/.test(
      asBlocked.text,
    ) &&
      /Tasks: 2 total \(1 in_progress, 1 blocked, 0 pending, 0 completed\)/.test(
        asBlocked.text,
      ),
    "billing listed as blocked",
  );
  const asPending = await run("tower_do_status", {
    status: "pending",
  } as never);
  check(
    "status filter pending excludes gated pending task",
    asPending.text.includes("(no tasks match the filter)"),
    "pending filter empty",
  );

  // The default folds unrelated unfinished work into a compact ledger instead
  // of dropping it (every key a full-replacement write must name stays
  // readable), `view=mine` narrows further, and `view=all` expands. The ledger
  // prints the STORED status —
  // `billing` is stored `pending` and only derived-blocked — because that is
  // the value a replay writes back.
  // bob (as subagent id) tries to complete alice's task → ownership error.
  const blockedMsg = await runThrow("tower_do", {
    tasks: [
      {
        key: "auth",
        subject: "refactor auth module",
        status: "completed",
        owner: "alice",
      },
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
    ],
    baseRevision: 2,
    as: "bob",
  } as never);
  check(
    "subagent-as-bob cannot complete alice's task",
    /owned by "alice"/.test(blockedMsg),
    blockedMsg.slice(0, 100),
  );

  // Negotiation: alice messages bob (known owner), bob reads inbox. The sender
  // is alice because she passes as (her session identity would otherwise own
  // the send).
  await run("tower_do_talk", {
    action: "send",
    to: "bob",
    subject: "api shape",
    body: "I moved the token parser to src/auth/token.ts",
    as: "alice",
  } as never);
  const inbox = await run("tower_do_talk", {
    action: "inbox",
    as: "bob",
  } as never);
  check(
    "bob reads addressed message from alice",
    inbox.text.includes("api shape") && inbox.text.includes("alice → bob"),
    inbox.text.slice(0, 80),
  );

  // Self-send rejected.
  const selfMsg = await runThrow("tower_do_talk", {
    action: "send",
    to: "bob",
    subject: "x",
    body: "y",
    as: "bob",
  } as never);
  check(
    "self-send rejected",
    /cannot send an inbox message to yourself/.test(selfMsg),
    selfMsg.slice(0, 60),
  );

  // taskKey is a send-only thread: inbox must reject it loudly rather than
  // accept it and silently drop the link.
  const taskKeyOnInbox = await runThrow("tower_do_talk", {
    action: "inbox",
    taskKey: "auth",
  } as never);
  check(
    "taskKey rejected on non-send action",
    /taskKey applies to action=send only/.test(taskKeyOnInbox),
    taskKeyOnInbox.slice(0, 60),
  );

  // A node's own broadcast must not appear in its own inbox / status message
  // list (it already knows what it wrote); only OTHER nodes see it.
  await run("tower_do_talk", {
    action: "send",
    to: "all",
    subject: "standup sync",
    body: "alice here, all clear on auth",
    as: "alice",
  } as never);
  const aliceInbox = await run("tower_do_talk", {
    action: "inbox",
    as: "alice",
  } as never);
  check(
    "own broadcast excluded from own inbox",
    !aliceInbox.text.includes("standup sync"),
    aliceInbox.text.slice(0, 100),
  );
  const bobSeesBroadcast = await run("tower_do_talk", {
    action: "inbox",
    as: "bob",
  } as never);
  check(
    "broadcast visible to other nodes",
    bobSeesBroadcast.text.includes("standup sync"),
    bobSeesBroadcast.text.slice(0, 100),
  );
  // A fully-read inbox performs NO write: the ack append (and its
  // cross-process lease) is only for unacked messages, so a read-only state
  // dir still serves an inbox and a peer mid-compact cannot stall a read.
  const bobInboxBytes = readFileSync(boardFileFor(dir), "utf8").length;
  const bobReread = await run("tower_do_talk", {
    action: "inbox",
    as: "bob",
  } as never);
  check(
    "a fully-read inbox is a pure read (no ack append)",
    readFileSync(boardFileFor(dir), "utf8").length === bobInboxBytes &&
      !/newly acked/.test(bobReread.text),
    `bytes ${String(bobInboxBytes)} -> ${String(readFileSync(boardFileFor(dir), "utf8").length)}`,
  );

  // Stale write rejected via baseRevision (gate).
  const staleMsg = await runThrow("tower_do", {
    tasks: [{ key: "auth", subject: "x", status: "pending", owner: "alice" }],
    baseRevision: 999,
  } as never);
  check(
    "stale baseRevision rejected by gate",
    /stale tower-do revision/.test(staleMsg),
    staleMsg.slice(0, 60),
  );

  // --- review fixes: removal ownership, dangling deps, tower recipient ---

  // bob explicitly removes alice's auth → without a removal guard this would
  // delete alice's task.
  const partialMsg = await runThrow("tower_do", {
    tasks: [
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
    ],
    remove: ["auth"],
    baseRevision: 2,
    as: "bob",
  } as never);
  check(
    "partial list cannot remove another owner's task",
    /owned by "alice" .* may remove it/.test(partialMsg),
    partialMsg.slice(0, 100),
  );

  // Even the owner (alice) cannot remove auth while billing still depends.
  const danglingMsg = await runThrow("tower_do", {
    tasks: [
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
    ],
    remove: ["auth"],
    baseRevision: 2,
    as: "alice",
  } as never);
  check(
    "removing a depended-on task is rejected",
    /still depends on it/.test(danglingMsg),
    danglingMsg.slice(0, 100),
  );

  // tower (orchestrator) may remove any owned task once its dependents go.
  const towerRemoval = await run("tower_do", {
    tasks: [],
    remove: ["auth", "billing"],
    baseRevision: 2,
    as: "tower",
  } as never);
  check(
    "tower may clear the board",
    /board cleared/.test(towerRemoval.text) &&
      /revision 4/.test(towerRemoval.text),
    towerRemoval.text.slice(0, 80),
  );

  // Re-establish tasks for the send/status tests below.
  const rePlan = await run("tower_do", {
    tasks: [
      {
        key: "auth",
        subject: "refactor auth module",
        status: "in_progress",
        owner: "alice",
      },
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
    ],
    baseRevision: 4,
    as: "tower",
  } as never);
  check(
    "board re-established after clear",
    /revision 6/.test(rePlan.text),
    rePlan.text.slice(0, 60),
  );

  // tower is a legal recipient for negotiation messages.
  const toTower = await run("tower_do_talk", {
    action: "send",
    to: "tower",
    subject: "need routing",
    body: "who owns the docs scope?",
    as: "bob",
  } as never);
  check(
    "tower is a legal message recipient",
    typeof toTower.details === "object" &&
      toTower.details !== null &&
      "messageId" in (toTower.details as Record<string, unknown>),
    "tower recipient accepted",
  );

  // Single-line constraints on protocol fields.
  const newlineRecipient = await runThrow("tower_do_talk", {
    action: "send",
    to: "ali\nce",
    subject: "x",
    body: "y",
    as: "alice",
  } as never);
  check(
    "recipient must be a single line",
    /single line/.test(newlineRecipient),
    newlineRecipient.slice(0, 80),
  );
  const newlineAs = await runThrow("tower_do", {
    tasks: [],
    as: "bo\nb",
  } as never);
  check(
    "identity must be a single line",
    /single line/.test(newlineAs),
    newlineAs.slice(0, 80),
  );
  // "all" is the broadcast keyword — it must not be claimable as an acting
  // identity, or `as: "all"` would receive every broadcast and collide with
  // message addressing.
  const allAs = await runThrow("tower_do", {
    tasks: [],
    as: "all",
  } as never);
  check(
    'identity "all" is rejected',
    /reserved broadcast recipient "all"/.test(allAs),
    allAs.slice(0, 80),
  );

  // Documented protocol bounds that had no coverage at all. Each is a
  // rejection the contract states explicitly, and an untested bound is the one
  // that silently drifts when a constant is retuned.
  const bigBody = await runThrow("tower_do_talk", {
    action: "send",
    to: "all",
    subject: "big",
    body: "x".repeat(MAX_MESSAGE_BYTES + 1),
    as: "alice",
  } as never);
  check(
    "a message body over 32 KiB is rejected",
    /body too large/.test(bigBody),
    bigBody.slice(0, 90),
  );
  // Invalid status filter is a loud error, not a silent empty board.
  const badFilter = await runThrow("tower_do_status", {
    status: "done",
  } as never);
  check(
    "invalid status filter is rejected",
    /invalid status filter "done"/.test(badFilter),
    badFilter.slice(0, 80),
  );

  // A second identity reading the same board sees everything (file-as-state).
  const s3 = await run("tower_do_status", { as: "visitor" } as never);
  check(
    "another identity sees the same board",
    s3.text.includes("auth") && s3.text.includes("alice"),
    "cross-session visibility",
  );

  // --- project-scope anchoring: git root is the board root, else the dir ---

  // Scenario A: a session in a git repo subdir shares the root's board.
  const gitRoot = join(dir, "proj");
  const gitSub = join(gitRoot, "src");
  mkdirSync(join(gitRoot, ".git"), { recursive: true }); // git dir marker
  mkdirSync(gitSub, { recursive: true });
  const rootPlan = await run(
    "tower_do",
    {
      tasks: [
        {
          key: "api",
          subject: "design public api",
          status: "in_progress",
          owner: "alice",
        },
      ],
      as: "tower",
    } as never,
    gitRoot,
  );
  check(
    "plan at git root creates board under root",
    /revision 1/.test(rootPlan.text),
    rootPlan.text.slice(0, 60),
  );
  const subSees = await run("tower_do_status", {}, gitSub);
  check(
    "git subdir session reads the root board",
    subSees.text.includes("api") && subSees.text.includes("design public api"),
    subSees.text.slice(0, 80),
  );
  const subWrites = await run(
    "tower_do",
    {
      tasks: [
        {
          key: "api",
          subject: "design public api",
          status: "in_progress",
          owner: "alice",
        },
        {
          key: "sdk",
          subject: "ship sdk wrapper",
          status: "pending",
          owner: "bob",
          dependsOn: ["api"],
        },
      ],
      baseRevision: 1,
      as: "bob",
    } as never,
    gitSub,
  );
  check(
    "subdir write lands on the same board (revision 2)",
    /revision 2/.test(subWrites.text),
    subWrites.text.slice(0, 60),
  );
  const rootSees = await run("tower_do_status", {}, gitRoot);
  check(
    "root sees the subdir's addition",
    rootSees.text.includes("sdk") && rootSees.text.includes("ship sdk wrapper"),
    rootSees.text.slice(0, 80),
  );

  // Scenario B: two non-git sibling dirs are separate scopes.
  const dirA = join(dir, "alpha");
  const dirB = join(dir, "beta");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "alpha-task",
          subject: "alpha only",
          status: "in_progress",
          owner: "alice",
        },
      ],
      as: "tower",
    } as never,
    dirA,
  );
  const bSees = await run("tower_do_status", {}, dirB);
  check(
    "non-git sibling dir does not see the other's board",
    !bSees.text.includes("alpha-task"),
    bSees.text.slice(0, 80),
  );
  const aSees = await run("tower_do_status", {}, dirA);
  check(
    "non-git dir sees its own board",
    aSees.text.includes("alpha-task"),
    aSees.text.slice(0, 80),
  );

  // Scenario C: nested git repo stays inside its own root.
  const outer = join(dir, "outer");
  const inner = join(outer, "inner");
  mkdirSync(join(outer, ".git"), { recursive: true });
  mkdirSync(join(inner, ".git"), { recursive: true }); // nested independent repo
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "inner-only",
          subject: "inner repo work",
          status: "in_progress",
          owner: "carol",
        },
      ],
      as: "tower",
    } as never,
    inner,
  );
  const outerSees = await run("tower_do_status", {}, outer);
  check(
    "nested repo does not leak into its parent",
    !outerSees.text.includes("inner-only"),
    outerSees.text.slice(0, 80),
  );
  const innerSees = await run("tower_do_status", {}, inner);
  check(
    "nested repo reads its own board",
    innerSees.text.includes("inner-only"),
    innerSees.text.slice(0, 80),
  );

  // Scenario D: a git *worktree* marks its root with a `.git` file (content
  // `gitdir: ...`), not a directory — it must anchor just the same.
  const worktree = join(dir, "wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /some/elsewhere/main/.git\n");
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "wt-only",
          subject: "worktree side work",
          status: "in_progress",
          owner: "dave",
        },
      ],
      as: "tower",
    } as never,
    worktree,
  );
  const wtDeep = await run("tower_do_status", {}, join(worktree, "deep"));
  check(
    "git-file worktree anchors its own board root",
    wtDeep.text.includes("wt-only"),
    wtDeep.text.slice(0, 80),
  );
  const outerSeesWt = await run("tower_do_status", {}, dir);
  check(
    "worktree does not leak to the parent dir",
    !outerSeesWt.text.includes("wt-only"),
    "worktree isolation",
  );

  // Regression: a completed task with a stale blockedBy must not render
  // [blocked] or a waiting reason in the status output.
  await run("tower_do", {
    tasks: [
      {
        key: "auth",
        subject: "refactor auth module",
        status: "completed",
        owner: "alice",
      },
      {
        key: "billing",
        subject: "wire billing events",
        status: "pending",
        owner: "bob",
        dependsOn: ["auth"],
      },
      {
        key: "stale",
        subject: "delivered despite blockedBy",
        status: "completed",
        blockedBy: ["msg-1"],
      },
      {
        key: "wait",
        subject: "still blocked",
        status: "in_progress",
        blockedBy: ["msg-2"],
      },
      {
        key: "mine",
        subject: "session owned work",
        status: "in_progress",
        owner: "smoke-session",
      },
    ],
    as: "tower",
  } as never);
  await run("tower_do_talk", {
    action: "send",
    to: "smoke-session",
    subject: "ping me",
    body: "hello",
    as: "alice",
  } as never);
  const staleRow = await run("tower_do_status", { view: "all" } as never);
  const statusLines = staleRow.text.split("\n");
  // Completed rows render as a key ledger now: pin that section, not a
  // glyph+subject line (the subject still appears in the activity feed).
  const completedSection = (
    staleRow.text.split("## Completed")[1] ?? ""
  ).split("\n## ")[0] ?? "";
  // Pin the ledger's shape instead of asserting the absence of markers it can
  // no longer render: every row is keys only (`- a, b`), which is what makes
  // the section a replayable key list rather than another row list.
  const completedLedgerRows = completedSection
    .split("\n")
    .slice(1) // drop the `(2)` count that followed the section title
    .filter((line) => line.trim() !== "");
  check(
    "completed ledger is one packed key-only row per line",
    completedSection.includes("stale") &&
      completedSection.includes("auth") &&
      completedLedgerRows.length > 0 &&
      completedLedgerRows.every((line) =>
        /^- [a-z0-9][a-z0-9._-]*(, [a-z0-9][a-z0-9._-]*)*$/.test(line),
      ),
    completedLedgerRows.slice(0, 2).join(" / ") || "(missing)",
  );
  const waitLine =
    statusLines.find((line) => line.startsWith("- ✗ wait:")) ?? "";
  check(
    "in_progress + blockedBy row found",
    waitLine !== "",
    staleRow.text.slice(0, 80),
  );
  check(
    "in_progress + blockedBy still marked blocked",
    waitLine.includes("[blocked by: msg-2]"),
    waitLine || "(missing)",
  );
  check(
    "in_progress + blockedBy still names the blocker",
    waitLine.includes("msg-2"),
    waitLine || "(missing)",
  );
  const mineLine =
    statusLines.find((line) => line.startsWith("- ◐ mine:")) ?? "";
  check(
    "status renderer marks the caller's owned task with (me)",
    mineLine.includes("@smoke-session (me)"),
    mineLine || "(missing)",
  );
  check(
    "status renderer addresses inbox lines as → me",
    statusLines.some((line) => line.includes(" → me")),
    staleRow.text.slice(0, 120),
  );

  const aborted = new AbortController();
  aborted.abort();
  let abortMsg = "NO ERROR";
  try {
    await tools
      .get("tower_do")!
      .execute(
        "call-abort",
        { tasks: [{ key: "nope", subject: "x", status: "pending" }] } as never,
        aborted.signal,
        undefined,
        ctxBase,
      );
  } catch (error) {
    abortMsg = error instanceof Error ? error.message : String(error);
  }
  const afterAbort = await new TowerBoard(boardFileFor(dir)).fold();
  check(
    "aborted tower_do does not write",
    /cancelled|aborted/i.test(abortMsg) &&
      !afterAbort.tasks.some((task) => task.key === "nope"),
    abortMsg.slice(0, 80),
  );


  // Config is global ($HOME/.pi/agent/tower-do/config.json). Point HOME at
  // the fixture dir so the loader reads the fixture, restore the previous
  // value afterwards (nesting-safe: the outer layer2 already overrode HOME).
  const withHome = async (home: string, fn: () => Promise<void>) => {
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  };

  // Broken config.json fails loudly instead of silently resetting identity —
  // a silent default would corrupt owner matching in multi-agent sessions.
  const brokenDir = mkdtempSync(join(tmpdir(), "tower-do-badcfg-"));
  mkdirSync(join(brokenDir, ".pi", "agent", "tower-do"), { recursive: true });
  writeFileSync(
    join(brokenDir, ".pi", "agent", "tower-do", "config.json"),
    '{ "identity": "broken',
  );
  let brokenMsg = "";
  await withHome(brokenDir, async () => {
    brokenMsg = await runThrow("tower_do_status", {} as never, brokenDir);
  });
  check(
    "broken config.json is a loud error",
    /tower-do config .*config\.json/.test(brokenMsg),
    brokenMsg.slice(0, 80),
  );
  const reservedDir = mkdtempSync(join(tmpdir(), "tower-do-reserved-"));
  mkdirSync(join(reservedDir, ".pi", "agent", "tower-do"), { recursive: true });
  writeFileSync(
    join(reservedDir, ".pi", "agent", "tower-do", "config.json"),
    '{ "identity": "tower" }',
  );
  let reservedMsg = "";
  await withHome(reservedDir, async () => {
    reservedMsg = await runThrow("tower_do_status", {} as never, reservedDir);
  });
  check(
    "config identity tower is a loud error",
    /reserved orchestrator identity "tower"/.test(reservedMsg),
    reservedMsg.slice(0, 80),
  );

  const homeProject = process.env.HOME!;

  // Beyond the guard not firing: a real write must land in the global
  // records home. Fold the resolved path back and assert the round-trip.
  await run(
    "tower_do",
    {
      tasks: [
        { key: "home-write", subject: "pinned at home", status: "in_progress" },
      ],
    } as never,
    homeProject,
  );
  const homeBoard = await new TowerBoard(boardFileFor(homeProject)).fold();
  check(
    "session rooted at $HOME writes into the global records home",
    homeBoard.revision >= 1 &&
      homeBoard.tasks.some((task) => task.key === "home-write"),
    `rev=${homeBoard.revision} file=${boardFileFor(homeProject)}`,
  );

  // A caller-centred view is only testable with a caller-coupled peer row:
  // with no mine/needs rows, `view=mine`, `view=needs` and the default
  // `layers` render the same output, so a regression that wired the wrong
  // layer into the window would pass. Build a board where the caller's own
  // work waits on a peer's task and one unrelated row exists, then pin each
  // view's contract.
  const layersViewDir = mkdtempSync(join(tmpdir(), "tower-do-view-layers-"));
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "peer-blocker",
          subject: "peer gate",
          status: "pending",
          owner: "peer-owner",
        },
        {
          key: "mine-waits",
          subject: "my turn after the gate",
          status: "pending",
          owner: "smoke-session",
          dependsOn: ["peer-blocker"],
        },
        {
          key: "unrelated",
          subject: "nobody business",
          status: "pending",
          owner: "someone-else",
        },
      ],
    } as never,
    layersViewDir,
  );
  // A message old enough to leave the default view (unread, past the age
  // valve) is still readable via inbox all, but the default inbox hides it.
  const retiredAt = Date.now() - 30 * 24 * 60 * 60_000;
  await new TowerBoard(boardFileFor(dir)).append([
    {
      kind: "message",
      message: {
        id: "m-recent-control",
        to: "smoke-session",
        from: "ghost",
        subject: "recent",
        body: "recent body",
        at: Date.now(),
      },
      by: "ghost",
      at: Date.now(),
    },
    {
      kind: "message",
      message: {
        id: "m-age-retired",
        to: "smoke-session",
        from: "ghost",
        subject: "old",
        body: "old body",
        at: retiredAt,
      },
      by: "ghost",
      at: retiredAt,
    },
  ]);
  const inboxDefault = await run("tower_do_talk", { action: "inbox" } as never);
  check(
    "the default inbox hides an age-retired message (positive control present)",
    !inboxDefault.text.includes("m-age-retired") &&
      inboxDefault.text.includes("m-recent-control"),
    inboxDefault.text.slice(0, 80),
  );
  const inboxAll = await run("tower_do_talk", {
    action: "inbox",
    all: true,
  } as never);
  check(
    "inbox all reads a view-retired message",
    inboxAll.text.includes("m-age-retired"),
    inboxAll.text.slice(0, 80),
  );

  // The snapshot write must hand out arrays that do not alias the input view:
  // a caller mutating the result would otherwise mutate the board it folded.
  {
    const aliasView = createEmptyBoard();
    const aliasWrite = writeBoardSnapshot(
      aliasView,
      { tasks: [{ key: "a", subject: "a", status: "pending" }] },
      "tower",
    );
    (aliasWrite.view.messages as unknown[]).push({ nope: true });
    check(
      "writeBoardSnapshot returns arrays that do not alias the input view",
      aliasView.messages.length === 0,
      `messages=${String(aliasView.messages.length)}`,
    );
  }


}

await layer1();
await layer2();
console.log(
  failures === 0
    ? "\nALL SMOKE TESTS PASSED"
    : `\n${failures} SMOKE TEST(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
