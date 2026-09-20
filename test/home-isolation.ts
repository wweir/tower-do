/**
 * Static regression: any test that loads the real extension (index.ts) must
 * point HOME at a throwaway directory first. Otherwise the extension's
 * `~/.pi/tower-do/` state dir is created against the developer's REAL home,
 * and test fixtures accumulate as stray boards (the observed
 * `tmp-tower-do-vfold-*` / `tmp-tower-do-vneeds-*` residue under
 * `~/.pi/tower-do/`).
 *
 * This is a bug guard, not a runtime GC: the fix is per-test HOME isolation
 * (see test/smoke.ts, test/limits.ts, test/identity-scope.ts). The extension
 * itself must never delete a user's state directory.
 *
 * Run: bun test/home-isolation.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

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

const HOME_SCOPED = ["smoke.ts", "limits.ts", "identity-scope.ts"];
const LOADS_EXTENSION = /["']\.\.\/index\.ts["']/;
// A STATIC import is hoisted and evaluated before any top-level statement, so a
// file that assigns HOME in its body and imports index.ts at the top still runs
// the extension against the real home — the check above would pass while the
// isolation it claims is not in effect. Only `await import()` after the
// assignment actually isolates.
const STATIC_IMPORT =
  /^\s*import\s+(?:[^;]*?from\s+)?["']\.\.\/index\.ts["']/m;
// The assignment must actually create a throwaway directory, not just clear or
// reassign HOME: `HOME=""` makes `homedir()` fall back to the REAL home.
const HOME_TEMP_ASSIGN = /process\.env\.HOME\s*=\s*mkdtempSync\s*\(/;
// A dynamic import must run AFTER the assignment. `search` gives the first
// occurrence in source order, which is the execution order for top-level
// statements.
const DYNAMIC_IMPORT = /import\s*\(\s*["']\.\.\/index\.ts["']\s*\)/;

/** True only when the file assigns a temp HOME and its dynamic import runs after it. */
function isolatesHome(source: string): boolean {
  const homeAt = source.search(HOME_TEMP_ASSIGN);
  const importAt = source.search(DYNAMIC_IMPORT);
  return homeAt !== -1 && importAt !== -1 && homeAt < importAt;
}

for (const name of readdirSync(testDir).sort()) {
  if (!name.endsWith(".ts") || name === "home-isolation.ts") continue;
  const source = readFileSync(join(testDir, name), "utf8");
  const loadsExtension = LOADS_EXTENSION.test(source);
  if (!loadsExtension) continue;
  check(
    `${name} isolates HOME before loading the extension`,
    isolatesHome(source),
    "add `process.env.HOME = mkdtempSync(...)` before `await import(\"../index.ts\")`",
  );
  check(
    `${name} loads the extension dynamically, after the HOME assignment`,
    !STATIC_IMPORT.test(source),
    'use `await import("../index.ts")` instead of a static import',
  );
}

// The files known to load the extension are exactly the isolated whitelist —
// a NEW loader outside the whitelist would have failed the loop above, and a
// removed one is a stale entry here.
for (const name of HOME_SCOPED) {
  const source = readFileSync(join(testDir, name), "utf8");
  check(
    `${name} is a real HOME-isolated dynamic loader`,
    LOADS_EXTENSION.test(source) &&
      isolatesHome(source) &&
      !STATIC_IMPORT.test(source),
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
