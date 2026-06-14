# intent

AI code provenance tracking for Claude Code. Captures *why* code was written, anchored to git blob hashes (stable across line drift), in a per-repo SQLite db at `.git/intent.db`.

- Specs: [specs/mcp-intent-spec.md](specs/mcp-intent-spec.md) (original) → [specs/cli-pivot-plan.md](specs/cli-pivot-plan.md) (MCP→CLI pivot) → [specs/bun-migration-plan.md](specs/bun-migration-plan.md) (Node→Bun, single-file binary).
- Stack: **Bun** (runtime + build + test), TypeScript (ESM, NodeNext), `bun:sqlite` (built-in, sync — zero runtime deps), git via `child_process`. Tests: `bun test`. Ships as a single `bun build --compile` binary.

## Layout
- `src/git/` — git plumbing: `exec` (runGit), `repo` (root/git-dir), `blob` (hash + anchor resolution).
- `src/db/` — `schema` (versioned migrations), `connection` (open/migrate/`transaction`; `bun:sqlite` `Database`, `strict:true`, `PRAGMA foreign_keys=ON`), `intents` (data access).
- `src/capture.ts` — write-side business logic (git + db), transport-agnostic.
- `src/query.ts` — read-side service: queries + query-time line resolution via `resolveAnchor`.
- `src/cli/` — `parse` (arg parser) + `format` (human/`--json`) + `commands` + `install` (`intent install`) + `main` (the compiled binary entry; dispatches `hook`/`install` early, else runs a command).
- `src/hooks/` — `handler` (hook logic) + `run` (shared `runHook`, used by `intent hook` and the legacy `intent-hook` `cli`) + `settings` (settings.json hook merge).
- `src/index.ts` — public API barrel. `src/types.ts` — domain types.
- `skill/SKILL.md` — `/intent` skill source (bundled, not active in this repo). `examples/` + [docs/claude-code-integration.md](docs/claude-code-integration.md) — hooks config.
- `scripts/` — `targets.mjs` (shared compile targets) + `build.mjs` (raw binary) + `bundle.mjs` (skill folder / release archives). No installer script — `intent install` does it.

## Commands
- `bun test` (alias `npm test`). `bun run typecheck` (tsc --noEmit). `bun run build` → `bin/intent[.exe]` (current OS); `bun run build:all` / `bun run bundle --release` → all 5 targets. `bun run bundle` → `bundle/`.
- CLI: `intent <show|file|search|session|stats|export|annotate|update|backfill|backfill-transcript|install|install-commit-hook|hook>` — run from inside a git repo (`install`/`hook` excepted). `intent --help`.
- Writes (`annotate`/`update`) take a JSON payload on stdin. `INTENT_SESSION_ID` (legacy `MCP_INTENT_SESSION_ID`) env sets the session id.

## Status

Core (original milestones 1–3): DB + schema + migrations + blob-hash resolution; capture
(`annotateIntent`/`updateIntent`, optional `intent_id` for multi-file tasks) and query
(`getIntentAtLine`/`searchIntent`/`getFileIntent`/`getSessionIntent`/`getAllResolvedIntents`).
Lines re-resolved at query time (`exact`/`fragment`/`drifted`/`missing`; only exact+fragment count
for coverage). Search uses FTS5 bm25; free-text sanitised via `toFtsQuery`.

CLI-pivot plan ([specs/cli-pivot-plan.md](specs/cli-pivot-plan.md)):
- **Phase 1–3 done**: `intent` CLI; hook nudges name CLI commands; `/intent` skill.
- **Phase 4 done**: swapped `better-sqlite3` → `node:sqlite` (zero runtime deps).
- **Phase 5 done**: removed the MCP server (`src/mcp/`, SDK, zod, `.mcp.json`). `dependencies: {}`.
- **Phase 6 done**: renamed `mcp-intent`→`intent` (`INTENT_SESSION_ID` primary, old as fallback).
- **Phase 7 done**: droppable skill bundle — `bun run bundle` → `bundle/intent/` (SKILL.md + the compiled
  binary + README). Setup is the binary's own `intent install` (idempotent, `--dry-run`/`--project`/
  `--settings`/`--no-commit-hook`) — no separate installer script, no PATH shims.
