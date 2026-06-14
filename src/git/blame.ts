import { runGit } from "./exec.js";

/**
 * Git blame fallback for line provenance. When no recorded intent covers a line,
 * the commit that last touched it is still cheaper to surface than re-reading the
 * code — it gives the asker the commit message + author without spending tokens.
 */

export interface BlameLine {
  /** Full commit sha; all-zero when the line is an uncommitted local change. */
  commitHash: string;
  /** Commit subject line. */
  summary: string;
  /** Author name. */
  author: string;
  /** Author time, unix seconds. */
  authorTime: number;
  /** True when the line isn't committed yet (sha is all zeros). */
  uncommitted: boolean;
}

/**
 * Blame a single line of a file. Returns null when git can't blame it (file not
 * tracked, line out of range, not a repo) — callers treat that as "no provenance".
 */
export async function blameLine(
  repoRoot: string,
  filePath: string,
  line: number,
): Promise<BlameLine | null> {
  try {
    const out = await runGit(
      ["blame", "-L", `${line},${line}`, "--porcelain", "--", filePath],
      { cwd: repoRoot },
    );
    return parseBlamePorcelain(out);
  } catch {
    // Fail-safe: untracked file, bad line, detached weirdness — no blame, no throw.
    return null;
  }
}

/**
 * Parse `git blame --porcelain` output for a single line. The first line is
 * `<sha> <orig> <final> [<group-size>]`; header lines follow until the content
 * line (prefixed with a tab). Returns null when there's no parseable sha.
 */
export function parseBlamePorcelain(out: string): BlameLine | null {
  const lines = out.split("\n");
  const sha = (lines[0] ?? "").split(" ")[0] ?? "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;

  let summary = "";
  let author = "";
  let authorTime = 0;
  for (const l of lines.slice(1)) {
    if (l.startsWith("\t")) break; // reached the content line — headers are done
    if (l.startsWith("summary ")) summary = l.slice("summary ".length);
    else if (l.startsWith("author ")) author = l.slice("author ".length);
    else if (l.startsWith("author-time ")) {
      authorTime = Number(l.slice("author-time ".length)) || 0;
    }
  }

  return { commitHash: sha, summary, author, authorTime, uncommitted: /^0+$/.test(sha) };
}
