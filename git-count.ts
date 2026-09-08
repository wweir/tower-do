/**
 * git-count — pure derivation of dirty / session-modified file counts for the
 * TowerDo widget.
 *
 * Two numbers, same unit (adjusted file count), different viewpoint:
 *  - dirty:  entries in `git status --porcelain -z -uall`
 *            (tracked changes + untracked files; untracked dirs expanded).
 *            Rename/copy is one entry — the destination.
 *  - session: files whose content this session actually changed. First
 *            observation hashes every dirty path (real files only; missing
 *            or non-file paths use the `absent` sentinel). Later a path
 *            counts if its hash differs from that baseline, it is new, it
 *            left the dirty set with a blob different from the baseline, or
 *            it was committed since startHead with a blob different from the
 *            baseline. Pre-dirty files this session never edits do not count.
 *
 * No I/O here: the caller runs the git commands and hands over raw stdout.
 */

/** A `git status --porcelain -z -uall` output parsed into tracked-changed and
 * untracked file sets. Records are NUL-terminated, so paths are not C-quoted.
 * Rename/copy occupies two records (`XY dest\0orig\0`) and counts as one
 * dirty entry — the destination. */
export function parsePorcelain(output: string): {
 changed: string[];
 untracked: string[];
} {
 const changed: string[] = [];
 const untracked: string[] = [];
 const parts = output.split("\0");
 for (let i = 0; i < parts.length; i++) {
  const line = parts[i];
  if (line.length < 4) continue;
  const status = line.slice(0, 2);
  const path = line.slice(3);
  // Rename/copy: skip the original-path record that follows.
  if (status[0] === "R" || status[0] === "C") {
   changed.push(path);
   i += 1;
   continue;
  }
  if (status === "??") {
   untracked.push(path);
   continue;
  }
  changed.push(path);
 }
 return { changed, untracked };
}

/** Paths from `git diff --name-only -z` (NUL-terminated, no C-quoting). */
export function parseDiffNames(output: string): string[] {
 if (output === "") return [];
 return output.split("\0").filter((path) => path.length > 0);
}

/** Sentinel for deleted paths, untracked directories, and other non-files. */
export const ABSENT_HASH = "absent";

/** Pair `git hash-object --stdin-paths` stdout with the path list (same order). Length mismatch is a git failure — do not pad. */
export function zipHashObject(
 paths: string[],
 output: string,
): Map<string, string> | undefined {
 if (paths.length === 0) return new Map();
 const lines = output === "" ? [] : output.replace(/\n$/, "").split("\n");
 if (lines.length !== paths.length) return undefined;
 const hashes = new Map<string, string>();
 for (let i = 0; i < paths.length; i++) {
  hashes.set(paths[i], lines[i]);
 }
 return hashes;
}

/**
 * Paths whose content this session changed: dirty hash ≠ start hash (or new),
 * or left the dirty set / landed in startHead..HEAD with a blob ≠ start hash.
 * The caller unions the result into a persistent set. Hashing failures belong
 * to the caller.
 */
export function sessionTouchedDelta(
 currentHashes: ReadonlyMap<string, string>,
 startHashes: ReadonlyMap<string, string>,
 committedHashes: ReadonlyMap<string, string>,
): string[] {
 const touched: string[] = [];
 const seen = new Set<string>();
 const consider = (path: string, hash: string): void => {
  if (seen.has(path)) return;
  const start = startHashes.get(path);
  if (start !== undefined && start === hash) return;
  seen.add(path);
  touched.push(path);
 };
 for (const [path, hash] of currentHashes) consider(path, hash);
 for (const [path, hash] of committedHashes) consider(path, hash);
 return touched;
}

/** Header segment `mine N · dirty N`. `em` wraps numbers; `label` wraps viewpoint words.
 * Labels are self-describing (mine = files this session changed, dirty = worktree
 * dirty files); defaults keep the empty-segment gate on plain text. */
export function formatGitSegment(
 dirty: number,
 session: number,
 em: (n: number, which: "dirty" | "session") => string = String,
 label: (s: string) => string = (s) => s,
): string {
 if (dirty === 0 && session === 0) return "";
 return (
  label("mine ") +
  em(session, "session") +
  label(" · dirty ") +
  em(dirty, "dirty")
 );
}
