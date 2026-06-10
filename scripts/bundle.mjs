#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assemble the droppable `intent` skill bundle. Run after `npm run build`:
 *
 *   bundle/intent/
 *     SKILL.md        the /intent skill
 *     dist/           compiled JS (pure node:sqlite, no node_modules)
 *     install.mjs     one-shot setup (hooks + PATH shims)
 *     README.md       how to install
 *
 * Copy `bundle/intent/` into any `.claude/skills/` (project or ~/.claude) and
 * run `node intent/install.mjs`.
 */

const README = `# intent — code provenance skill

Drop-in skill for Claude Code. Captures *why* code was written, anchored to git
blob hashes, in a per-repo SQLite db (\`.git/intent.db\`). Pure JS via node's
built-in \`node:sqlite\` — no native build, no dependencies.

## Install

1. Copy this \`intent/\` folder into a \`.claude/skills/\` directory:
   - \`~/.claude/skills/intent/\` for all repos, or
   - \`<project>/.claude/skills/intent/\` for one repo.
2. From that folder, run the installer:

   \`\`\`sh
   node install.mjs            # hooks into ~/.claude (all repos)
   node install.mjs --project  # hooks into ./.claude (this repo only)
   node install.mjs --dry-run  # preview, change nothing
   \`\`\`

This drops \`intent\` + \`intent-hook\` shims on PATH (~/.local/bin) and wires the
SessionStart / PreToolUse / PostToolUse hooks. See \`SKILL.md\` for usage.
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

process.stdout.write(`Bundle assembled at ${path.relative(root, out)}/\n`);
