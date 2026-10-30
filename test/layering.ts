/**
 * Static regression: the layer boundaries hold.
 *
 * The module split only works while the dependency direction is one-way:
 *
 *   state.ts   pure schema / validation / fold      (no I/O, no local imports)
 *   render.ts  schemas + formatters                 (no I/O, no board access)
 *   board.ts   append-only JSONL disk layer         (may touch the filesystem)
 *   paths.ts   project anchoring + board cache      (may touch the filesystem)
 *   index.ts   extension assembly                   (may import all of the above)
 *
 * `tsc` cannot see this: importing `node:fs` from `state.ts` or `./board.ts`
 * from `render.ts` type-checks perfectly, and would only show up as a test that
 * suddenly needs a real filesystem. So the rule is enforced on the source text.
 *
 * Run with: bun test/layering.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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

/** Every module specifier the file imports, statically or dynamically. */
function specifiersOf(source: string): string[] {
  const patterns = [
    // import x from "s" / import { a } from "s" / export ... from "s"
    /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm,
    // import "s" (side-effect only)
    /^\s*import\s+["']([^"']+)["']/gm,
    // await import("s")
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found];
}

/** A bare builtin name (`fs`) is just as much an I/O dependency as a prefixed
 *  one (`node:fs`), and `builtinModules` lists only the bare names. */
const BUILTINS = new Set(builtinModules);
function isBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("deno:") ||
    BUILTINS.has(specifier)
  );
}

type Rule = {
  /** Local modules this file must never import. */
  forbids: string[];
  /** The file must not import any runtime builtin (it stays I/O-free). */
  pureOfIo: boolean;
};

/** Lower layers may only import what sits beneath them; `index.ts` is the top. */
const RULES: Record<string, Rule> = {
  "state.ts": {
    forbids: ["./board.ts", "./paths.ts", "./render.ts", "./index.ts"],
    pureOfIo: true,
  },
  "render.ts": {
    forbids: ["./board.ts", "./paths.ts", "./index.ts"],
    pureOfIo: true,
  },
  "board.ts": {
    forbids: ["./paths.ts", "./render.ts", "./index.ts"],
    pureOfIo: false,
  },
  "paths.ts": { forbids: ["./index.ts", "./render.ts"], pureOfIo: false },
  "index.ts": { forbids: [], pureOfIo: false },
};

for (const [file, rule] of Object.entries(RULES)) {
  const path = join(root, file);
  const source = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  check(`${file} exists`, source !== undefined);
  if (source === undefined) continue;
  const specifiers = specifiersOf(source);

  const violations = [
    ...specifiers.filter((s) => rule.forbids.includes(s)),
    ...(rule.pureOfIo ? specifiers.filter((s) => isBuiltin(s)) : []),
  ];
  check(
    `${file} respects its layer rule`,
    violations.length === 0,
    `forbidden: ${violations.join(", ")}`,
  );

  // A split that leaves a stale relative path behind fails here instead of at
  // an import-time crash inside a suite.
  const dangling = specifiers.filter(
    (s) => s.startsWith("./") && !existsSync(join(root, s)),
  );
  check(
    `${file} has no dangling relative import`,
    dangling.length === 0,
    dangling.join(", "),
  );
}

// The module set is read from disk, not written down: a new top-level file must
// declare a rule before it can exist, and a removed one leaves no stale entry.
const onDisk = readdirSync(root)
  .filter((name) => name.endsWith(".ts"))
  .sort();
const declared = Object.keys(RULES).sort();
check(
  "every top-level module declares a layer rule",
  declared.join() === onDisk.join(),
  `declared=${declared.join(",")} on-disk=${onDisk.join(",")}`,
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
