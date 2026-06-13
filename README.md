# intent

AI code provenance tracking for Claude Code. Captures **why** code was written —
the decision, the workaround, the tradeoff — anchored to git **blob hashes** so it
survives line drift. Stored in a per-repo SQLite db at `.git/intent.db`.

Pure JS over node's built-in `node:sqlite` — **no native build, no runtime deps**.

---

## Quick start

This repo is the **source**. You build a droppable bundle from it, then install
that bundle into any project (or globally) where you want provenance tracking.

### 1. Build the bundle

```sh
npm install
npm run bundle      # runs the build, then assembles bundle/intent/
```

That produces:

```
bundle/intent/
├── SKILL.md        the /intent skill
├── dist/           compiled JS (zero node_modules)
├── install.mjs     one-shot setup (hooks + CLI shims + git hook)
└── README.md       install notes
```

### 2. Drop it into a `.claude/` skills directory

Copy the **`bundle/intent/`** folder into a `.claude/skills/` dir — either:

- **`~/.claude/skills/intent/`** — available in *all* your repos, or
- **`<your-project>/.claude/skills/intent/`** — just that one repo.

```sh
# global (all repos)
mkdir -p ~/.claude/skills
cp -R bundle/intent ~/.claude/skills/intent

# …or per-project
mkdir -p /path/to/your-project/.claude/skills
cp -R bundle/intent /path/to/your-project/.claude/skills/intent
```

### 3. Run the installer

From inside the folder you just copied:

```sh
cd ~/.claude/skills/intent      # or <project>/.claude/skills/intent
node install.mjs                # wire hooks into ~/.claude (all repos)

# variants:
node install.mjs --project          # wire into ./.claude (this repo only)
node install.mjs --dry-run          # preview, change nothing
node install.mjs --no-commit-hook   # skip the post-commit git hook
```

The installer is idempotent — re-run it any time (e.g. after rebuilding the
bundle) and it self-heals.

### 4. Make sure `intent` is on your PATH

The installer drops the `intent` CLI shim in `~/.local/bin` by default. If that's
not on your PATH, it'll print exactly what to add. (`--bin-dir DIR` to put it
elsewhere.)

That's it. Open Claude Code in a git repo and provenance is now wired.

---

## What the installer actually does

1. **CLI shims** — drops `intent` + `intent-hook` on PATH so you (and Claude) can
   run `intent …` at a shell.
2. **Claude Code hooks** — merges three hooks into `settings.json` as direct
   `node` invocations:
   | Event | Behaviour |
   |-------|-----------|
   | `SessionStart` | Injects a short repo provenance summary. |
   | `PreToolUse` (edits) | Injects existing provenance for the file about to be edited, so Claude doesn't re-solve prior decisions. |
   | `PostToolUse` (edits) | **Nudges** Claude to capture *why* via `intent annotate`. |
3. **Post-commit git hook** — installs a fail-safe `post-commit` hook in the
   current repo that backfills `commit_hash` onto captured intents (never blocks a
   commit). Skip with `--no-commit-hook`.

> **Note:** the PostToolUse hook only *nudges* — it does **not** write to the db
> automatically. Provenance is recorded when Claude (or you) actually runs
> `intent annotate`. That's by design: only Claude can synthesise the *why*.

---

## Cross-platform (macOS / Linux / Windows)

One bundle, every platform — same `node install.mjs` command:

- **macOS / Linux** — POSIX `#!/bin/sh` shims; hooks call `node` directly.
- **Windows** — hooks call `node` directly too (a no-extension POSIX shim can't be
  run by cmd.exe / PowerShell), and the installer additionally writes `intent.cmd`
  + `intent.ps1` so a bare `intent` resolves in cmd.exe and PowerShell. The
  post-commit git hook stays `#!/bin/sh` — Git for Windows runs hooks through its
  own bundled bash regardless of OS.

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

Capture (usually Claude does this, prompted by the hook):

```sh
intent annotate --json - <<'EOF'
{ "file": "src/auth.ts", "line_start": 42, "line_end": 50,
  "summary": "Retry with backoff on 429",
  "detail": "Provider rate-limits bursts; exponential backoff avoids tripping it." }
EOF
```

See [`skill/SKILL.md`](skill/SKILL.md) for the full CLI surface and capture
convention, and [`docs/claude-code-integration.md`](docs/claude-code-integration.md)
for the hook wiring details.

---

## Development

```sh
npm test          # vitest (runs with --experimental-sqlite)
npm run typecheck # tsc --noEmit
npm run build     # → dist/
npm run bundle    # build + assemble bundle/intent/
```

This repo builds the bundle but **doesn't run intent on itself** (no hooks; the
skill source lives in `skill/`). See [`CLAUDE.md`](CLAUDE.md) for architecture and
[`specs/`](specs/) for the design history.
