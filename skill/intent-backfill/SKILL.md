---
name: intent-backfill
description: Reconstruct lost code provenance by mining this repo's past Claude Code session transcripts, synthesising a tight "why" for each recovered edit, and recording it in the intent db. Use when the user asks to backfill/recover/reconstruct intent or provenance from past sessions, or wishes earlier work had been captured.
---

# intent-backfill — reconstruct provenance from past sessions

Provenance that was never captured live is often still latent in Claude Code's
session transcripts (`~/.claude/projects/<repo>/*.jsonl`): every edit is recorded
with its file, its new content, and the reasoning text around it. This workflow
mines that, **synthesises a concise intent per edit**, and writes it to the db.

The CLI does the deterministic half (parse + re-anchor each edit to the *current*
working tree); **you do the synthesis** — turning raw, often rambling reasoning
into a tight summary worth keeping.

## Steps

### 1. Get the candidates

```sh
intent backfill-transcript --dry-run
```

This writes **nothing**. It prints JSON: `{ transcripts, candidates: [...] }`. Pass
a path (a `.jsonl` file or a directory) to target specific transcripts; with no
path it auto-discovers this repo's transcripts. Candidates are already matched to
current lines, de-duplicated, and filtered of trivial/out-of-repo edits. Each is:

```jsonc
{
  "file": "src/auth.ts",      // repo-relative, already located in the current tree
  "lineStart": 42, "lineEnd": 50,
  "sessionId": "76301eb9-…",  // pass through unchanged
  "createdAt": 1699999999,    // unix seconds — pass through to preserve the date
  "tool": "Edit",
  "reasoning": "…",           // verbatim assistant text around the edit (the raw why)
  "snippet": "…"              // first chars of the new code, to judge significance
}
```

If there are no candidates, say so and stop — nothing to recover.

### 2. Judge + synthesise

For each candidate, read `reasoning` + `snippet` and decide:

- **Skip** formatting/whitespace/rename/mechanical churn, generated files, and
  anything where the reasoning is just narration ("now let me run the tests") with
  no real *why*. Don't manufacture intent that isn't there.
- **Keep** new logic, workarounds, non-obvious decisions, tradeoffs, anything a
  future reader would be grateful to understand.

For kept candidates, write:
- `summary` — one tight line of *why this exists* (not "edited X"). Present tense.
- `detail` — 1–3 sentences of the actual reasoning/tradeoff, distilled from
  `reasoning`. Drop the conversational fluff.

### 3. Write each kept intent

Pipe a JSON payload per candidate to `intent annotate`. Pass `file`, the
`line_start`/`line_end`, **and** `session_id` + `created_at` straight from the
candidate so the provenance keeps its original session and date:

```sh
intent annotate --json - <<'EOF'
{ "file": "src/auth.ts", "line_start": 42, "line_end": 50,
  "summary": "Retry 429s with exponential backoff",
  "detail": "The provider rate-limits bursts; linear retries kept tripping it, so back off exponentially.",
  "session_id": "76301eb9-…", "created_at": 1699999999 }
EOF
```

The CLI re-resolves the blob hash + fragment from the current file at these lines,
so the anchor stays valid as the code drifts later.

### 4. Report

Tell the user how many candidates there were, how many you recorded, and how many
you skipped as insignificant (with a one-line reason for the skips if useful).

## Notes & limits

- **Best-effort.** Only edits whose content still matches the current tree are
  candidates; anything later overwritten can't be re-anchored and won't appear.
- **Idempotent.** Already-recorded `(session, file, range)` edits are filtered out,
  so re-running won't duplicate.
- **Multi-file changes.** If several candidates are clearly one logical change,
  you may annotate the first to get an `intent_id`, then pass `"intent_id"` on the
  rest so they share one intent (see the `/intent` skill).
- The deterministic, no-synthesis path is `intent backfill-transcript` (no
  `--dry-run`) — it stores the raw reasoning verbatim. Use this skill when you want
  the summaries to actually be good.
