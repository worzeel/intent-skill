#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
 *
 * It (1) drops `intent` + `intent-hook` shims on PATH and (2) merges the three
 * hooks into the target settings.json, pointing them at the absolute shim path
 * so the hook needs nothing on PATH. Pure node, zero deps.
 */

const EVENTS = {
  SessionStart: null,
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit",
};

/** True if a hooks entry is one we previously injected (matched by command). */
function isIntentEntry(entry) {
  return (
    entry != null &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => h != null && typeof h.command === "string" && /intent-hook/.test(h.command),
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

function parseArgs(argv) {
  const flags = { project: false, dryRun: false, binDir: null, settings: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") flags.project = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--help" || a === "-h") flags.help = true;
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

  const shims = [
    { name: "intent", target: path.join(dist, "cli", "main.js") },
    { name: "intent-hook", target: path.join(dist, "hooks", "cli.js") },
  ].map((s) => ({ ...s, shimPath: path.join(binDir, s.name) }));
  const hookShim = shims.find((s) => s.name === "intent-hook").shimPath;

  const plan = [
    ...shims.map((s) => `shim  ${s.shimPath}  ->  ${s.target}`),
    `hooks ${settingsPath}  (command: ${hookShim})`,
  ];

  if (flags.dryRun) {
    process.stdout.write("DRY RUN — no changes:\n" + plan.map((l) => "  " + l).join("\n") + "\n");
    return 0;
  }

  // 1. Shims on PATH.
  mkdirSync(binDir, { recursive: true });
  for (const s of shims) {
    writeFileSync(s.shimPath, shimContent(s.target));
    chmodSync(s.shimPath, 0o755);
  }

  // 2. Hooks into settings.json (preserving everything else).
  const merged = mergeHooks(readJson(settingsPath), hookShim);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");

  process.stdout.write("Installed intent:\n" + plan.map((l) => "  " + l).join("\n") + "\n");

  const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(binDir);
  if (!onPath) {
    process.stderr.write(
      `\nNote: ${binDir} is not on your PATH. Add it so \`intent\` resolves:\n` +
        `  export PATH="${binDir}:$PATH"\n`,
    );
  }
  return 0;
}

const HELP = `intent installer — wires the skill bundle's hooks + CLI shims.

  node install.mjs [--project] [--dry-run] [--bin-dir DIR] [--settings PATH]

  --project      target ./.claude/settings.json (default: ~/.claude, all repos)
  --dry-run      print planned changes, write nothing
  --bin-dir DIR  where to write intent / intent-hook shims (default: ~/.local/bin)
  --settings P   explicit settings.json to merge hooks into`;

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