- **Phase 8 done**: post-commit backfill — `intent backfill` + `intent install-commit-hook`; `src/backfill.ts`
  + `src/git/commit.ts`. Stamps `commit_hash` (NULL until committed) from HEAD's blobs.
- **Transcript backfill**: `intent backfill-transcript [path]` recovers latent provenance from Claude Code
  session transcripts (`~/.claude/projects/<encoded-repo-path>/*.jsonl`). `src/transcript.ts` parses the
  JSONL (defensively — schema is internal/undocumented) into edits + their reasoning text; `src/backfill-transcript.ts`
  re-anchors each edit to the *current* tree via `locateFragment` and annotates (dedup by session+file+range,
  idempotent, preserves the transcript timestamp via `AnnotateParams.createdAt`; paths realpath-canonicalised
  both ends). Best-effort: superseded edits won't match current content. Two layers:
  `resolveCandidates` does the deterministic match (no writes); `backfillFromEdits` writes raw reasoning verbatim.
- **LLM-synthesised backfill**: `intent backfill-transcript --dry-run` emits the matched, deduped candidates as
  JSON (resolved line range + reasoning + code snippet) instead of writing. The **`/intent-backfill` skill**
  (`skill/intent-backfill/SKILL.md`) consumes that: judges significance, synthesises a tight summary/detail per
  edit, and writes via `intent annotate --json -` (now accepts `created_at` + `session_id` to preserve
  provenance). Bundle ships two skill folders now: `bundle/intent/` (CLI+hooks+installer) and
  `bundle/intent-backfill/` (SKILL.md only — drives the CLI).
- **Pivot complete.** This repo is now the *source*: it builds the bundle but doesn't run intent on itself
  (no hooks; skill source lives in `skill/`).
- **Bun migration done** ([specs/bun-migration-plan.md](specs/bun-migration-plan.md)): Node+`node:sqlite`
  → Bun+`bun:sqlite`; tests on `bun test`; ships as a single `bun build --compile` binary (~58 MB,
  per-platform). Two distribution paths: source build (`bun run bundle` → current-OS skill folder) and
  GitHub Releases (`.github/workflows/release.yml`, tag-triggered, cross-compiles all 5 targets →
  `intent-skill-<key>.{tar.gz,zip}`). `intent-hook` folded into the one binary as `intent hook`.
- **Self-install** (`intent install`, `src/cli/install.ts`): wires the 3 Claude Code hooks into
  `settings.json` as `"<binary>" hook` at the binary's own `process.execPath` (`src/hooks/settings.ts`
  `mergeHooks`, idempotent + self-heals legacy node/shim commands) — no PATH shims, fires on every OS
  since it's a native executable. Installs the post-commit git hook by default (`--no-commit-hook` to
  skip; soft-skips outside a repo); that hook calls `"<binary>" backfill` directly — fully
  PATH-independent, fires from GUI git clients (Fork, Rider, SourceTree…) and Git-for-Windows bash.

Path keys (`src/git/paths.ts`, `toRepoRelative`): every `file_path` is stored + queried as a
canonical repo-relative POSIX key (forward slashes), normalised on write (capture + hook nudge)
and read (`show`/`file`/`search --file`, resolved against cwd). Fixes Windows backslash mismatches;
schema v2 migrates old rows. `getIntentLinesByFileLoose` adds a basename fallback so `intent file
blob.ts` matches `src/git/blob.ts` when the exact key misses (exact always wins).

Hooks (`intent hook`): SessionStart → repo provenance summary; PreToolUse(edits) → existing intent
for the target file; PostToolUse(edits) → nudge to `intent annotate`. Context injected via
`hookSpecificOutput.additionalContext`; fail-safe (errors exit 0, never blocks the session). Paths
canonicalised (realpath both ends) so a symlinked cwd doesn't reject in-repo files.
