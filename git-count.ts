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
 * Attribution re-anchors when HEAD moved externally — a non-ancestor move
 * (diverged pull / rebase / branch switch) — instead of folding foreign work
 * into `session`. Forward-only moves with few commits (fast-forward pull,
 * switch to a descendant branch) stay the accepted blind spot.
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
 /** Rename/copy origin → destination. The dirty entry is the destination, but
  * attribution needs the pair to avoid counting one rename twice. */
 renamed: Map<string, string>;
} {
 const changed: string[] = [];
 const untracked: string[] = [];
 const renamed = new Map<string, string>();
 const parts = output.split("\0");
 for (let i = 0; i < parts.length; i++) {
  const line = parts[i];
  if (line.length < 4) continue;
  const status = line.slice(0, 2);
  const path = line.slice(3);
  // Rename/copy: skip the original-path record that follows.
  if (status[0] === "R" || status[0] === "C") {
   const origin = parts[i + 1];
   if (origin !== undefined && origin.length > 0) renamed.set(origin, path);
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
 return { changed, untracked, renamed };
}

/**
 * Paths that left the dirty set, for the session viewpoint's "left with a
 * different blob" probe. A rename's ORIGIN is dropped when its destination is
 * still dirty: `dirty` counts a rename as one entry (the destination), so
 * counting the origin as a separate touched file would make `files` disagree
 * with `dirty` for a single `git mv` (the "same unit" contract).
 */
export function leftDirtyPaths(
 lastDirty: Iterable<string>,
 currentSet: ReadonlySet<string>,
 renamed: ReadonlyMap<string, string>,
): string[] {
 const left: string[] = [];
 for (const path of lastDirty) {
  if (currentSet.has(path)) continue;
  const destination = renamed.get(path);
  if (destination !== undefined && currentSet.has(destination)) continue;
  left.push(path);
 }
 return left;
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

/** A commit batch larger than this in one settle window is external (pull /
 * rebase / branch switch) even when the previous HEAD is an ancestor of the
 * new one: its roster is not folded into the session viewpoint and the
 * window re-anchors at the new HEAD. A fast-forward pull of few commits —
 * and a switch to a descendant branch with few commits — is the accepted
 * blind spot: forward-only moves carry no signal that distinguishes them
 * from the session's own commits short of tracking the branch ref, which
 * would mislabel a session-created branch as external. */
export const EXTERNAL_MOVE_MAX_COMMITS = 20;

/**
 * External-movement decision for the attribution window `lastHead..head`.
 * The caller hands over raw git facts (no I/O here):
 *  - `ancestor` false (lastHead is not an ancestor of head) → external:
 *    history was rewritten or the branch switched under us, so nothing in
 *    the window is this session's own forward progress. This catches a
 *    small branch switch (no merge, few commits), which merge/count signals
 *    alone would wrongly fold into `session`.
 *  - a merge commit in the window → external (a pull merged foreign work).
 *  - more than EXTERNAL_MOVE_MAX_COMMITS commits → external (big batch).
 * Otherwise the window is this session's own commits and stays attributed.
 */
export function headMoveIsExternal(facts: {
 /** lastHead reachable from head (`git merge-base --is-ancestor` exit 0). */
 ancestor: boolean;
 /** merge commits in `lastHead..head`. */
 merges: number;
 /** total commits in `lastHead..head`. */
 commits: number;
}): boolean {
 if (!facts.ancestor) return true;
 if (facts.merges > 0) return true;
 return facts.commits > EXTERNAL_MOVE_MAX_COMMITS;
}

/** Header segment `files N · dirty N`. `em` wraps numbers; `label` wraps viewpoint words.
 * Labels are self-describing (files = files this session changed, dirty = worktree
 * dirty files); defaults keep the empty-segment gate on plain text. The segment
 * shares a line with the board's task counts, so it must not spell a file count
 * with the same word the task layers use. */
export function formatGitSegment(
 dirty: number,
 session: number,
 em: (n: number, which: "dirty" | "session") => string = String,
 label: (s: string) => string = (s) => s,
): string {
 if (dirty === 0 && session === 0) return "";
 return (
  label("files ") +
  em(session, "session") +
  label(" · dirty ") +
  em(dirty, "dirty")
 );
}
