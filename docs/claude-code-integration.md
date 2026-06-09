# Claude Code integration (Milestone 4)

Two moving parts wire `mcp-intent` into Claude Code:

1. **The MCP server** (`mcp-intent-server`) exposes the capture/query tools.
2. **The hook helper** (`mcp-intent-hook`) injects provenance into context automatically.

Both ship as `bin` entries — `npm install -g mcp-intent` (or reference the built
paths directly during local dev, e.g. `node /abs/path/dist/mcp/stdio.js`).

## 1. Register the MCP server

Drop a `.mcp.json` at the repo root (see [`examples/.mcp.json`](../examples/.mcp.json)):

```json
{
  "mcpServers": {
    "intent": { "command": "mcp-intent-server" }
  }
}
```

The server is run from the repo, opens `.git/intent.db`, and serves:

- Write: `annotate_intent`, `update_intent`
- Read: `get_intent`, `search_intent`, `get_file_intent`, `get_session_intent`

Set `MCP_INTENT_SESSION_ID` in the server's env to stamp captures with a session id.

## 2. Wire the hooks

Merge [`examples/settings.hooks.json`](../examples/settings.hooks.json) into your
Claude Code `settings.json` (project `.claude/settings.json` or user-level):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "mcp-intent-hook" }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "mcp-intent-hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "mcp-intent-hook" }] }
    ]
  }
}
```

One command handles every event — it branches on `hook_event_name` from the hook
stdin payload.

### What each hook does

| Event | Behaviour |
|-------|-----------|
| `SessionStart` | Injects a short repo summary (intent/file counts + 5 most recent) and a reminder to use the tools. Silent when nothing is recorded. |
| `PreToolUse` (edits) | Injects existing provenance for the file about to be edited, so Claude doesn't contradict or re-solve prior decisions. Lines are re-resolved to current positions. Silent when the file has no recorded intent. |
| `PostToolUse` (edits) | Nudges Claude to call `annotate_intent` if the change was significant. |

Context is returned via `hookSpecificOutput.additionalContext`. The hook is
**fail-safe**: any error (not a git repo, no db, bad input) exits 0 with no output,
so it can never block a session.

## 3. Auto-capture instructions (optional but recommended)

The harness can surface provenance and nudge, but only Claude can synthesise the
*why*. Add to the project `CLAUDE.md` so capture is consistent:

> After any significant file change (new logic, a workaround, an architectural
> decision), call `annotate_intent` with a concise summary and the reasoning.
> Skip formatting-only / whitespace / generated-file changes. Before editing a
> file, the `get_file_intent` provenance is injected automatically — respect it.
