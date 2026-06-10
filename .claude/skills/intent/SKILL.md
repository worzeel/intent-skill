---
name: intent
description: Query or capture code provenance (why code was written) for this repo via the `intent` CLI. Use when the user asks why a line/file/function exists, what a past decision or tradeoff was, what a Claude session did, or asks to record why a change was made.
---

# intent — code provenance

`intent` is a per-repo CLI over `.git/intent.db`. It records *why* code was written,
anchored to git blob hashes so it survives line drift. Run it from anywhere inside the repo.

## Querying (most common)

| Need | Command |
|---|---|
| Why does this line exist? | `intent show <file>:<line>` |
| Full provenance for a file | `intent file <path>` (alias: `intent log <path>`) |
| Search by topic | `intent search "<terms>" [--file <f>] [--limit <n>]` |
| What did a session do? | `intent session <session-id>` |
| Repo summary | `intent stats` |
| Dump everything (ndjson) | `intent export` |

Add `--json` to any read command for machine-readable output; default is human text.
Resolved line positions are recomputed at query time, so they stay correct after a file drifts.

## Capturing

Capture is normally automatic — the PostToolUse hook nudges after a significant edit.
To record manually, pipe a JSON payload to stdin. Use a **quoted heredoc** (`<<'EOF'`) so
multiline detail, quotes and apostrophes pass through without shell mangling, and so the
command still starts with `intent` for permission allow-listing:

```bash
intent annotate --json - <<'EOF'
{"file":"src/api.ts","line_start":40,"line_end":58,
 "summary":"Add retry with backoff to the API client",
 "detail":"Upstream flakes under load; 3 retries with jitter chosen over a circuit breaker to keep it simple.",
 "task_ref":"GH-142"}
EOF
```

Required fields: `file`, `line_start`, `line_end`, `summary`.
Optional: `detail`, `task_ref`, `intent_id`, `session_id`.

- Pass `intent_id` (returned by a prior `annotate`) to attach several files to **one** logical task.
- Amend later: `intent update --json -` with `{"intent_id":"…","detail":"…","append":true}`.

## When to capture (significance threshold)

- **Record**: new functions, changed business logic, architectural decisions, workarounds,
  anything with a non-obvious reason.
- **Skip**: formatting, whitespace, import reordering, generated files, trivial renames.

## Before editing a file

Run `intent file <path>` first to see prior decisions (the PreToolUse hook also injects this
automatically). Don't contradict or re-solve what's already there.
