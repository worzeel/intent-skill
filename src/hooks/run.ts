import { openIntentDbForCwd } from "../db/connection.js";
import { getRepoRoot, isGitRepo } from "../git/repo.js";
import { handleHook, type HookInput } from "./handler.js";

/**
 * Claude Code hook runner. Reads the hook event JSON on stdin, resolves intent
 * context, and prints a `hookSpecificOutput` JSON object on stdout for Claude
 * Code to inject. Shared by the `intent hook` subcommand (the compiled binary)
 * and the legacy `intent-hook` entry point.
 *
 * Hooks must never break the session: callers swallow any throw and exit 0.
 * The same handler serves SessionStart / PreToolUse / PostToolUse — it branches
 * on `hook_event_name` itself.
 */
export async function runHook(): Promise<void> {
  const input = await readInput();
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  if (!(await isGitRepo(cwd))) return;

  const repoRoot = await getRepoRoot(cwd);
  const db = await openIntentDbForCwd(cwd);

  try {
    const output = await handleHook({ db, repoRoot }, input);
    if (output.hookSpecificOutput) {
      process.stdout.write(JSON.stringify(output));
    }
  } finally {
    db.close();
  }
}

async function readInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}
