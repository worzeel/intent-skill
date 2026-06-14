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
| Why does this line exist? | `intent show <file>:<line>` (falls back to `git blame` when nothing's recorded) |
| Full provenance for a file | `intent file <path>` (alias: `intent log <path>`) |
| Search by topic | `intent search "<terms>" [--file <f>] [--limit <n>]` |
| What did a session do? | `intent session <session-id>` |
| Repo summary | `intent stats` |
| Dump everything (ndjson) | `intent export` |

Add `--json` to any read command for machine-readable output; default is human text.
Resolved line positions are recomputed at query time, so they stay correct after a file drifts.

Paths are matched on a canonical repo-relative key (forward slashes, resolved from your cwd),
so any separator works and you can pass a bare filename — `intent file blob.ts` finds
`src/git/blob.ts` when the name is unambiguous.

## Capturing

Capture is **not** automatic — the PostToolUse hook only *nudges* after a significant edit; the
actual write happens when you (or the user) run `intent annotate`. Capture as you go, or in one
pass at the end of a task while the reasoning is still in context. Pipe a JSON payload to stdin. Use a **quoted heredoc** (`<<'EOF'`) so
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

Capture one **change/decision per intent**, scoped to a **tight line range** (a function, a
block — not the whole file). The anchor re-locates by matching that range's text, so a narrow
range survives edits elsewhere and `intent show <file>:<line>` can attribute each line to the
*right* decision. One fat whole-file intent breaks the moment anything in it changes (it drifts
and stops resolving), and makes every line answer the same useless "initial implementation".

## Append-only history — never edit the database

Intents are an **append-only provenance log**. Multiple intents for the same file or line over
time is **expected and correct** — it's the reasoning evolving across edits.

- **Never** delete, overwrite, or hand-edit `.git/intent.db` (no `sqlite3`, no raw SQL). There is
  no delete command on purpose.
- A newer intent for a region does **not** make an older one a duplicate to remove — the old one
  is the *history of why it used to be that way*. `intent file <path>` labels these as
  `# current` vs `# superseded`; superseded entries (`"superseded": true` in `--json`) are kept
  deliberately. Leave them.
- Correcting or extending a prior intent? Add a new intent, or `intent update` to append detail —
  don't destroy what's there.

## What to capture (the rationale, not the instruction)

Record the **engineering rationale** — the decision and the tradeoff behind it — not the
instruction you were handed. Write "chose X over Y because Z", not "user asked for X". This
matters most with multiple agents: when agents work through a decision the developer didn't
spell out (or wasn't watching), the intent should preserve *what was decided and why*, so the
reasoning survives even though no human typed it.

## Before editing a file

Run `intent file <path>` first to see prior decisions (the PreToolUse hook also injects this
automatically). Don't contradict or re-solve what's already there.

## Commit provenance (optional)

Intents are anchored to the git blob hash at capture time, so `commit_hash` is NULL until the
content is committed. To stamp it:

- `intent backfill` — stamps `commit_hash` on pending rows whose blob is in the HEAD commit.
- `intent install-commit-hook` — installs a fail-safe `post-commit` git hook that runs
  `intent backfill` automatically after every commit (never blocks a commit).

## Recover lost provenance from transcripts (optional)

If provenance was never captured live, it may still be latent in Claude Code's session
transcripts (`~/.claude/projects/<repo>/*.jsonl`). Mine it deterministically:

- `intent backfill-transcript` — auto-discovers this repo's transcripts and records an intent
  for every past edit whose content **still matches the current working tree** (best-effort;
  superseded edits can't be re-anchored). Pass a `.jsonl` file or directory to target specific
  transcripts. Reasoning is taken verbatim from the transcript, so summaries can be rough.
- For **good** summaries, use the **`/intent-backfill` skill** instead: it runs
  `intent backfill-transcript --dry-run` to get matched candidates, synthesises a tight *why*
  per edit, and writes them via `intent annotate` (preserving session id + original date).
