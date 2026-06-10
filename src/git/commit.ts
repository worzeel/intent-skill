import { runGit } from "./exec.js";

/**
 * Commit-level git helpers, used by the post-commit backfill: once content that
 * was captured pre-commit lands in a commit, we can stamp its `commit_hash`.
 */

/** Full SHA of HEAD. Rejects (via runGit) if the repo has no commits yet. */
export async function getHeadCommit(repoRoot: string): Promise<string> {
  const out = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  return out.trim();
}

/**
 * Blob hashes introduced (added/modified) by `commit`. Uses `diff-tree --root`
 * so the initial commit (no parent) is handled too. Deletions are skipped.
 */
export async function getCommitBlobs(repoRoot: string, commit: string): Promise<string[]> {
  const out = await runGit(
    ["diff-tree", "-r", "--root", "--no-commit-id", "--no-renames", commit],
    { cwd: repoRoot },
  );

  const blobs = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    // ":<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>"
    const meta = line.split("\t")[0] ?? "";
    const newSha = meta.split(/\s+/)[3];
    if (newSha && !/^0+$/.test(newSha)) blobs.add(newSha);
  }
  return [...blobs];
}
