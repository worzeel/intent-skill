#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * One-shot setup for the `intent` skill bundle. Idempotent. Run it from inside
 * the bundle directory (the folder holding `dist/`):
 *
 *   node install.mjs                 wire hooks into ~/.claude (all repos)
 *   node install.mjs --project       wire hooks into ./.claude (this repo only)
 *   node install.mjs --dry-run       print what would change, touch nothing
 *   node install.mjs --bin-dir DIR   put the intent / intent-hook shims in DIR
 *   node install.mjs --settings P    target an explicit settings.json
 *   node install.mjs --no-commit-hook  skip the post-commit git hook
 *
 * It (1) drops `intent` + `intent-hook` shims on PATH (+ .cmd/.ps1 on Windows),
 * (2) merges the three Claude Code hooks into settings.json as direct `node`
 * invocations (portable to Windows, where a no-extension shim can't be exec'd),
 * and (3) installs a post-commit git hook in the current repo. Pure node, zero deps.
 */

const EVENTS = {
  SessionStart: null,
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit",
};

/**
 * True if a hooks entry is one we previously injected. Matches both the legacy
 * shim-based command (`.../intent-hook`) and the current node-based command
 * (`node ... .../hooks/cli.js`) so re-running self-heals an old install.
 */
function isIntentEntry(entry) {
  return (
    entry != null &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) =>
        h != null &&
        typeof h.command === "string" &&
        /intent-hook|hooks[\\/]+cli\.js/.test(h.command),
    )
  );
}

/**
 * Return a new settings object with our 3 hooks merged in. Drops any prior
 * intent-hook entries first (so re-running is idempotent and self-heals if the
 * shim path changed), and never touches foreign hooks or other settings keys.
 */
export function mergeHooks(settings, command) {
  const next = { ...settings };
  const hooks = { ...(next.hooks ?? {}) };

  for (const [event, matcher] of Object.entries(EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = existing.filter((entry) => !isIntentEntry(entry));
    const entry = matcher
      ? { matcher, hooks: [{ type: "command", command }] }
      : { hooks: [{ type: "command", command }] };
    hooks[event] = [...cleaned, entry];
  }

  next.hooks = hooks;
  return next;
}

/** A POSIX shim that execs node against a bundled entry, flags baked in. */
export function shimContent(targetJs) {
  return `#!/bin/sh\nexec node --experimental-sqlite --no-warnings ${JSON.stringify(targetJs)} "$@"\n`;
}

/**
 * A Windows `.cmd` shim. This is what makes a bare `intent` resolve in cmd.exe
 * *and* PowerShell — `.CMD` is in the default PATHEXT, whereas `.PS1` is not.
 */
export function shimCmd(targetJs) {
  return `@echo off\r\nnode --experimental-sqlite --no-warnings "${targetJs}" %*\r\n`;
}

/** A PowerShell `.ps1` shim, for folks who invoke it explicitly as `intent.ps1`. */
export function shimPs1(targetJs) {
  return `#!/usr/bin/env pwsh\nnode --experimental-sqlite --no-warnings "${targetJs.replace(/"/g, '`"')}" @args\n`;
}

/**
 * The Claude Code hook command. Calls node directly against the bundled entry
 * rather than routing through a no-extension POSIX shim — that shim can't be
 * executed by cmd.exe/PowerShell, which is why hooks silently no-op on Windows.
 * `node` is on PATH on every platform, so this one line runs everywhere.
 */
export function hookCommand(targetJs) {
  return `node --experimental-sqlite --no-warnings ${JSON.stringify(targetJs)}`;
}

function parseArgs(argv) {
  const flags = {
    project: false,
    dryRun: false,
    binDir: null,
    settings: null,
    help: false,
    commitHook: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") flags.project = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--no-commit-hook") flags.commitHook = false;
    else if (a === "--bin-dir") flags.binDir = argv[++i];
    else if (a === "--settings") flags.settings = argv[++i];
  }
  return flags;
}

/** Locate the bundled `dist/` — as a sibling of this script, or one level up. */
function resolveDist(scriptDir) {
  for (const candidate of [path.join(scriptDir, "dist"), path.join(scriptDir, "..", "dist")]) {
    if (existsSync(path.join(candidate, "cli", "main.js"))) return candidate;
  }
  return null;
}

function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const dist = resolveDist(scriptDir);
  if (!dist) {
    process.stderr.write("install: can't find dist/ — build the bundle first (npm run bundle).\n");
    return 1;
  }

  const binDir = flags.binDir
    ? path.resolve(flags.binDir)
    : path.join(os.homedir(), ".local", "bin");
  const settingsPath = flags.settings
    ? path.resolve(flags.settings)
    : flags.project
      ? path.join(process.cwd(), ".claude", "settings.json")
      : path.join(os.homedir(), ".claude", "settings.json");

  const isWindows = os.platform() === "win32";
  const shims = [
    { name: "intent", target: path.join(dist, "cli", "main.js") },
    { name: "intent-hook", target: path.join(dist, "hooks", "cli.js") },
  ].map((s) => ({ ...s, shimPath: path.join(binDir, s.name) }));
  const hookTarget = shims.find((s) => s.name === "intent-hook").target;
  const hookCmd = hookCommand(hookTarget);

  const plan = [
    ...shims.flatMap((s) => shimPlan(s, isWindows)),
    `hooks ${settingsPath}  (command: ${hookCmd})`,
  ];
  if (flags.commitHook) plan.push(`git   post-commit hook in this repo (intent backfill)`);

  if (flags.dryRun) {
    process.stdout.write("DRY RUN — no changes:\n" + plan.map((l) => "  " + l).join("\n") + "\n");
    return 0;
  }

  // 1. Shims on PATH (POSIX always; .cmd + .ps1 on Windows so a bare `intent`
  //    resolves in cmd.exe / PowerShell too).
  mkdirSync(binDir, { recursive: true });
  for (const s of shims) writeShim(s, isWindows);

  // 2. Hooks into settings.json (preserving everything else). The command is a
  //    direct node invocation, so it fires on every platform.
  const merged = mergeHooks(readJson(settingsPath), hookCmd);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");

  // 3. The post-commit git hook (this repo only). Delegates to the CLI so the
  //    hook body / foreign-hook handling lives in one place.
  const commitHookLine = flags.commitHook ? installCommitHook(dist) : null;

  process.stdout.write("Installed intent:\n" + plan.map((l) => "  " + l).join("\n") + "\n");
  if (commitHookLine) process.stdout.write(commitHookLine + "\n");

  const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(binDir);
  if (!onPath) {
    const hint = isWindows
      ? `  $env:PATH = "${binDir};$env:PATH"   # session\n` +
        `  setx PATH "${binDir};$env:PATH"      # persist`
      : `  export PATH="${binDir}:$PATH"`;
    process.stderr.write(
      `\nNote: ${binDir} is not on your PATH. Add it so \`intent\` resolves:\n${hint}\n`,
    );
  }
  return 0;
}

