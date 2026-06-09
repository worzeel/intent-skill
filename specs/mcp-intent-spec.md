# mcp-intent — Initial Specification

> AI code provenance tracking for Claude Code.  
> Captures *why* code was written, not just *what* changed, anchored to git blob hashes for stability across line drift.

---

## Problem Statement

Git tells you what changed and when. It does not tell you why a line exists, what requirement it served, what tradeoffs were considered, or which Claude Code session produced it. This context lives only in ephemeral chat history, if it survives at all.

`mcp-intent` attaches semantic intent metadata to code changes at the moment Claude writes them, anchored to git blob hashes rather than line numbers (which drift). Any future reader — human or Claude — can query the database and understand the provenance of any piece of code.

---

## Goals

- Zero friction: Claude captures intent automatically with no human intervention required
- Stable anchoring: blob hash + fragment text, not line numbers
- Per-repo first: simple, local, no dependencies beyond SQLite
- Cross-repo capable: export format and optional central aggregator
- Useful to Claude itself: fed back into context at session start to prevent re-solving solved problems or contradicting prior decisions

---

## Non-Goals (v1)

- Real-time sync or collaboration (out of scope for v1)
- IDE plugin (CLI + MCP is sufficient for v1)
- Automatic commit hook installation (optional, not forced)

---

## Storage

### Location

`.git/intent.db` — SQLite, per-repo, adjacent to `.git/` internals.

- Not committed to the repo
- Add `.git/intent.db` note to project onboarding docs / README if desired
- Survives branch switches; tied to the working copy, not a branch

### Schema

```sql
-- One record per logical task / user request / Claude session intent
CREATE TABLE intent (
  id          TEXT PRIMARY KEY,   -- uuid v4
  session_id  TEXT,               -- Claude Code session ID (see Open Questions)
  summary     TEXT NOT NULL,      -- short label, e.g. "Add retry logic to API client"
  detail      TEXT,               -- fuller explanation: why, tradeoffs, what it's for, constraints considered
  task_ref    TEXT,               -- optional: ticket/issue/PR ref if mentioned in conversation (e.g. "GH-142")
  created_at  INTEGER NOT NULL    -- unix timestamp
);

-- One record per file+blob range anchored to an intent
CREATE TABLE intent_line (
  id          TEXT PRIMARY KEY,
  intent_id   TEXT NOT NULL REFERENCES intent(id),
  file_path   TEXT NOT NULL,      -- relative to repo root
  blob_hash   TEXT NOT NULL,      -- git blob hash of the file at time of change
  commit_hash TEXT,               -- git commit hash (nullable until committed; backfilled by git hook)
  line_start  INTEGER,            -- line range at time of writing (human hint only, not trusted for resolution)
  line_end    INTEGER,
  fragment    TEXT                -- short text snippet from the changed lines (fallback if blob resolution fails)
);

CREATE INDEX idx_intent_line_file ON intent_line(file_path);
CREATE INDEX idx_intent_line_blob ON intent_line(blob_hash);
CREATE VIRTUAL TABLE intent_fts USING fts5(
  summary, detail, content=intent, content_rowid=rowid
);
```

### Anchor Strategy

The **blob hash** is the primary stable anchor. It is derived via `git hash-object <file>` at the time of writing (pre-commit), so it is available immediately without waiting for a commit.

Line numbers (`line_start`, `line_end`) are stored as a human-readable hint only. At query time, current line positions are re-derived by running `git blame` and matching against the stored blob hash.

The **fragment** field (a small excerpt of the changed lines) provides a last-resort fallback for cases where blob resolution fails (deleted files, force-pushes, history rewrites).

---

## MCP Tools

### Write-Side (called by Claude during/after edits)

#### `annotate_intent`
```
annotate_intent(
  file: string,
  line_start: int,
  line_end: int,
  summary: string,
  detail: string,
  task_ref?: string
) → intent_id: string
```
Primary capture tool. Claude calls this automatically after any significant file write or edit. Internally resolves the blob hash via `git hash-object`, stores the fragment, and creates both an `intent` and `intent_line` record.

#### `update_intent`
```
update_intent(
  intent_id: string,
  detail: string,
  append: boolean = true
) → void
```
For multi-edit tasks within a session — amends the detail of an existing intent record rather than creating a duplicate. `append: true` adds to existing detail; `append: false` replaces it.

---

### Read-Side (called by Claude at session start, or by human tooling)

#### `get_intent`
```
get_intent(
  file: string,
  line: int
) → intent[]
```
Returns all intent records whose blob/line range covers the given line in its current state. Resolves current position via `git blame` at query time.

#### `search_intent`
```
search_intent(
  query: string,
  file?: string,
  limit?: int = 20
) → intent[]
```
Full-text search across `summary` and `detail` using the FTS5 index. Optional `file` filter to scope to a single file. Returns matching intent records with current resolved file/line positions.

#### `get_file_intent`
```
get_file_intent(
  file: string
) → intent[]
```
Returns all intent records for an entire file, ordered by current line position. Useful for a full provenance view of a file before making changes to it.

#### `get_session_intent`
```
get_session_intent(
  session_id: string
) → intent[]
```
All intent records created in a given Claude Code session — useful for reconstructing what a session actually did and why.

---

## Auto-Capture Behaviour

