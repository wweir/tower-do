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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TowerBoard } from "../board.ts";
import {
  createEmptyBoard,
  findAllUnresolvedDeps,
  formatBoardReminder,
  taskIsBlocked,
  TOWER_DO_BOARD_TYPE,
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
          scope: ["src/gemm/**"],
        },
        {
          key: "readme",
          subject: "write vulkan API survey into README",
          status: "in_progress",
          owner: "bob",
          scope: ["README.md"],
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
    reminderWaiting.includes("1 task(s), 1 blocked") &&
      reminderWaiting.includes("- [blocked] wait:"),
    reminderWaiting.split("\n")[1],
  );
  const gatedDep = writeBoardSnapshot(
    createEmptyBoard(),
    {
      tasks: [
        { key: "auth", subject: "refactor auth", status: "in_progress" },
        {
          key: "billing",
          subject: "wire billing",
          status: "pending",
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
    {
      kind: "finding",
      finding: {
        id: "f-1",
        kind: "vuln",
        title: "gemm unchecked bounds",
        severity: "high",
        status: "open",
        summary: "index overflow on M=0",
        suggestedFix: "guard M",
        from: "carol",
        at: Date.now(),
      },
      by: "carol",
      at: Date.now(),
    },
  ]);
  const folded = await board.fold();
  check(
    "message/finding folded back",
    folded.messages.length === 1 && folded.findings.length === 1,
    `msgs=${folded.messages.length} finds=${folded.findings.length}`,
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

  // tower_do is a FULL replacement: a batch that omits a task deletes it, so
  // a surviving task may not depend on an omitted (being-removed) task — the
  // old code looked up the pre-write board and let a dangling ref through.
  expectThrows(
    "surviving task cannot depend on a task this write removes",
    () =>
      writeBoardSnapshot(
        view,
        {
          // omit gemm (owned by alice) but keep test, which depends on it
          tasks: view.tasks
            .filter((t) => t.key !== "gemm")
            .map((t) => ({
              key: t.key,
              subject: t.subject,
              status: t.status,
            })),
          baseRevision: view.revision,
        },
        "tower",
      ),
    /still depends on it/,
  );

  // A dependent may drop the dependency and delete its target in one write:
  // the full-replacement check runs on the POST-write graph, so this passes.
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

  // changedFiles receipt survives the DISK round-trip (board.append → fold):
  // a completed task carrying the receipt must re-fold it from the JSONL
  // event log, including via a second TowerBoard instance on the same file
  // (the path a peer session actually reads).
  const doneWrite = writeBoardSnapshot(
    view,
    {
      tasks: [
        {
          key: "readme",
          subject: "write vulkan API survey into README",
          status: "completed",
          owner: "bob",
          changedFiles: ["README.md", "src/api/types.ts"],
        },
        {
          key: "test",
          subject: "run sqznet test",
          status: "pending",
          owner: "carol",
          dependsOn: [],
        },
      ],
      baseRevision: view.revision,
    },
    "bob",
  );
  view = doneWrite.view;
  await board.append(doneWrite.taskEvents);
  const receipt = doneWrite.view.tasks.find((t) => t.key === "readme");
  check(
    "completing with changedFiles persists the receipt",
    receipt?.status === "completed" &&
      JSON.stringify(receipt.changedFiles) ===
        JSON.stringify(["README.md", "src/api/types.ts"]),
    `changedFiles=${JSON.stringify(receipt?.changedFiles)}`,
  );
  const freshBoard = new TowerBoard(file);
  const reFolded = await freshBoard.fold();
  const reRead = reFolded.tasks.find((t) => t.key === "readme");
  check(
    "changedFiles receipt survives disk fold across instances",
    reRead?.status === "completed" &&
      JSON.stringify(reRead.changedFiles) ===
        JSON.stringify(["README.md", "src/api/types.ts"]),
    `reFolded changedFiles=${JSON.stringify(reRead?.changedFiles)}`,
  );
  check(
    "revision still equals a refold after the receipt write",
    reFolded.revision === doneWrite.view.revision,
    `refold=${reFolded.revision} write=${doneWrite.view.revision}`,
  );
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
        scope: ["src/auth/**"],
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
    "status groups derived-blocked task under Blocked with why",
    s1.text.includes("## Blocked") &&
      /Blocked[\s\S]*?billing[\s\S]*?\[blocked by: auth\]/.test(s1.text) &&
      !/## Pending[\s\S]*billing/.test(s1.text),
    "billing in Blocked, absent from Pending",
  );

  // The status filter follows the same derived contract as the rendering:
  // status:"blocked" finds gated pending tasks, status:"pending" does not.
  const asBlocked = await run("tower_do_status", {
    status: "blocked",
  } as never);
  check(
    "status filter blocked finds gated pending task",
    /## Blocked[\s\S]*?billing[\s\S]*?\[blocked by: auth\]/.test(
      asBlocked.text,
    ) &&
      /Tasks: 2 total \(1 in_progress, 1 blocked, 0 pending, 0 completed\)/.test(
        asBlocked.text,
      ),
    "billing listed under Blocked",
  );
  const asPending = await run("tower_do_status", {
    status: "pending",
  } as never);
  check(
    "status filter pending excludes gated pending task",
    asPending.text.includes("(no tasks match the filter)"),
    "pending filter empty",
  );

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

  // Finding filed by a reviewer identity, visible in status.
  await run("tower_do_talk", {
    action: "finding",
    kind: "vuln",
    severity: "high",
    title: "token parser overflow",
    summary: "input not bounded",
    location: "src/auth/token.ts",
    suggestedFix: "clamp length",
  } as never);
  const s2 = await run("tower_do_status", {});
  check(
    "finding visible on dashboard",
    s2.text.includes("token parser overflow"),
    "finding surfaced",
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

  // bob submits a partial list that omits alice's auth → the [高] attack:
  // without a removal guard this would silently delete alice's task.
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
        scope: ["src/auth/**"],
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
  const staleRow = await run("tower_do_status", {});
  const statusLines = staleRow.text.split("\n");
  // Pin the Completed-group glyph+key, not a substring that also appears
  // in the activity feed (`- tower · … · ✓ stale: …`).
  const staleLine =
    statusLines.find((line) => line.startsWith("- ✓ stale:")) ?? "";
  check(
    "completed row found for stale blockedBy",
    staleLine !== "",
    staleRow.text.slice(0, 80),
  );
  check(
    "completed row shows no [blocked] marker",
    staleLine !== "" && !staleLine.includes("[blocked]"),
    staleLine || "(missing)",
  );
  check(
    "completed row shows no waiting reason",
    staleLine !== "" && !staleLine.includes("waiting"),
    staleLine || "(missing)",
  );
  const waitLine =
    statusLines.find((line) => line.startsWith("- ◐ wait:")) ?? "";
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

  // Context reminders must re-fold disk so a peer cancel is what the LLM
  // sees, even when this session has not made a tool call since.
  const ctxDir = mkdtempSync(join(tmpdir(), "tower-do-ctxfold-"));
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "stale-todo",
          subject: "old",
          status: "in_progress",
        },
      ],
      as: "tower",
    } as never,
    ctxDir,
  );
  const ctxGhost = new TowerBoard(boardFileFor(ctxDir));
  const ctxFolded = await ctxGhost.fold();
  await ctxGhost.append(
    writeBoardSnapshot(
      ctxFolded,
      {
        tasks: [
          {
            key: "live-todo",
            subject: "after cancel",
            status: "in_progress",
          },
        ],
        baseRevision: ctxFolded.revision,
      },
      "tower",
    ).taskEvents,
  );
  const ctxHandler = handlers.get("context");
  let ctxReminder = "";
  if (ctxHandler !== undefined) {
    for (let i = 0; i < 3; i += 1) {
      const injected = (await ctxHandler(
        { messages: [] } as never,
        { ...ctxBase, cwd: ctxDir } as never,
      )) as { messages?: Array<{ content?: string }> } | undefined;
      const last = injected?.messages?.at(-1)?.content;
      if (typeof last === "string") ctxReminder = last;
    }
  }
  check(
    "context reminder re-folds peer cancel without a tool call",
    ctxReminder.includes("live-todo") && !ctxReminder.includes("stale-todo"),
    ctxReminder.slice(0, 120),
  );
  const replaced = ctxHandler
    ? ((await ctxHandler(
        {
          messages: [
            {
              role: "custom",
              customType: TOWER_DO_BOARD_TYPE,
              content:
                "TowerDo shared board (revision 1; 1 task(s), 0 blocked, 0 unread message(s) for you).\n- [in_progress] stale-todo: old",
            },
          ],
        } as never,
        { ...ctxBase, cwd: ctxDir } as never,
      )) as { messages?: Array<{ customType?: string; content?: string }> })
    : undefined;
  const replacedText = (replaced?.messages ?? [])
    .map((message) => message.content ?? "")
    .join("\n");
  check(
    "context strips compact snapshots so cancelled todos leave the LLM",
    replacedText.includes("live-todo") &&
      !replacedText.includes("stale-todo") &&
      !(replaced?.messages ?? []).some(
        (message) => message.customType === TOWER_DO_BOARD_TYPE,
      ),
    replacedText.slice(0, 160),
  );

  // Compact must re-fold disk so a later session's cancel is what gets
  // checkpointed — otherwise restore-from-missing-board resurrects the
  // cancelled in-memory todos.
  const compactDir = mkdtempSync(join(tmpdir(), "tower-do-compact-"));
  await run(
    "tower_do",
    {
      tasks: [
        {
          key: "stale-todo",
          subject: "should not checkpoint",
          status: "in_progress",
        },
      ],
      as: "tower",
    } as never,
    compactDir,
  );
  const compactFile = boardFileFor(compactDir);
  const ghost = new TowerBoard(compactFile);
  const folded = await ghost.fold();
  const live = writeBoardSnapshot(
    folded,
    {
      tasks: [
        {
          key: "live-todo",
          subject: "after cancel",
          status: "in_progress",
        },
      ],
      baseRevision: folded.revision,
    },
    "tower",
  );
  await ghost.append(live.taskEvents);
  lastAppend = undefined;
  const compactHandler = handlers.get("session_compact");
  check("session_compact handler registered", compactHandler !== undefined);
  if (compactHandler !== undefined) {
    await compactHandler(
      { willRetry: false } as never,
      {
        ...ctxBase,
        cwd: compactDir,
        hasPendingMessages: () => false,
      } as never,
    );
  }
  const checkpoint = lastAppend?.data as
    | { tasks?: Array<{ key: string }> }
    | undefined;
  const checkpointKeys = (checkpoint?.tasks ?? []).map((task) => task.key);
  check(
    "compact checkpoint re-folds disk so cancelled todos do not come back",
    lastAppend?.customType === TOWER_DO_BOARD_TYPE &&
      checkpointKeys.includes("live-todo") &&
      !checkpointKeys.includes("stale-todo"),
    checkpointKeys.join(","),
  );
  const afterCompact = await ghost.fold();
  const postCompact = writeBoardSnapshot(
    afterCompact,
    {
      tasks: [
        {
          key: "post-compact",
          subject: "cancel landed after compact",
          status: "in_progress",
        },
      ],
      baseRevision: afterCompact.revision,
    },
    "tower",
  );
  await ghost.append(postCompact.taskEvents);
  const agentStart = handlers.get("before_agent_start");
  const injectedBoard = agentStart
    ? ((await agentStart(
        {} as never,
        { ...ctxBase, cwd: compactDir } as never,
      )) as
        | {
            message?: {
              details?: { tasks?: Array<{ key: string }> };
            };
          }
        | undefined)
    : undefined;
  const injectedKeys = (injectedBoard?.message?.details?.tasks ?? []).map(
    (task) => task.key,
  );
  check(
    "before_agent_start re-folds so compact injection is not a stale cancel",
    injectedKeys.includes("post-compact") &&
      !injectedKeys.includes("live-todo") &&
      !injectedKeys.includes("stale-todo"),
    injectedKeys.join(","),
  );
  unlinkSync(compactFile);
  const startHandler = handlers.get("session_start");
  if (startHandler !== undefined && lastAppend !== undefined) {
    await startHandler(
      {} as never,
      {
        ...ctxBase,
        cwd: compactDir,
        sessionManager: {
          getSessionId: () => "compact-sess",
          getBranch: () => [
            {
              type: "custom",
              customType: TOWER_DO_BOARD_TYPE,
              data: lastAppend.data,
            },
          ],
        },
      } as never,
    );
  }
  const contextHandler = handlers.get("context");
  let reminder = "";
  if (contextHandler !== undefined) {
    for (let i = 0; i < 3; i += 1) {
      const injected = (await contextHandler({ messages: [] } as never)) as
        | { messages?: Array<{ content?: string }> }
        | undefined;
      const last = injected?.messages?.at(-1)?.content;
      if (typeof last === "string") reminder = last;
    }
  }
  check(
    "restore after compact uses live checkpoint, not cancelled todos",
    reminder.includes("live-todo") && !reminder.includes("stale-todo"),
    reminder.slice(0, 120),
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

  // One-time auto-migration: a legacy per-project state dir moves wholesale
  // into the global records home, and a pinned identity rides along to the
  // global config path when the user has none there — no warning, no loss.
  const legacyHome = mkdtempSync(join(tmpdir(), "tower-do-legacy-home-"));
  const legacyDir = mkdtempSync(join(tmpdir(), "tower-do-legacy-"));
  mkdirSync(join(legacyDir, ".pi", "tower-do"), { recursive: true });
  writeFileSync(
    join(legacyDir, ".pi", "tower-do", "config.json"),
    '{ "identity": "legacy-pinned" }',
  );
  let legacyMsg = "";
  await withHome(legacyHome, async () => {
    legacyMsg = await runThrow("tower_do_status", {} as never, legacyDir);
  });
  const migratedConfig = JSON.parse(
    readFileSync(
      join(legacyHome, ".pi", "agent", "tower-do", "config.json"),
      "utf8",
    ),
  );
  check(
    "legacy state auto-migrates into the global records home",
    !/no longer read/.test(legacyMsg) &&
      migratedConfig.identity === "legacy-pinned" &&
      !existsSync(join(legacyDir, ".pi", "tower-do")),
    legacyMsg.slice(0, 120),
  );

  // A legacy dir holding ONLY live/ heartbeats carries no data (2-min TTL;
  // a pre-upgrade session may still be writing them) — it must not brick
  // the next session the way a leftover board.jsonl does.
  const liveOnlyDir = mkdtempSync(join(tmpdir(), "tower-do-liveonly-"));
  mkdirSync(join(liveOnlyDir, ".pi", "tower-do", "live"), {
    recursive: true,
  });
  writeFileSync(join(liveOnlyDir, ".pi", "tower-do", "live", "s.json"), "{}");
  const liveOnlyMsg = await runThrow(
    "tower_do_status",
    {} as never,
    liveOnlyDir,
  );
  check(
    "legacy live-only leftover does not trip the guard",
    !/no longer read/.test(liveOnlyMsg),
    liveOnlyMsg.slice(0, 120),
  );

  // Migration failure must fail LOUD, never silently drop a pinned identity:
  // with the state root occupied by a non-directory, the move cannot happen
  // and every tower-do call reports both paths.
  const blockedHome = mkdtempSync(join(tmpdir(), "tower-do-blocked-home-"));
  const blockedDir = mkdtempSync(join(tmpdir(), "tower-do-blocked-"));
  mkdirSync(join(blockedHome, ".pi"), { recursive: true });
  writeFileSync(join(blockedHome, ".pi", "tower-do"), "not a dir");
  mkdirSync(join(blockedDir, ".pi", "tower-do"), { recursive: true });
  writeFileSync(join(blockedDir, ".pi", "tower-do", "config.json"), "{}");
  let migrateFailMsg = "";
  await withHome(blockedHome, async () => {
    migrateFailMsg = await runThrow("tower_do_status", {} as never, blockedDir);
  });
  check(
    "failed migration fails loud instead of dropping state",
    /could not be migrated/.test(migrateFailMsg),
    migrateFailMsg.slice(0, 120),
  );

  // A legacy board NEXT TO an already-initialized state dir is a genuine
  // merge conflict — loud, never a silent pick between two boards.
  const conflictDir = mkdtempSync(join(tmpdir(), "tower-do-conflict-"));
  mkdirSync(join(conflictDir, ".pi", "tower-do"), { recursive: true });
  writeFileSync(join(conflictDir, ".pi", "tower-do", "board.jsonl"), "");
  mkdirSync(stateDirFor(conflictDir), { recursive: true });
  const conflictMsg = await runThrow(
    "tower_do_status",
    {} as never,
    conflictDir,
  );
  check(
    "legacy board beside an initialized state dir fails loud",
    /conflicts with/.test(conflictMsg),
    conflictMsg.slice(0, 120),
  );

  // A config-only leftover when the state dir was ALREADY migrated must
  // still reach the global path — target-exists must not silently drop the
  // pinned identity (the retired layout called config.json safe to commit,
  // so it can reappear from git at any time).
  const lateHome = mkdtempSync(join(tmpdir(), "tower-do-late-home-"));
  const lateDir = mkdtempSync(join(tmpdir(), "tower-do-late-"));
  mkdirSync(join(lateDir, ".pi", "tower-do"), { recursive: true });
  writeFileSync(
    join(lateDir, ".pi", "tower-do", "config.json"),
    '{ "identity": "late-pinned" }',
  );
  mkdirSync(stateDirFor(lateDir), { recursive: true });
  let lateMsg = "";
  await withHome(lateHome, async () => {
    lateMsg = await runThrow("tower_do_status", {} as never, lateDir);
  });
  const lateConfig = JSON.parse(
    readFileSync(join(lateHome, ".pi", "agent", "tower-do", "config.json"), "utf8"),
  );
  check(
    "config-only leftover migrates even when the state dir exists",
    !/could not be migrated|conflicts with/.test(lateMsg) &&
      lateConfig.identity === "late-pinned",
    lateMsg.slice(0, 120),
  );

  // The global state root must never trip the legacy guard: a session whose
  // project root resolves to $HOME (no git boundary above it) has its legacy
  // path EQUAL to the records home, which holds real boards — throwing there
  // would brick tower-do for home-dir sessions.
  const homeProject = process.env.HOME!;
  mkdirSync(join(homeProject, ".pi", "tower-do", "seeded-project"), {
    recursive: true,
  });
  writeFileSync(
    join(homeProject, ".pi", "tower-do", "seeded-project", "board.jsonl"),
    "",
  );
  const homeMsg = await runThrow("tower_do_status", {} as never, homeProject);
  check(
    "session rooted at $HOME does not trip the legacy guard",
    !/no longer read/.test(homeMsg),
    homeMsg.slice(0, 80),
  );

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
}

await layer1();
await layer2();
console.log(
  failures === 0
    ? "\nALL SMOKE TESTS PASSED"
    : `\n${failures} SMOKE TEST(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
