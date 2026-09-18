/**
 * tower-do session scoping — a nested session must never re-label its parent.
 *
 * pi runs subagent/task sessions in-process (they appear as
 * `sessions/<parent>/tasks/<child>.jsonl`), and the extension used to keep its
 * "ambient session context" in a MODULE-level `lastContext` that every
 * `towerDoExtension(pi)` call in the process overwrote. A child session's
 * restore() therefore re-labelled the parent:
 *   - the parent's board reminder announced the child's identity
 *     ("TowerDo shared board — you are session-<child>"),
 *   - the parent's liveness heartbeat wrote the child's identity, so the
 *     parent's own tasks lost their liveness protection (a live owner reads as
 *     idle and becomes displaceable after the takeover window),
 *   - presence / `live N` merged the two.
 * The TOOL path masked it (prepare() assigned the global to its own ctx right
 * before resolving the caller), which is why writes were still attributed
 * correctly — so this gate drives the REMINDER path, where the wrong identity
 * actually surfaced.
 *
 * Run with: bun run test/identity-scope.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

type Handler = (...args: never[]) => unknown;
type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: never,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

/** One session's extension instance: its own handlers, tools and ctx. */
function makeInstance(dir: string, sessionId: string) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDef>();
  const sent: string[] = [];
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
    getSessionName: () => undefined,
    getActiveTools: () => [],
    setActiveTools: (): void => {},
    getAllTools: () => [],
    getFlag: () => undefined,
    getCommands: () => [],
    registerCommand: (): void => {},
    registerShortcut: (): void => {},
    events: { on: () => {}, emit: (): void => {} },
  } as never;
  const ctx = {
    cwd: dir,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  } as never;
  const fire = async (event: string, arg?: unknown): Promise<unknown> => {
    const handler = handlers.get(event);
    if (handler === undefined) throw new Error(`no handler for ${event}`);
    return await (handler as (a: unknown, c: unknown) => Promise<unknown>)(
      arg,
      ctx,
    );
  };
  return { pi, ctx, tools, sent, fire };
}

async function main(): Promise<void> {
  process.env.HOME = mkdtempSync(join(tmpdir(), "tower-do-scope-home-"));
  const dir = mkdtempSync(join(tmpdir(), "tower-do-scope-"));
  const parent = makeInstance(dir, "aaaaaaaa-1111-70bd-9a77-2408af4fdaf8");
  const child = makeInstance(dir, "bbbbbbbb-2222-70bd-9a77-2412ac0f8017");
  const parentIdentity = "session-aaaaaaaa";
  const childIdentity = "session-bbbbbbbb";

  const towerDoExtension = (await import("../index.ts")).default;
  // Both sessions load the extension in ONE process — the real layout.
  towerDoExtension(parent.pi as never);
  await parent.fire("session_start");

  const plan = await parent.tools.get("tower_do")!.execute(
    "call-1",
    { tasks: [{ key: "work", subject: "unfinished work", status: "pending" }] } as never,
    undefined,
    undefined,
    parent.ctx,
  );
  check(
    "parent plans a task on the shared board",
    plan.content.some((item) => item.text.includes("revision 1")),
    plan.content.map((item) => item.text).join(" ").slice(0, 80),
  );

  // The nested session starts in the same process AFTER the parent. Under the
  // old module-level context this overwrote the parent's ambient session.
  towerDoExtension(child.pi as never);
  await child.fire("session_start");

  const reminderOf = async (instance: ReturnType<typeof makeInstance>) => {
    let last: unknown;
    // REMINDER_INTERVAL calls before the reminder is injected.
    for (let i = 0; i < 3; i += 1) {
      last = await instance.fire("context", { messages: [] });
    }
    const result = last as { messages?: Array<{ content?: string }> } | undefined;
    return (result?.messages ?? [])
      .map((message) => message.content ?? "")
      .join("\n");
  };

  const parentReminder = await reminderOf(parent);
  check(
    "parent reminder still announces the PARENT identity after a nested session started",
    parentReminder.includes(`you are ${parentIdentity}`),
    parentReminder.split("\n")[0]?.slice(0, 120),
  );
  check(
    "parent reminder does not announce the nested session's identity",
    !parentReminder.includes(childIdentity),
    parentReminder.split("\n")[0]?.slice(0, 120),
  );

  const childReminder = await reminderOf(child);
  check(
    "nested session announces its own identity",
    childReminder.includes(`you are ${childIdentity}`),
    childReminder.split("\n")[0]?.slice(0, 120),
  );

  const status = await parent.tools.get("tower_do_status")!.execute(
    "call-2",
    {} as never,
    undefined,
    undefined,
    parent.ctx,
  );
  const statusText = status.content.map((item) => item.text).join("\n");
  check(
    "parent status tool still resolves the parent identity",
    statusText.includes(`identity ${parentIdentity}`),
    statusText.split("\n")[0]?.slice(0, 120),
  );

  // Both instances are real extension sessions: they hold live heartbeat
  // timers and fs watchers, so the test must shut them down (and exit) rather
  // than wait for an event loop that will never drain.
  await parent.fire("session_shutdown").catch(() => {});
  await child.fire("session_shutdown").catch(() => {});

  console.log(
    `\n${failures === 0 ? "OK" : "FAILED"}  ${passed} passed, ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
