# Claude Code integration

Three moving parts wire `intent` into Claude Code:

1. **The `intent` binary** — capture + query over `.git/intent.db`. The single interface for both
   humans and Claude. A single Bun-compiled executable (`bun:sqlite` built in) — no Node, no deps.
2. **The hook subcommand** (`intent hook`) — injects provenance into context automatically and
   nudges Claude to capture. Folded into the one binary; branches on the hook event internally.
3. **The `/intent` skill** ([`.claude/skills/intent/SKILL.md`](../../.claude/skills/intent/SKILL.md)) —
   teaches Claude the CLI surface + capture convention for ad-hoc, human-driven queries.

> **`intent install` wires all of this automatically** (it's a subcommand of the binary). The
> manual steps below are the fallback / explainer.

## 1. Get the binary

Download a release archive (`intent-skill-<platform>.{tar.gz,zip}`) and extract it into a
`.claude/skills/` dir, or build from source with [Bun](https://bun.sh): `bun run bundle`. On
macOS/Linux, `chmod +x intent` (and clear the macOS quarantine on downloaded binaries:
`xattr -d com.apple.quarantine intent`). Then `./intent install` does the rest.

To run `intent` from a shell, add its folder to PATH or symlink the binary into one — the
installer prints the exact command. No `node`, no `--experimental-sqlite` flag: it's a native
executable.

Set `INTENT_SESSION_ID` (or legacy `MCP_INTENT_SESSION_ID`) in the environment to stamp captures
with a session id.

## 2. Wire the hooks

`intent install` writes these for you. To do it by hand, merge
[`examples/settings.hooks.json`](../examples/settings.hooks.json) into your Claude Code
`settings.json` (project `.claude/settings.json` or user-level), using the binary's **absolute
path** plus the `hook` subcommand:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "/abs/.claude/skills/intent/intent hook" }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "/abs/.claude/skills/intent/intent hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "/abs/.claude/skills/intent/intent hook" }] }
    ]
  }
}
```

One command handles every event — it branches on `hook_event_name` from the hook stdin payload.

> **Portability.** Pointing at the binary's absolute path (rather than a bare name on PATH) means
> the hooks fire on macOS, Linux *and* Windows alike — it's a native executable, so there's no
> POSIX-shim-vs-cmd.exe problem. Quote the path if it contains spaces (`"\"<abs>/intent\" hook"`).

### What each hook does

| Event | Behaviour |
|-------|-----------|
| `SessionStart` | Injects a short repo summary (intent/file counts + 5 most recent) and a reminder to use the `intent` CLI. Silent when nothing is recorded. |
| `PreToolUse` (edits) | Injects existing provenance for the file about to be edited, so Claude doesn't contradict or re-solve prior decisions. Lines are re-resolved to current positions. Silent when the file has no recorded intent. |
| `PostToolUse` (edits) | Nudges Claude to run `intent annotate --json -` if the change was significant, with the target file pre-filled into the payload. |

Context is returned via `hookSpecificOutput.additionalContext`. The hook is **fail-safe**: any
error (not a git repo, no db, bad input) exits 0 with no output, so it can never block a session.

## 3. Capture convention (optional but recommended)

The harness surfaces provenance and nudges, but only Claude can synthesise the *why*. The
`/intent` skill documents this; you can also add it to the project `CLAUDE.md` so capture is
consistent:

> After any significant file change (new logic, a workaround, an architectural decision), run
> `intent annotate --json -` with a concise summary and the reasoning (JSON payload on stdin;
> a quoted heredoc keeps multiline detail clean). Skip formatting-only / whitespace /
> generated-file changes. Before editing a file, `intent file <path>` provenance is injected
> automatically — respect it.
