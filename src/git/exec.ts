import { spawn } from "node:child_process";

export interface GitRunOptions {
  /** Working directory the git command runs in. */
  cwd: string;
  /** Optional data piped to git's stdin (e.g. for `hash-object --stdin`). */
  input?: string;
}

export class GitError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code ?? "null"}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Run a git command and resolve with its stdout. Rejects with {@link GitError}
 * on a non-zero exit. Kept deliberately thin — every git interaction in the
 * project funnels through here so failures are uniform and testable.
 */
export async function runGit(args: readonly string[], opts: GitRunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args as string[], { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(args, code, stderr));
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
