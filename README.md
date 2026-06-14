# intent

AI code provenance tracking for Claude Code. Captures **why** code was written —
the decision, the workaround, the tradeoff — anchored to git **blob hashes** so it
survives line drift. Stored in a per-repo SQLite db at `.git/intent.db`.

Ships as a single **Bun-compiled binary** (`bun:sqlite` built in) — **no Node, no
dependencies, no flags**. Just drop the binary in and run it.

---

## Quick start

Get the two skill folders (`intent/` + `intent-backfill/`), drop them into a
`.claude/skills/` dir, then run the binary's own installer. Two ways to get them:

### Option A — download a release

Grab `intent-skill-<platform>.{tar.gz,zip}` from
[Releases](../../releases) for your OS/arch (e.g. `darwin-arm64`, `linux-x64`,
`windows-x64`) and extract it into a `.claude/skills/` dir:

```sh
mkdir -p ~/.claude/skills        # all repos (or <project>/.claude/skills for one)
tar -xzf intent-skill-darwin-arm64.tar.gz -C ~/.claude/skills
# Windows: unzip intent-skill-windows-x64.zip into the skills dir
```

### Option B — build from source

Needs [Bun](https://bun.sh). Produces a binary for *your current OS*:

```sh
bun install
bun run bundle                   # → bundle/intent/ + bundle/intent-backfill/
cp -R bundle/intent bundle/intent-backfill ~/.claude/skills/
```

### Then: make it executable + install

```sh
cd ~/.claude/skills/intent       # or <project>/.claude/skills/intent

# macOS/Linux only: mark executable + clear the macOS download quarantine
chmod +x intent
xattr -d com.apple.quarantine intent 2>/dev/null || true   # macOS, downloaded binaries

./intent install                 # wire hooks into ~/.claude (all repos)

# variants:
./intent install --project          # wire into ./.claude (this repo only)
./intent install --dry-run          # preview, change nothing
./intent install --no-commit-hook   # skip the post-commit git hook
```

On Windows: `.\intent.exe install`. The installer is idempotent — re-run it any
time and it self-heals. To run `intent` from your own terminal, add the folder to
PATH or symlink the binary (the installer prints the exact command).

That's it. Open Claude Code in a git repo and provenance is now wired.

---

## What `intent install` actually does

1. **Claude Code hooks** — merges three hooks into `settings.json`, each invoking
   the binary at its absolute path (`"<binary>" hook`) — no PATH shims, so they
   fire on macOS, Linux *and* Windows:
   | Event | Behaviour |
   |-------|-----------|
   | `SessionStart` | Injects a short repo provenance summary. |
   | `PreToolUse` (edits) | Injects existing provenance for the file about to be edited, so Claude doesn't re-solve prior decisions. |
   | `PostToolUse` (edits) | **Nudges** Claude to capture *why* via `intent annotate`. |
2. **Post-commit git hook** — installs a fail-safe `post-commit` hook in the
   current repo that backfills `commit_hash` onto captured intents (never blocks a
   commit). Skip with `--no-commit-hook`; soft-skipped outside a git repo.

> **Note:** the PostToolUse hook only *nudges* — it does **not** write to the db
> automatically. Provenance is recorded when Claude (or you) actually runs
> `intent annotate`. That's by design: only Claude can synthesise the *why*.

Because the hooks and the git hook point at the binary's absolute path, they're
fully PATH-independent — they even fire from GUI git clients (Fork, Rider,
SourceTree…) that don't source your shell's environment.

---

## Using it

Once installed, just talk to Claude — or drive the CLI yourself:

| Want | Command |
|------|---------|
| Why does this line exist? | `intent show <file>:<line>` |
| Full provenance for a file | `intent file <path>` |
| Search by topic | `intent search "<terms>"` |
| What did a session do? | `intent session <session-id>` |
| Repo summary | `intent stats` |
| Dump everything (ndjson) | `intent export` |
| Recover provenance from past sessions | `intent backfill-transcript` |

Capture (usually Claude does this, prompted by the hook):

```sh
intent annotate --json - <<'EOF'
{ "file": "src/auth.ts", "line_start": 42, "line_end": 50,
  "summary": "Retry with backoff on 429",
  "detail": "Provider rate-limits bursts; exponential backoff avoids tripping it." }
EOF
```

**Lost provenance?** If a change's *why* was never captured live, it may still be latent in
Claude Code's session transcripts (`~/.claude/projects/<repo>/*.jsonl`). Two ways to recover it:

- **`/intent-backfill` skill** (recommended) — Claude reads the matched candidates, synthesises a
  tight *why* per edit, and records them (preserving the original session + date). Good summaries.
- **`intent backfill-transcript`** — the deterministic CLI underneath: records every past edit
  whose content still matches the current tree, with the raw reasoning verbatim.

Either way it's best-effort: edits later overwritten can't be re-anchored.

See [`skill/SKILL.md`](skill/SKILL.md) for the full CLI surface and capture
convention, and [`docs/claude-code-integration.md`](docs/claude-code-integration.md)
for the hook wiring details.

---

## Development

Needs [Bun](https://bun.sh).

```sh
bun test           # bun test
bun run typecheck  # tsc --noEmit
bun run build      # → bin/intent[.exe] (current OS)
bun run build:all  # → release/ (all 5 targets)
bun run bundle     # build + assemble bundle/intent/ + bundle/intent-backfill/
bun run bundle --release   # cross-compile + package release/*.{tar.gz,zip}
```

Releases are cut by tagging (`git tag v0.2.0 && git push --tags`) — see
[`.github/workflows/release.yml`](.github/workflows/release.yml).

This repo builds the bundle but **doesn't run intent on itself** (no hooks; the
skill source lives in `skill/`). See [`CLAUDE.md`](CLAUDE.md) for architecture and
[`specs/`](specs/) for the design history.