Claude Code uses these hooks automatically — no manual invocation required:

1. **On file write or edit** — Claude calls `annotate_intent` with a summary synthesised from the current conversation: the user's request, the problem being solved, any constraints or tradeoffs discussed. Captures blob hash immediately (pre-commit).

2. **On session start (files about to be touched)** — Claude calls `get_file_intent` for any files it is about to work on, and injects relevant provenance into its own context window before making changes. Prevents contradicting prior decisions or re-solving already-solved problems.

3. **On commit (optional git hook)** — A `post-commit` hook backfills `commit_hash` on any `intent_line` records where `commit_hash IS NULL`, matching by `blob_hash`. Included in the MCP server setup but not forced.

### Significance Threshold

Not every file write warrants a detailed intent record. Claude should apply judgment:

- **Record**: new functions, modified business logic, architectural decisions, workarounds, anything with a non-obvious reason
- **Skip or minimal record**: formatting-only passes, whitespace changes, import reordering, auto-generated files

---

## CLI Tool

A thin CLI wrapping the same SQLite queries, for human use outside Claude Code sessions.

```bash
# Intent at a specific line (current position resolved automatically)
intent show src/ApiClient.cs:333

# Full-text search across all intent records
intent search "retry logic"

# Full provenance history for a file
intent log src/ApiClient.cs

# What did a specific Claude Code session do?
intent session <session-id>

# Export for cross-repo tooling
intent export --format json --output intent-export.json

# Show stats for the repo
intent stats
```

---

## Cross-Repo Layer (future / separate tool)

A second tool, `mcp-intent-central`, ingests exports from multiple per-repo DBs into a central store (SQLite or Postgres). Exposes the same read-side MCP tools but scoped across repos.

Use cases:
- Features that span multiple repos
- Organisation-wide "why does this pattern exist?" queries
- Audit trail across a microservices estate

Kept deliberately separate — per-repo tool stays zero-dependency and zero-config.

Export format is newline-delimited JSON so it can be streamed and partially ingested.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Blob hash as primary anchor | Survives rebases, cherry-picks, file renames (with `--follow`), branch switches |
| Line numbers stored but not trusted | Human readability and initial fragment capture only; always re-resolved at query time |
| SQLite at `.git/intent.db` | Zero config, not committed, stays with the working copy |
| Claude auto-captures, never prompts | Friction kills adoption; if it requires human action it won't get used consistently |
| Fragment text stored | Fallback for deleted files, force-pushes, or history rewrites where blob lookup fails |
| FTS5 index on summary + detail | Full-text search without a separate search engine dependency |
| Pre-commit blob hash | Available immediately after file write via `git hash-object`; no need to wait for commit |

---

## Open Questions

These need resolution before or during initial implementation. Please add your thoughts below each.

---

**Q1. Session ID availability**  
Does Claude Code expose a stable, queryable session ID via environment variable or MCP context? Or do we generate our own UUID per session and store it in a temp file / env var at session start?

*Thoughts:*

---

**Q2. Blob hash timing**  
Capture the blob hash pre-commit (via `git hash-object` on the written file immediately after write) or post-commit? Pre-commit is earlier and requires no git commit to have happened, but the file must exist on disk. Is there any edge case where pre-commit blob hash would not match the eventual committed blob hash (e.g. line-ending normalisation via `.gitattributes`)?

*Thoughts:*

---

**Q3. Noise filtering — significance threshold**  
Should Claude apply a significance threshold automatically (skipping formatting passes, whitespace changes etc.), or record everything and rely on search/filtering at query time? Recording everything is simpler but may produce noise that degrades search quality over time.

*Thoughts:*

---

**Q4. Encryption / privacy**  
The `detail` field may contain sensitive business context (requirement names, customer references, architecture decisions). Should encryption at rest be a first-class v1 option, or deferred? If deferred, is there a simpler redaction mechanism (e.g. a `--no-detail` flag for capture)?

*Thoughts:*

---

**Q5. Multi-file intents**  
A single user request often touches multiple files (e.g. "add a new endpoint" modifies controller, service, DTO, migration). The current schema handles this — one `intent` record, multiple `intent_line` records. But should there be a concept of an "intent group" or "change set" that explicitly links all the files touched by one logical task, separate from a session?

*Thoughts:*

---

## Implementation Stack (proposed)

- **Language**: TypeScript (Node.js) — consistent with Claude Code's own ecosystem
- **MCP framework**: `@anthropic-ai/sdk` MCP server primitives
- **DB**: `better-sqlite3` (synchronous, no async complexity for local SQLite)
- **CLI**: `commander` or `yargs`
- **Git interaction**: `simple-git` or direct `child_process` calls to git CLI

---

## Milestones

| # | Milestone | Description |
|---|---|---|
| 1 | Core DB + schema | SQLite setup, migrations, blob hash resolution |
| 2 | MCP server (write-side) | `annotate_intent`, `update_intent` tools |
| 3 | MCP server (read-side) | `get_intent`, `search_intent`, `get_file_intent`, `get_session_intent` |
| 4 | Auto-capture hooks | Claude Code integration, session-start context injection |
| 5 | CLI tool | Human-facing query interface |
| 6 | Git post-commit hook | Backfill `commit_hash` on pending records |
| 7 | Export format + cross-repo | JSON export, `mcp-intent-central` stub |
