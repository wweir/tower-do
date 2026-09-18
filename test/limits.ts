/**
 * tower-do limits — the "arg schema vs the fold" ownership gate.
 *
 * pi validates tool arguments against the registered `parameters` schema
 * BEFORE `execute` runs, and its error path can name only an index path
 * (`tasks.84.description`). A limit on an ARRAY ELEMENT that lives in that
 * schema therefore rejects an entire board write with an error that cannot say
 * WHICH task it hit — the real incident: an 85-task replay died on a
 * 2224-character description that had grown from a stored 1664, the whole
 * payload came back in the error, and the model had to guess the row.
 *
 * CONTRACTS.md "arg schema vs the fold" fixes the ownership:
 *   - an element-level limit the extension enforces (fold or execute) is never
 *     stated at its business value in the schema; wherever the schema declares
 *     that bound it carries `transportLimit(limit)` — a strictly looser payload
 *     guard — and the extension owns the error, because only it can name the
 *     task key, the measured length and the remedy;
 *   - a limit on a named top-level field stays in the schema at the business
 *     value, because that error path already names the field.
 *
 * This file locks the rule down:
 *   1. every schema bound is derived from a state.ts constant (no literals to
 *      drift), and every element-level bound is strictly looser than the limit
 *      the extension enforces — so the schema can never pre-empt that error;
 *   2. an over-limit value PASSES the arg schema (Value.Check on the real
 *      registered schema, i.e. the same checker the host uses) and is rejected
 *      by the fold with the task key, the measured length and the remedy;
 *   3. the guard never refuses a value the extension would accept, and the
 *      fold metric is Unicode code points;
 *   4. the documented remedy works: omitting a field on an existing task
 *      preserves the stored value, and a rejected write changes nothing.
 *
 * Run with: bun run test/limits.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { TowerBoard } from "../board.ts";
import {
  MAX_CHANGED_FILES,
  MAX_FINDING_LOCATION_CHARS,
  MAX_FINDING_SUGGESTED_FIX_CHARS,
  MAX_FINDING_SUMMARY_CHARS,
  MAX_FINDING_TITLE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_SUBJECT_CHARS,
  MAX_PATH_ENTRY_CHARS,
  MAX_SCOPE_GLOBS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TASK_KEY_CHARS,
  MAX_TASK_SUBJECT_CHARS,
  TASK_KEY_PATTERN,
  textLength,
  transportLimit,
} from "../state.ts";

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

async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  match: RegExp,
): Promise<string> {
  try {
    await fn();
    check(label, false, "expected an error but none was thrown");
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), message.slice(0, 200));
    return message;
  }
}

type SchemaNode = {
  properties: Record<string, SchemaNode>;
  items?: SchemaNode;
  maxItems?: number;
  maxLength?: number;
  pattern?: string;
};

/** The task-item schema of a registered tool's parameters (an array element). */
function taskItemSchema(parameters: unknown): SchemaNode {
  return (parameters as SchemaNode).properties.tasks.items as SchemaNode;
}

/** Element-level text limits, and the limit the extension enforces for each. */
const ELEMENT_TEXT: Array<[string, number]> = [
  ["subject", MAX_TASK_SUBJECT_CHARS],
  ["description", MAX_TASK_DESCRIPTION_CHARS],
  ["owner", MAX_IDENTITY_CHARS],
];
/** Element-level list limits, and the limit the extension enforces for each. */
const ELEMENT_COUNT: Array<[string, number]> = [
  ["dependsOn", MAX_TASK_DEPENDENCIES],
  ["scope", MAX_SCOPE_GLOBS],
  ["changedFiles", MAX_CHANGED_FILES],
  ["blockedBy", MAX_TASK_DEPENDENCIES],
];
/** Top-level named fields: the schema keeps the business value. */
const TOP_LEVEL: Array<[string, string, number]> = [
  ["tower_do", "as", MAX_IDENTITY_CHARS],
  ["tower_do_talk", "as", MAX_IDENTITY_CHARS],
  ["tower_do_talk", "to", MAX_IDENTITY_CHARS],
  ["tower_do_talk", "subject", MAX_MESSAGE_SUBJECT_CHARS],
  ["tower_do_talk", "title", MAX_FINDING_TITLE_CHARS],
  ["tower_do_talk", "summary", MAX_FINDING_SUMMARY_CHARS],
  ["tower_do_talk", "location", MAX_FINDING_LOCATION_CHARS],
  ["tower_do_talk", "suggestedFix", MAX_FINDING_SUGGESTED_FIX_CHARS],
  ["tower_do_status", "owner", MAX_IDENTITY_CHARS],
];

