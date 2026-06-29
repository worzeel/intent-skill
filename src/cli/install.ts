import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isGitRepo, getRepoRoot } from "../git/repo.js";
import { mergeHooks, hookCommand } from "../hooks/settings.js";
import { installCommitHook } from "./commands.js";
import { parseArgs } from "./parse.js";

/**
 * `intent install` — self-installing setup, replacing the old `node install.mjs`.
 * The compiled binary wires its own absolute path (`process.execPath`) into:
 *   1. Claude Code's settings.json as the SessionStart/Pre/PostToolUse hooks
 *      (command: `"<binary>" hook`) — no PATH shim needed, fires on every OS.
 *   2. a post-commit git hook in the current repo (skipped with --no-commit-hook
 *      or when not inside a repo).
 *
 *   intent install                 ~/.claude/settings.json (all repos)
 *   intent install --project       ./.claude/settings.json (this repo)
 *   intent install --settings P    an explicit settings.json
 *   intent install --dry-run       print the plan, write nothing
 *   intent install --no-commit-hook  skip the post-commit git hook
 */

const INSTALL_BOOLEAN_FLAGS = new Set(["project", "dry-run", "help"]);

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function settingsPathFor(flags: Record<string, string | boolean>): string {
  if (typeof flags.settings === "string") return path.resolve(flags.settings);
  if (flags.project === true) return path.join(process.cwd(), ".claude", "settings.json");
  return path.join(os.homedir(), ".claude", "settings.json");
}

export async function runInstall(argv: readonly string[]): Promise<string> {
  const parsed = parseArgs(argv, INSTALL_BOOLEAN_FLAGS);
  if (parsed.flags.help === true) return INSTALL_HELP;

  const binPath = process.execPath;
  const hookCmd = hookCommand(binPath);
  const settingsPath = settingsPathFor(parsed.flags);
  const dryRun = parsed.flags["dry-run"] === true;
  // --no-commit-hook sets commit-hook=false (parser camelCases? no — keep as `commit-hook`).
  const wantCommitHook = parsed.flags["commit-hook"] !== false;
  const inRepo = await isGitRepo(process.cwd());

  const plan = [`hooks  ${settingsPath}  (command: ${hookCmd})`];
  if (wantCommitHook) {
    plan.push(
      inRepo
        ? "git    post-commit hook in this repo (intent backfill)"
        : "git    post-commit hook skipped (not inside a git repo)",
    );
  }

  if (dryRun) {
    return "DRY RUN — no changes:\n" + plan.map((l) => "  " + l).join("\n");
  }

  // 1. Merge hooks into settings.json, preserving everything else.
  const merged = mergeHooks(readJson(settingsPath), hookCmd);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");

  // 2. Post-commit git hook (this repo only). Soft-skip outside a repo.
  let commitLine: string | null = null;
  if (wantCommitHook && inRepo) {
    try {
      commitLine = await installCommitHook(await getRepoRoot(process.cwd()));
    } catch (err) {
      commitLine = `git hook skipped: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const lines = ["Installed intent:", ...plan.map((l) => "  " + l)];
  if (commitLine) lines.push("  " + commitLine);

  // PATH hint: hooks use the absolute path, but a human typing `intent` needs it
  // discoverable. We don't write shims — just point the way.
  const binDir = path.dirname(binPath);
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDir)) {
    lines.push(
      "",
      `Tip: to run \`intent\` from your terminal, add it to PATH or symlink it:`,
      process.platform === "win32"
        ? `  setx PATH "${binDir};%PATH%"`
        : `  ln -s "${binPath}" ~/.local/bin/intent`,
    );
  }

  return lines.join("\n");
}

const INSTALL_HELP = `intent install — wire Claude Code hooks + the post-commit git hook.

  intent install [--project] [--settings PATH] [--dry-run] [--no-commit-hook]

  --project         target ./.claude/settings.json (default: ~/.claude, all repos)
  --settings PATH   explicit settings.json to merge hooks into
  --dry-run         print the plan, write nothing
  --no-commit-hook  don't install the post-commit git hook for this repo

The hook command is the binary itself ("<binary>" hook), wired at its absolute
path — no PATH shims, fires on macOS, Linux and Windows alike.`;
