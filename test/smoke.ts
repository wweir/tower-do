/**
 * tower-do smoke test — two layers:
 *  1. pure state + board layer (multi-agent semantics)
 *  2. the real extension via a mock ExtensionAPI (tools execute end-to-end)
 * Run with: bun run /tmp/tower-do-smoke.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TowerBoard } from "../board.ts";
import {
  createEmptyBoard,
  findAllUnresolvedDeps,
  taskIsBlocked,
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
}

async function layer2(): Promise<void> {
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

  const pi = {
    on: (event: string, handler: Handler): void => {
      handlers.set(event, handler);
    },
    registerTool: (def: ToolDef): void => {
      tools.set(def.name, def);
    },
    appendEntry: (): void => {},
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

  const { default: towerDoExtension } = await import("../index.ts");
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
  const runThrow = async (name: string, params: never): Promise<string> => {
    try {
      await run(name, params);
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
    "two agents' WIP visible on one board",
    s1.text.includes("alice") && s1.text.includes("bob"),
    "owners shown",
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
}

await layer1();
await layer2();
console.log(
  failures === 0
    ? "\nALL SMOKE TESTS PASSED"
    : `\n${failures} SMOKE TEST(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
