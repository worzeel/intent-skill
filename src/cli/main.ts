#!/usr/bin/env node
import { openIntentDbForCwd } from "../db/connection.js";
import { getRepoRoot, isGitRepo } from "../git/repo.js";
import { runHook } from "../hooks/run.js";
import { runInstall } from "./install.js";
import { parseArgs } from "./parse.js";
import { runCommand, helpText, UsageError } from "./commands.js";

/**
 * Entry point for the `intent` CLI — the single human + Claude interface to the
 * per-repo intent database. Runs from inside a git repo; `INTENT_SESSION_ID`
 * (or legacy `MCP_INTENT_SESSION_ID`) tags captured intents with the session.
 *
 * The compiled binary is the only executable we ship, so the Claude Code hook
 * runner is folded in as the hidden `intent hook` subcommand (it reads the hook
 * event on stdin and must never break the session — errors exit 0).
 *
 * Exit codes: 0 ok, 1 runtime error, 2 usage error.
 */

const BOOLEAN_FLAGS = new Set(["json", "help", "dry-run"]);

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);

  // Help short-circuits before any git/db work.
  if (parsed.flags.help === true || parsed.command === "help" || parsed.command === undefined) {
    process.stdout.write(helpText() + "\n");
    return parsed.command === undefined ? 1 : 0;
  }

  const cwd = process.cwd();
  if (!(await isGitRepo(cwd))) {
    process.stderr.write("intent: not inside a git repository\n");
    return 1;
  }

  const repoRoot = await getRepoRoot(cwd);
  const sessionId =
    process.env.INTENT_SESSION_ID ?? process.env.MCP_INTENT_SESSION_ID ?? null;
  const db = await openIntentDbForCwd(cwd);

  try {
    const output = await runCommand({ db, repoRoot, sessionId }, parsed, { readStdin });
    if (output) process.stdout.write(output.endsWith("\n") ? output : output + "\n");
    return 0;
  } finally {
    db.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// `intent hook` is the Claude Code hook runner folded into the one binary. It
// has its own fail-safe contract (never break the session), so it bypasses the
// normal CLI arg parsing and error handling entirely.
if (process.argv[2] === "hook") {
  runHook()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("intent-hook:", error instanceof Error ? error.message : error);
      process.exit(0);
    });
} else if (process.argv[2] === "install") {
  // `intent install` wires hooks + the git hook. It works outside a git repo
  // (global installs), so it bypasses main()'s repo/db requirement.
  runInstall(process.argv.slice(3))
    .then((out) => {
      process.stdout.write(out.endsWith("\n") ? out : out + "\n");
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(
        `intent: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
} else {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof UsageError) {
        process.stderr.write(`intent: ${error.message}\n`);
        process.exit(2);
      }
      process.stderr.write(
        `intent: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
