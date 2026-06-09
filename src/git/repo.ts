import { runGit } from "./exec.js";

/** Absolute path to the repository's working-tree root. */
export async function getRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  return out.trim();
}

/**
 * Absolute path to the `.git` directory. Uses `--absolute-git-dir` so it stays
 * correct inside worktrees and submodules where `.git` is a file, not a dir.
 */
export async function getGitDir(cwd: string): Promise<string> {
  const out = await runGit(["rev-parse", "--absolute-git-dir"], { cwd });
  return out.trim();
}

/** True if `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
    return out.trim() === "true";
  } catch {
    return false;
  }
}
