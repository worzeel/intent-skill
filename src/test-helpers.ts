import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "./git/exec.js";

export interface TempRepo {
  root: string;
  cleanup: () => Promise<void>;
}

/** Create an isolated, initialised git repo in a temp dir for tests. */
export async function makeTempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-intent-"));
  await runGit(["init", "-q", "-b", "main"], { cwd: root });
  await runGit(["config", "user.email", "test@example.com"], { cwd: root });
  await runGit(["config", "user.name", "Test"], { cwd: root });
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