/** Plan lines describing the shim file(s) we'd write for one entry. */
function shimPlan(s, isWindows) {
  const lines = [`shim  ${s.shimPath}  ->  ${s.target}`];
  if (isWindows) {
    lines.push(`shim  ${s.shimPath}.cmd`, `shim  ${s.shimPath}.ps1`);
  }
  return lines;
}

/** Write the POSIX shim (always) plus Windows .cmd/.ps1 variants when on win32. */
function writeShim(s, isWindows) {
  writeFileSync(s.shimPath, shimContent(s.target));
  chmodSync(s.shimPath, 0o755);
  if (isWindows) {
    writeFileSync(`${s.shimPath}.cmd`, shimCmd(s.target));
    writeFileSync(`${s.shimPath}.ps1`, shimPs1(s.target));
  }
}

/**
 * Run `intent install-commit-hook` against the current repo via node. Returns a
 * status line, or a soft note if we're not in a git repo (global installs).
 * Never aborts the install — a failed git hook shouldn't sink the shims/hooks.
 */
function installCommitHook(dist) {
  const mainJs = path.join(dist, "cli", "main.js");
  try {
    const out = execFileSync(
      process.execPath,
      ["--experimental-sqlite", "--no-warnings", mainJs, "install-commit-hook"],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim();
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString().trim();
    return `git hook skipped: ${msg.split("\n").pop() || "not a git repo"}`;
  }
}

const HELP = `intent installer — wires the skill bundle's hooks + CLI shims.

  node install.mjs [--project] [--dry-run] [--no-commit-hook]
                   [--bin-dir DIR] [--settings PATH]

  --project         target ./.claude/settings.json (default: ~/.claude, all repos)
  --dry-run         print planned changes, write nothing
  --no-commit-hook  don't install the post-commit git hook for this repo
  --bin-dir DIR     where to write intent / intent-hook shims (default: ~/.local/bin)
  --settings P      explicit settings.json to merge hooks into

Claude Code hooks are wired as direct \`node\` invocations (portable to Windows).
On Windows, .cmd + .ps1 shims are written alongside the POSIX shim so a bare
\`intent\` resolves in cmd.exe and PowerShell.`;

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
