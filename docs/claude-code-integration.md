# Claude Code integration

Three moving parts wire `intent` into Claude Code:

1. **The `intent` CLI** (`bin: intent`) — capture + query over `.git/intent.db`. The single
   interface for both humans and Claude.
2. **The hook helper** (`bin: intent-hook`) — injects provenance into context automatically
   and nudges Claude to capture.
3. **The `/intent` skill** ([`.claude/skills/intent/SKILL.md`](../../.claude/skills/intent/SKILL.md)) —
   teaches Claude the CLI surface + capture convention for ad-hoc, human-driven queries.

Both bins are pure JS over `node:sqlite` — no native build, no runtime deps.
> Phase 7 will ship an `install.mjs` that wires all of this automatically. Until then, the
> steps below are manual.

## 1. Put the bins on PATH

During local dev, from the repo: `npm run build` then `npm link` (exposes `intent` +
`intent-hook`). Or reference the built entry directly, e.g.
`node --experimental-sqlite /abs/path/dist/cli/main.js`.

`node:sqlite` needs `--experimental-sqlite` on node < 23.4 (on newer node it just works). The
installed shims pass `--experimental-sqlite --no-warnings` so this is transparent.

Set `INTENT_SESSION_ID` (or `MCP_INTENT_SESSION_ID`) in the environment to stamp captures with
a session id.

## 2. Wire the hooks

Merge [`examples/settings.hooks.json`](../examples/settings.hooks.json) into your Claude Code
`settings.json` (project `.claude/settings.json` or user-level):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "intent-hook" }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "intent-hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "intent-hook" }] }
    ]
  }
}
```

One command handles every event — it branches on `hook_event_name` from the hook stdin payload.

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