function task(fields: Record<string, unknown>): unknown {
  return { key: "t", subject: "s", status: "pending", ...fields };
}

async function main(): Promise<void> {
  // HOME isolation: the extension keeps state under $HOME/.pi/tower-do.
  process.env.HOME = mkdtempSync(join(tmpdir(), "tower-do-limits-home-"));
  const dir = mkdtempSync(join(tmpdir(), "tower-do-limits-"));

  type Handler = (...args: never[]) => unknown;
  type ToolDef = {
    name: string;
    parameters: unknown;
    execute: (
      id: string,
      params: never,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: never,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  };
  const handlers = new Map<string, Handler>();
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
    getSessionName: () => "limits-session",
    getActiveTools: () => [],
    setActiveTools: (): void => {},
    getAllTools: () => [],
    getFlag: () => undefined,
    getCommands: () => [],
    registerCommand: (): void => {},
    registerShortcut: (): void => {},
    events: { on: () => {}, emit: (): void => {} },
  } as never;

  const { default: towerDoExtension, boardFileFor } =
    await import("../index.ts");
  towerDoExtension(pi as never);

  const ctx = {
    cwd: dir,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getSessionId: () => "limits-session-id-0001",
      getBranch: () => [],
    },
  } as never;
  const board = new TowerBoard(boardFileFor(dir));
  const write = async (params: unknown): Promise<string> => {
    const def = tools.get("tower_do")!;
    const result = await def.execute(
      "call-1",
      params as never,
      undefined,
      undefined,
      ctx,
    );
    return result.content.map((item) => item.text).join("\n");
  };
  const fold = async () => await board.fold();

  const tower = tools.get("tower_do");
  const talk = tools.get("tower_do_talk");
  const status = tools.get("tower_do_status");
  check(
    "extension registers all three tools",
    tower !== undefined && talk !== undefined && status !== undefined,
  );
  if (tower === undefined || talk === undefined || status === undefined) return;

  // Value.Check wants a TypeBox TSchema; the registered parameters are exactly
  // that, reached through the mock's structural ToolDef type.
  const schema = tower.parameters as never;
  const item = taskItemSchema(tower.parameters);

  // -------------------------------------------------------------------------
  // 1. Every schema bound derives from state.ts, and the element-level ones
  //    are strictly looser than the limit the extension enforces.
  // -------------------------------------------------------------------------
  for (const [field, limit] of ELEMENT_TEXT) {
    const declared = item.properties[field].maxLength;
    check(
      `${field}: element text bound is the derived transport guard (looser than the enforced limit)`,
      declared === transportLimit(limit) && declared > limit,
      `schema=${String(declared)} limit=${limit} guard=${transportLimit(limit)}`,
    );
  }
  for (const [field, limit] of ELEMENT_COUNT) {
    const declared = item.properties[field].maxItems;
    check(
      `${field}: element count bound is the derived transport guard (looser than the enforced limit)`,
      declared === transportLimit(limit) && declared > limit,
      `schema=${String(declared)} limit=${limit} guard=${transportLimit(limit)}`,
    );
  }
  for (const [name, field, limit] of TOP_LEVEL) {
    const declared = (tools.get(name)!.parameters as SchemaNode).properties[
      field
    ]?.maxLength;
    check(
      `${name}.${field}: named field keeps the business limit (its error path names the field)`,
      declared === limit,
      `schema=${String(declared)} limit=${limit}`,
    );
  }
  check(
    "key: schema length and pattern derive from MAX_TASK_KEY_CHARS",
    item.properties.key.maxLength === MAX_TASK_KEY_CHARS &&
      item.properties.key.pattern === TASK_KEY_PATTERN.source,
    `maxLength=${String(item.properties.key.maxLength)} pattern=${String(item.properties.key.pattern)}`,
  );
  for (const name of ["tower_do_talk", "tower_do_status"]) {
    const taskKey = (tools.get(name)!.parameters as SchemaNode).properties
      .taskKey;
    check(
      `${name}.taskKey: schema derives the key rule`,
      taskKey.maxLength === MAX_TASK_KEY_CHARS &&
        taskKey.pattern === TASK_KEY_PATTERN.source,
      `maxLength=${String(taskKey.maxLength)}`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. An over-limit value must reach the extension, not be refused preflight.
  //    This is the regression gate for the incident: the old schema declared
  //    maxLength 2000, so a 2224-character description never reached the fold
  //    and the host answered with an index-only error.
  // -------------------------------------------------------------------------
  for (const [field, limit] of ELEMENT_TEXT) {
    check(
      `${field}: schema ACCEPTS the enforced limit itself`,
      Value.Check(schema, { baseRevision: 0, tasks: [task({ [field]: "x".repeat(limit) })] }),
      `field=${field}`,
    );
    check(
      `${field}: schema ACCEPTS limit + 1 (the extension owns the error)`,
      Value.Check(schema, {
        baseRevision: 0,
        tasks: [task({ [field]: "x".repeat(limit + 1) })],
      }),
      `field=${field} length=${limit + 1}`,
    );
    check(
      `${field}: schema still refuses a gross overflow (> the guard)`,
      !Value.Check(schema, {
        baseRevision: 0,
        tasks: [task({ [field]: "x".repeat(transportLimit(limit) + 1) })],
      }),
      `field=${field} length=${transportLimit(limit) + 1}`,
    );
  }
  for (const [field, limit] of ELEMENT_COUNT) {
    check(
      `${field}: schema ACCEPTS limit + 1 items (the extension owns the error)`,
      Value.Check(schema, {
        baseRevision: 0,
        tasks: [task({ [field]: Array.from({ length: limit + 1 }, (_, i) => `k${i}`) })],
      }),
      `field=${field} items=${limit + 1}`,
    );
    check(
      `${field}: schema still refuses a gross overflow (> the guard)`,
      !Value.Check(schema, {
        baseRevision: 0,
        tasks: [
          task({
            [field]: Array.from(
              { length: transportLimit(limit) + 1 },
              (_, i) => `k${i}`,
            ),
          }),
        ],
      }),
      `field=${field} items=${transportLimit(limit) + 1}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. The guard is a payload bound, not a rule: it must never refuse a value
  //    the extension accepts, and the metric is code points.
  // -------------------------------------------------------------------------
  const emoji = "🙂".repeat(MAX_TASK_DESCRIPTION_CHARS);
  check(
    "metric helper counts code points (an astral char is 1, not 2)",
    textLength(emoji) === MAX_TASK_DESCRIPTION_CHARS &&
      emoji.length === MAX_TASK_DESCRIPTION_CHARS * 2,
    `codePoints=${textLength(emoji)} utf16=${emoji.length}`,
  );
  check(
    "schema accepts a value the extension accepts (code points == the limit)",
    Value.Check(schema, { baseRevision: 0, tasks: [task({ description: emoji })] }),
  );
  check(
    "schema accepts, at the guard edge, an astral overflow the fold refuses",
    Value.Check(schema, {
      baseRevision: 0,
      tasks: [
        task({ description: "🙂".repeat(transportLimit(MAX_TASK_DESCRIPTION_CHARS)) }),
      ],
    }),
  );
  check(
    "schema refuses an astral overflow past the guard",
    !Value.Check(schema, {
      baseRevision: 0,
      tasks: [
        task({
          description: "🙂".repeat(transportLimit(MAX_TASK_DESCRIPTION_CHARS) + 1),
        }),
      ],
    }),
  );
  // The guard cannot bound combining-heavy text (one grapheme, thousands of
  // code points) — it stays a best-effort payload bound, and the fold still
  // names the task when such a value arrives.
  const combining = `a${"\u0301".repeat(4_000)}`;
  check(
    "combining-heavy text slips past the guard (documented: guard != upper bound)",
    textLength(combining) > transportLimit(MAX_TASK_DESCRIPTION_CHARS) &&
      Value.Check(schema, { baseRevision: 0, tasks: [task({ description: combining })] }),
    `codePoints=${textLength(combining)}`,
  );

  // -------------------------------------------------------------------------
  // 4. The fold's rejection is actionable: key, measured length, remedy.
  // -------------------------------------------------------------------------
  const stored = "y".repeat(1664); // the real board's near-limit description
  const created = await write({
    tasks: [
      {
        key: "cg-release",
        subject: "publish the catalog fix",
        status: "completed",
        description: stored,
      },
    ],
  });
  check(
    "near-limit description is accepted and stored",
    /revision 1/.test(created),
    created.slice(0, 80),
  );
  const view = await fold();
  check(
    "stored description round-trips",
    view.tasks[0]?.description === stored,
    `len=${String(view.tasks[0]?.description?.length)}`,
  );

  const message = await expectThrows(
    "over-limit description is refused by the fold, not the arg schema",
    () =>
      write({
        baseRevision: view.revision,
        tasks: [
          { key: "cg-release", description: "z".repeat(MAX_TASK_DESCRIPTION_CHARS + 224) },
        ],
      }),
    /tasks\[0\]\.description \(cg-release\) is 2224 characters \(max 2000\) — shorten it, or omit the field to preserve the stored text/,
  );
  check(
    "rejection names the key, not just the array index",
    message.includes("cg-release") && message.includes("2224"),
    message.slice(0, 120),
  );
  const afterReject = await fold();
  check(
    "rejected write changed nothing (revision + stored text intact)",
    afterReject.revision === view.revision &&
      afterReject.tasks[0]?.description === stored,
    `revision=${afterReject.revision} len=${String(afterReject.tasks[0]?.description?.length)}`,
  );

  // -------------------------------------------------------------------------
  // 5. The remedy: omitting the field preserves the stored value.
  // -------------------------------------------------------------------------
  await write({
    baseRevision: afterReject.revision,
    tasks: [{ key: "cg-release" }],
  });
  const afterOmit = await fold();
  check(
    "omitting description preserves the stored text (no resend needed)",
    afterOmit.revision === afterReject.revision &&
      afterOmit.tasks[0]?.description === stored,
    `revision=${afterOmit.revision}`,
  );

  // -------------------------------------------------------------------------
  // 6. Every element-level limit carries the same key-bearing remedy — the
  //    count limits included, which is why the schema guard covers maxItems.
  // -------------------------------------------------------------------------
  await write({
    baseRevision: afterOmit.revision,
    tasks: [
      {
        key: "astral",
        subject: "boundary row",
        status: "pending",
        description: emoji,
      },
      { key: "cg-release" },
    ],
  });
  const boundary = await fold();
  check(
    "an astral description at the limit is accepted end-to-end",
    boundary.tasks.find((task) => task.key === "astral")?.description === emoji,
  );
  await expectThrows(
    "2001 astral characters are refused by the fold with the same remedy",
    () =>
      write({
        baseRevision: boundary.revision,
        tasks: [
          {
            key: "astral",
            description: "🙂".repeat(MAX_TASK_DESCRIPTION_CHARS + 1),
          },
        ],
      }),
    /tasks\[0\]\.description \(astral\) is 2001 characters \(max 2000\)/,
  );
  await expectThrows(
    "over-limit subject is refused with the task key and the measured length",
    () =>
      write({
        baseRevision: boundary.revision,
        tasks: [
          { key: "astral", subject: "s".repeat(MAX_TASK_SUBJECT_CHARS + 1) },
        ],
      }),
    /tasks\[0\]\.subject \(astral\) is 161 characters \(max 160\) — shorten it/,
  );
  await expectThrows(
    "over-limit owner is refused with the field and the measured length",
    () =>
      write({
        baseRevision: boundary.revision,
        tasks: [{ key: "astral", owner: "o".repeat(MAX_IDENTITY_CHARS + 1) }],
      }),
    /tasks\[0\]\.owner \(astral\) is 65 characters \(max 64\) — shorten it/,
  );
  await expectThrows(
    "over-limit dependsOn is refused with the task key (the schema let it through)",
    () =>
      write({
        baseRevision: boundary.revision,
        tasks: [
          {
            key: "astral",
            dependsOn: Array.from(
              { length: MAX_TASK_DEPENDENCIES + 1 },
              (_, i) => `k${i}`,
            ),
          },
        ],
      }),
    /tasks\[0\]\.dependsOn \(astral\) supports at most 20 keys/,
  );

  // -------------------------------------------------------------------------
  // 7. Element-level CONTENT errors the fold owns must name the task, and a
  //    list cap must count the normalized list, not the raw input.
  // -------------------------------------------------------------------------
  check(
    "subject: emptiness is the fold's rule (no schema minLength to pre-empt it)",
    item.properties.subject.minLength === undefined,
  );
  const current = await fold();
  await expectThrows(
    "empty subject is refused with the task key",
    () =>
      write({
        baseRevision: current.revision,
        tasks: [{ key: "astral", subject: "   ", description: emoji }],
      }),
    /tasks\[0\]\.subject \(astral\) is required/,
  );
  await expectThrows(
    "over-limit owner is refused with the task key",
    () =>
      write({
        baseRevision: current.revision,
        tasks: [{ key: "astral", owner: "o".repeat(MAX_IDENTITY_CHARS + 1) }],
      }),
    /tasks\[0\]\.owner \(astral\) is 65 characters \(max 64\)/,
  );
  await expectThrows(
    "an over-long scope entry is refused with the key and the entry index",
    () =>
      write({
        baseRevision: current.revision,
        tasks: [
          {
            key: "astral",
            scope: ["src/**", "x".repeat(MAX_PATH_ENTRY_CHARS + 1)],
          },
        ],
      }),
    /tasks\[0\]\.scope\[1\] \(astral\) is 257 characters \(max 256\)/,
  );
  await expectThrows(
    "a malformed dependency key is refused with the depending task key",
    () =>
      write({
        baseRevision: current.revision,
        tasks: [{ key: "astral", dependsOn: ["Not A Key"] }],
      }),
    /tasks\[0\]\.dependsOn\[0\] \(astral\) must be 1-40/,
  );

  // Duplicates are dropped before the cap: 101 changedFiles entries with one
  // duplicate is 100 stored paths, and 21 references to one dependency is one
  // dependency. Counting the raw array rejected a legal value (the cap's error
  // even said "supports at most 100 paths" while the stored list was 100).
  await write({
    baseRevision: current.revision,
    tasks: [
      {
        key: "done-dep",
        subject: "completed dependency",
        status: "completed",
      },
      { key: "astral", description: emoji },
      {
        key: "cg-release",
        changedFiles: [
          ...Array.from({ length: MAX_CHANGED_FILES }, (_, i) => `src/f${i}.ts`),
          "src/f0.ts",
        ],
      },
    ],
  });
  const deduped = await fold();
  const receipt = deduped.tasks.find((task) => task.key === "cg-release");
  check(
    "changedFiles: a duplicate does not consume the cap (100 stored, not 101 rejected)",
    receipt?.changedFiles?.length === MAX_CHANGED_FILES,
    `stored=${String(receipt?.changedFiles?.length)}`,
  );
  await write({
    baseRevision: deduped.revision,
    tasks: [
      { key: "done-dep" },
      { key: "cg-release" },
      {
        key: "astral",
        description: emoji,
        dependsOn: Array.from({ length: MAX_TASK_DEPENDENCIES + 1 }, () => "done-dep"),
      },
    ],
  });
  const dedupedDeps = await fold();
  const astral = dedupedDeps.tasks.find((task) => task.key === "astral");
  check(
    "dependsOn: 21 references to one key collapse to one dependency (cap counts the set)",
    astral?.dependsOn.length === 1,
    `deps=${JSON.stringify(astral?.dependsOn)}`,
  );

  console.log(
    `\n${failures === 0 ? "OK" : "FAILED"}  ${passed} passed, ${failures} failed`,
  );
  if (failures > 0) process.exit(1);
}

await main();
