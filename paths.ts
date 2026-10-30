/**
 * tower-do — project anchoring, config, and the per-project board cache
 * (path/cache layer).
 *
 * The board is shared per *project*, not per working directory, and it never
 * rides inside the repo: state lives under the global records home
 * `~/.pi/tower-do/<slug>-<hash>/`. This module owns the two lookups that make
 * that true (nearest git work-tree root, config path) plus the cache that maps
 * a cwd to its board entry.
 *
 * Layering: this file may touch the filesystem and the disk layer
 * (`./board.ts`), and must never import the extension (`./index.ts`) or the
 * render helpers (`./render.ts`). `./state.ts` stays pure — see
 * test/layering.ts, which enforces the direction.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  normalizeBoardConfig,
  TowerBoard,
  type TowerDoConfig,
} from "./board.ts";

interface BoardEntry {
  board: TowerBoard;
  config: TowerDoConfig;
}

// ---------------------------------------------------------------------------
// Project-root anchoring
//
// The board is shared per *project*, not per working directory. A project is
// the nearest ancestor that is a git work tree (a `.git` directory) or a git
// worktree/submodule (a `.git` *file*); when no git boundary exists, the
// directory itself is the project. So `cd /repo` and `cd /repo/src` sessions
// read and write the same board, while two unrelated directories stay
// isolated even when neither is under git.
// ---------------------------------------------------------------------------

function isGitMark(p: string): boolean {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return true;
    if (st.isFile()) {
      // A `.git` file marks a git worktree / submodule checkout; its content
      // is `gitdir: <path>`.
      return readFileSync(p, "utf8").startsWith("gitdir:");
    }
    return false;
  } catch {
    return false;
  }
}

const projectRootCache = new Map<string, string>();

/** Nearest git work-tree root for `cwd`, else `cwd` itself (directory = scope). */
function projectRoot(cwd: string): string {
  const cached = projectRootCache.get(cwd);
  if (cached !== undefined) return cached;
  let dir = cwd;
  for (;;) {
    if (isGitMark(join(dir, ".git"))) {
      projectRootCache.set(cwd, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  projectRootCache.set(cwd, cwd);
  return cwd;
}

/** Re-resolve project roots next session: the filesystem may have gained or
 *  lost a `.git` boundary since this session started (e.g. `git init`
 *  mid-session). Within a session the cache is deliberately stable — moving
 *  the board file mid-session would orphan earlier events (split-brain). */
export function resetProjectRootCache(): void {
  projectRootCache.clear();
}

/** Per-project state root under the global records home `~/.pi/tower-do/`:
 * the board file never rides inside a repo. The slug keeps the directory
 * readable; the path hash guarantees uniqueness (`/a/b` vs `/a_b` would slug
 * identically). */
function stateDirFor(cwd: string): string {
  const root = projectRoot(cwd);
  const slug =
    root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(homeDir(), ".pi", "tower-do", `${slug}-${hash}`);
}

export function boardFileFor(cwd: string): string {
  return join(stateDirFor(cwd), "board.jsonl");
}

/** $HOME resolved explicitly (POSIX semantics) instead of os.homedir(): Bun's
 * homedir() ignores the HOME override, which makes HOME-scoped tests
 * nondeterministic and silently reads the real user config. */
function homeDir(): string {
  return (
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir()
  );
}

/** Config lives beside pi's own config under `~/.pi/agent/`: a pinned
 * identity is a personal choice that applies across every board the user
 * touches, and keeping it out of the repo avoids leaking it through committed
 * files and per-project drift. */
function configFile(): string {
  return join(homeDir(), ".pi", "agent", "tower-do", "config.json");
}

function loadConfig(): TowerDoConfig {
  const path = configFile();
  if (!existsSync(path)) return {};
  // Fail loud, never silently default: a broken config would drop a pinned
  // identity and corrupt owner matching / message addressing in multi-agent
  // sessions. Annotate every failure with the path — JSON.parse and
  // normalizeBoardConfig errors alone do not carry it.
  try {
    return normalizeBoardConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `tower-do config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class BoardCache {
  private readonly entries = new Map<string, BoardEntry>();

  entryFor(cwd: string): BoardEntry {
    const file = boardFileFor(cwd);
    let entry = this.entries.get(file);
    if (entry === undefined) {
      entry = {
        board: new TowerBoard(file),
        config: loadConfig(),
      };
      this.entries.set(file, entry);
    }
    return entry;
  }
}
