#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assemble the droppable `intent` skill bundle. Run after `npm run build`:
 *
 *   bundle/
 *     intent/
 *       SKILL.md        the /intent skill
 *       dist/           compiled JS (pure node:sqlite, no node_modules)
 *       install.mjs     one-shot setup (hooks + PATH shims + git hook)
 *       README.md       how to install
 *     intent-backfill/
 *       SKILL.md        the /intent-backfill skill (transcript → provenance)
 *
 * Copy each folder into a `.claude/skills/` dir (project or ~/.claude) and run
 * `node intent/install.mjs`. The intent-backfill skill drives the `intent` CLI,
 * so it needs no dist of its own.
 */

const README = `# intent — code provenance skill

Drop-in skill for Claude Code. Captures *why* code was written, anchored to git
blob hashes, in a per-repo SQLite db (\`.git/intent.db\`). Pure JS via node's
built-in \`node:sqlite\` — no native build, no dependencies.

## Install

1. Copy both skill folders into a \`.claude/skills/\` directory (\`~/.claude/skills/\`
   for all repos, or \`<project>/.claude/skills/\` for one repo):
   - \`intent/\` — the CLI, hooks, installer, and the \`/intent\` skill.
   - \`intent-backfill/\` — the \`/intent-backfill\` skill (reconstruct provenance
     from past session transcripts). Drives the \`intent\` CLI, so no dist of its own.
2. From the \`intent/\` folder, run the installer:

   \`\`\`sh
   node install.mjs              # hooks into ~/.claude (all repos)
   node install.mjs --project    # hooks into ./.claude (this repo only)
   node install.mjs --dry-run    # preview, change nothing
   node install.mjs --no-commit-hook   # skip the post-commit git hook
   \`\`\`

This (1) drops \`intent\` + \`intent-hook\` shims on PATH (~/.local/bin), (2) wires
the SessionStart / PreToolUse / PostToolUse Claude Code hooks, and (3) installs a
post-commit git hook in the current repo that backfills \`commit_hash\` (skip with
\`--no-commit-hook\`).

**Cross-platform.** Claude Code hooks run as direct \`node\` invocations, so they
fire on macOS, Linux *and* Windows (a POSIX shim can't be executed by cmd.exe /
PowerShell). On Windows the installer also writes \`intent.cmd\` + \`intent.ps1\`
alongside the POSIX shim so a bare \`intent\` resolves in cmd.exe and PowerShell.

**Heads up:** the PostToolUse hook only *nudges* Claude to run \`intent annotate\`
— it does not write to the db automatically. Provenance is captured when Claude
(or you) actually runs the annotate command. See \`SKILL.md\` for usage.
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bundle", "intent");

const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "cli", "main.js"))) {
  process.stderr.write("bundle: dist/ missing — run `npm run build` first.\n");
  process.exit(1);
}

rmSync(path.join(root, "bundle"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(dist, path.join(out, "dist"), { recursive: true });
copyFileSync(path.join(root, "skill", "SKILL.md"), path.join(out, "SKILL.md"));
copyFileSync(path.join(root, "scripts", "install.mjs"), path.join(out, "install.mjs"));
writeFileSync(path.join(out, "README.md"), README);

// Second skill: intent-backfill (SKILL.md only — it drives the intent CLI).
const backfillOut = path.join(root, "bundle", "intent-backfill");
mkdirSync(backfillOut, { recursive: true });
copyFileSync(
  path.join(root, "skill", "intent-backfill", "SKILL.md"),
  path.join(backfillOut, "SKILL.md"),
);

process.stdout.write(
  `Bundle assembled at ${path.relative(root, path.join(root, "bundle"))}/ (intent/, intent-backfill/)\n`,
);
