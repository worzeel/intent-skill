import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./exec.js";

export interface HashOptions {
  /**
   * Write the blob into git's object store (`hash-object -w`). Without this the
   * hash is computed but the content is NOT retrievable later via cat-file
   * unless it gets committed. We write by default so anchors stay resolvable
   * even before a commit (see Anchor Strategy in the spec).
   */
  write?: boolean;
}

/** Blob hash of a working-tree file, as git would compute it on `git add`. */
export async function hashFile(
  repoRoot: string,
  relPath: string,
  opts: HashOptions = {},
): Promise<string> {
  const args = ["hash-object"];
  if (opts.write) args.push("-w");
  args.push("--", relPath);
  const out = await runGit(args, { cwd: repoRoot });
  return out.trim();
}

/** Blob hash of arbitrary in-memory content (e.g. an edit not yet on disk). */
export async function hashContent(
  repoRoot: string,
  content: string,
  opts: HashOptions = {},
): Promise<string> {
  const args = ["hash-object", "--stdin"];
  if (opts.write) args.push("-w");
  const out = await runGit(args, { cwd: repoRoot, input: content });
  return out.trim();
}

/** True if a blob with this hash exists in the object store. */
export async function blobExists(repoRoot: string, blobHash: string): Promise<boolean> {
  try {
    await runGit(["cat-file", "-e", `${blobHash}^{blob}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/** Retrieve the content of a stored blob. Throws if the blob is missing. */
export async function getBlob(repoRoot: string, blobHash: string): Promise<string> {
  return runGit(["cat-file", "-p", blobHash], { cwd: repoRoot });
}

export type AnchorStatus =
  | "exact" // working file is byte-identical to the captured blob
  | "fragment" // file drifted, but the captured fragment was relocated by text match
  | "drifted" // file changed and the fragment could not be relocated
  | "missing"; // working file no longer exists on disk

export interface AnchorInput {
  /** Path relative to the repo root. */
  filePath: string;
  /** Blob hash captured at write time. */
  blobHash: string;
  /** Captured text snippet, used to relocate lines after drift. */
  fragment?: string | null;
  /** Captured line range — a hint only, trusted only when the blob is unchanged. */
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface ResolvedAnchor {
  status: AnchorStatus;
  /** Current 1-based line range, or null when it cannot be determined. */
  lineStart: number | null;
  lineEnd: number | null;
  /** Blob hash of the working file right now, or null if the file is gone. */
  currentBlobHash: string | null;
}

/**
 * Resolve where a captured anchor currently lives in the working tree.
 *
 * Strategy, in order of trust (matches the spec's Anchor Strategy):
 *  1. If the working file's blob hash equals the captured hash, the file is
 *     unchanged → the stored line range is exact.
 *  2. Otherwise, if a fragment was captured, relocate it by text search →
 *     report the matched range.
 *  3. Otherwise the anchor has drifted and we fall back to the stored hint.
 */
export async function resolveAnchor(
  repoRoot: string,
  anchor: AnchorInput,
): Promise<ResolvedAnchor> {
  const absPath = path.resolve(repoRoot, anchor.filePath);

  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return {
      status: "missing",
      lineStart: anchor.lineStart ?? null,
      lineEnd: anchor.lineEnd ?? null,
      currentBlobHash: null,
    };
  }

  const currentBlobHash = await hashFile(repoRoot, anchor.filePath);

  if (currentBlobHash === anchor.blobHash) {
    return {
      status: "exact",
      lineStart: anchor.lineStart ?? null,
      lineEnd: anchor.lineEnd ?? null,
      currentBlobHash,
    };
  }

  if (anchor.fragment) {
    const located = locateFragment(content, anchor.fragment);
    if (located) {
      return {
        status: "fragment",
        lineStart: located.start,
        lineEnd: located.end,
        currentBlobHash,
      };
    }
  }

  return {
    status: "drifted",
    lineStart: anchor.lineStart ?? null,
    lineEnd: anchor.lineEnd ?? null,
    currentBlobHash,
  };
}

/**
 * Find the 1-based line range of `fragment` within `content`. Returns the first
 * occurrence, or null if absent. Multi-line fragments are supported.
 */
export function locateFragment(
  content: string,
  fragment: string,
): { start: number; end: number } | null {
  const idx = content.indexOf(fragment);
  if (idx === -1) return null;

  const start = countLines(content.slice(0, idx));
  const span = fragment.split("\n").length;
  return { start, end: start + span - 1 };
}

/** 1-based line number of the character immediately after `prefix`. */
function countLines(prefix: string): number {
  let lines = 1;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix.charCodeAt(i) === 10 /* \n */) lines++;
  }
  return lines;
}
