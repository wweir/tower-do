/**
 * tower-do config validation — proves config.json is fail-loud and reserved
 * identities cannot be claimed via config.
 *
 * Bug context: loadConfig used to swallow every error into defaults (a typo
 * silently dropped a pinned identity, corrupting owner matching in
 * multi-agent sessions), and identity validation accepted reserved identities
 * ("tower" = orchestrator, "all" = broadcast keyword), letting a session
 * bypass the owner guard or collide with broadcast addressing. The config
 * surface is `identity` only — retired numeric knobs must be ignored, not
 * rejected.
 *
 * Run: bun test/config.ts
 */
import { normalizeBoardConfig } from "../board.ts";

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

function expectThrows(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    check(label, false, "expected an error but none was thrown");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), message.slice(0, 140));
  }
}

// Absent key = defaults, no identity pin. The function receives parsed file
// content only (loadConfig short-circuits a missing file), so null-ish input
// is a loud error, not a silent default.
check(
  "empty object = defaults",
  normalizeBoardConfig({}).identity === undefined,
);

// Valid identity pins it; trimmed.
check(
  "identity is pinned (trimmed)",
  (() => {
    const config = normalizeBoardConfig({ identity: "  team-orchestrator  " });
    return config.identity === "team-orchestrator";
  })(),
);

// Reserved identity: config must not be able to masquerade as "tower" and
// bypass the owner guard.
expectThrows(
  "identity tower is rejected",
  () => normalizeBoardConfig({ identity: "tower" }),
  /reserved orchestrator identity "tower"/,
);
expectThrows(
  "identity all is rejected",
  () => normalizeBoardConfig({ identity: "all" }),
  /reserved broadcast recipient "all"/,
);

// Fail loud on invalid values instead of silently defaulting.
expectThrows(
  "non-string identity is rejected",
  () => normalizeBoardConfig({ identity: 42 }),
  /must be a string/,
);
expectThrows(
  "empty identity is rejected",
  () => normalizeBoardConfig({ identity: "   " }),
  /is required/,
);
expectThrows(
  "multi-line identity is rejected",
  () => normalizeBoardConfig({ identity: "a\nb" }),
  /single line/,
);
expectThrows(
  "over-long identity is rejected",
  () => normalizeBoardConfig({ identity: "x".repeat(65) }),
  /at most 64 characters/,
);
expectThrows(
  "non-object config is rejected",
  () => normalizeBoardConfig([1, 2]),
  /JSON object/,
);
expectThrows(
  "null config is rejected",
  () => normalizeBoardConfig(null),
  /JSON object/,
);

// Retired numeric knobs are ignored (forward compatibility), not rejected.
check(
  "unknown keys are ignored, identity still parsed",
  (() => {
    const config = normalizeBoardConfig({
      identity: "alice",
      reminderInterval: 99,
      collapsedTaskLimit: 1,
      activityTail: 50,
      messageRetention: 0,
      futureKey: true,
    });
    return config.identity === "alice";
  })(),
);

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
