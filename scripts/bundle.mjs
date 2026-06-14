#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { ROOT, TARGETS, currentKey, compileBinary } from "./targets.mjs";

/**
 * Assemble the droppable `intent` skill bundle around the compiled binary.
 *
 *   bun run scripts/bundle.mjs            # current platform → bundle/
 *   bun run scripts/bundle.mjs --release  # all targets → release/*.{tar.gz,zip}
 *
 * The bundle is two skill folders you drop into a `.claude/skills/` dir:
 *
 *   intent/            SKILL.md + the `intent` binary + README
 *   intent-backfill/   SKILL.md only (it drives the `intent` CLI)
 *
 * Then run the binary's own installer:  `intent install`  (see README).
 */

const README = `# intent — code provenance skill

Drop-in skill for Claude Code. Captures *why* code was written, anchored to git
blob hashes, in a per-repo SQLite db (\`.git/intent.db\`). Ships as a single
self-contained binary (Bun-compiled) — no Node, no dependencies, no flags.

## Install

1. Copy both skill folders into a \`.claude/skills/\` directory (\`~/.claude/skills/\`
   for all repos, or \`<project>/.claude/skills/\` for one repo):
   - \`intent/\` — the binary, README, and the \`/intent\` skill.
   - \`intent-backfill/\` — the \`/intent-backfill\` skill (reconstruct provenance
     from past session transcripts). Drives the \`intent\` binary, so no binary of its own.

2. **macOS/Linux only** — make the binary executable (and clear the macOS
   download quarantine, which otherwise blocks unsigned binaries):

   \`\`\`sh
   chmod +x intent/intent
   xattr -d com.apple.quarantine intent/intent 2>/dev/null || true   # macOS only
   \`\`\`

3. Run the binary's installer from the \`intent/\` folder:

   \`\`\`sh
   ./intent install                 # hooks into ~/.claude (all repos)
   ./intent install --project       # hooks into ./.claude (this repo only)
   ./intent install --dry-run       # preview, change nothing
   ./intent install --no-commit-hook   # skip the post-commit git hook
   \`\`\`

   On Windows: \`.\\intent.exe install\`.

This (1) wires the SessionStart / PreToolUse / PostToolUse Claude Code hooks at
the binary's absolute path (no PATH shims — fires on macOS, Linux and Windows),
and (2) installs a post-commit git hook in the current repo that backfills
\`commit_hash\` (skip with \`--no-commit-hook\`).

To run \`intent\` from your own terminal, add the folder to PATH or symlink the
binary into one (the installer prints the exact command).

**Heads up:** the PostToolUse hook only *nudges* Claude to run \`intent annotate\`
— it does not write to the db automatically. Provenance is captured when Claude
(or you) actually runs the annotate command. See \`SKILL.md\` for usage.
`;

/** Build into `<stage>/intent/` + `<stage>/intent-backfill/` for one target. */
function assembleInto(stage, key) {
  const intentDir = path.join(stage, "intent");
  rmSync(intentDir, { recursive: true, force: true });
  mkdirSync(intentDir, { recursive: true });

  copyFileSync(path.join(ROOT, "skill", "SKILL.md"), path.join(intentDir, "SKILL.md"));
  writeFileSync(path.join(intentDir, "README.md"), README);
  const binOut = path.join(intentDir, `intent${TARGETS[key].ext}`);
  compileBinary(key, binOut);
  if (TARGETS[key].ext === "") chmodSync(binOut, 0o755);

  const backfillDir = path.join(stage, "intent-backfill");
  rmSync(backfillDir, { recursive: true, force: true });
  mkdirSync(backfillDir, { recursive: true });
  copyFileSync(
    path.join(ROOT, "skill", "intent-backfill", "SKILL.md"),
    path.join(backfillDir, "SKILL.md"),
  );
}

/** Archive the two skill folders inside `stage` → release/intent-skill-<key>.<ext>. */
function archive(stage, key) {
  const releaseDir = path.join(ROOT, "release");
  mkdirSync(releaseDir, { recursive: true });
  const isWin = key.startsWith("windows");
  const out = path.join(releaseDir, `intent-skill-${key}.${isWin ? "zip" : "tar.gz"}`);
  rmSync(out, { force: true });

  const res = isWin
    ? spawnSync("zip", ["-r", "-q", out, "intent", "intent-backfill"], { cwd: stage, stdio: "inherit" })
    : spawnSync("tar", ["-czf", out, "-C", stage, "intent", "intent-backfill"], { stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(`archive failed for ${key} (need ${isWin ? "zip" : "tar"} on PATH)\n`);
    process.exit(res.status ?? 1);
  }
  return path.relative(ROOT, out);
}

const release = process.argv.includes("--release");

if (release) {
  const stage = path.join(ROOT, "release", ".stage");
  const made = [];
  for (const key of Object.keys(TARGETS)) {
    assembleInto(stage, key);
    made.push(archive(stage, key));
  }
  rmSync(stage, { recursive: true, force: true });
  process.stdout.write(`\nPackaged ${made.length} release archives:\n` + made.map((m) => "  " + m).join("\n") + "\n");
} else {
  const bundle = path.join(ROOT, "bundle");
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  assembleInto(bundle, currentKey());
  process.stdout.write(`\nBundle assembled at bundle/ (intent/, intent-backfill/)\n`);
}
