# intent

AI code provenance tracking for Claude Code. Captures *why* code was written, anchored to git blob hashes (stable across line drift), in a per-repo SQLite db at `.git/intent.db`.

- Spec: [specs/mcp-intent-spec.md](specs/mcp-intent-spec.md) — original spec. Current direction: [specs/cli-pivot-plan.md](specs/cli-pivot-plan.md) (pivot from MCP server to a droppable `intent` CLI/skill).
- Stack: TypeScript (ESM, NodeNext), `node:sqlite` (built-in, sync — zero runtime deps), git via `child_process`, `vitest`.

## Layout
- `src/git/` — git plumbing: `exec` (runGit), `repo` (root/git-dir), `blob` (hash + anchor resolution).
- `src/db/` — `schema` (versioned migrations), `connection` (open/migrate/`transaction`), `intents` (data access).
- `src/capture.ts` — write-side business logic (git + db), transport-agnostic.
- `src/query.ts` — read-side service: queries + query-time line resolution via `resolveAnchor`.
- `src/cli/` — `parse` (arg parser) + `format` (human/`--json`) + `commands` + `main` (`bin: intent`).
- `src/hooks/` — `handler` (Claude Code hook logic) + `cli` (`bin: intent-hook`).
- `src/index.ts` — public API barrel. `src/types.ts` — domain types.
- `.claude/skills/intent/SKILL.md` — `/intent` skill. `examples/` + [docs/claude-code-integration.md](docs/claude-code-integration.md) — hooks config.

## Commands
- `npm test` — vitest (runs with `--experimental-sqlite`). `npm run typecheck`. `npm run build` → `dist/`.
- CLI: `intent <show|file|search|session|stats|export|annotate|update>` — run from inside a git repo. `intent --help`.
- Writes (`annotate`/`update`) take a JSON payload on stdin. `MCP_INTENT_SESSION_ID`/`INTENT_SESSION_ID` env sets the session id.

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
- **Phase 7 done**: droppable skill bundle — `npm run bundle` → `bundle/intent/` (SKILL.md + dist + `install.mjs`).
  `install.mjs` wires hooks + PATH shims, idempotent, `--dry-run`/`--project`/`--bin-dir`/`--settings`.
- **Next**: Phase 8 post-commit backfill (`commit_hash` where NULL, matched by `blob_hash`).

Hooks (`intent-hook`): SessionStart → repo provenance summary; PreToolUse(edits) → existing intent
for the target file; PostToolUse(edits) → nudge to `intent annotate`. Context injected via
`hookSpecificOutput.additionalContext`; fail-safe (errors exit 0, never blocks the session). Paths
canonicalised (realpath both ends) so a symlinked cwd doesn't reject in-repo files.
