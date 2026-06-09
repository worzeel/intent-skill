# mcp-intent

AI code provenance tracking for Claude Code. Captures *why* code was written, anchored to git blob hashes (stable across line drift), in a per-repo SQLite db at `.git/intent.db`.

- Spec: [specs/mcp-intent-spec.md](specs/mcp-intent-spec.md) — source of truth, milestones at the bottom.
- Stack: TypeScript (ESM, NodeNext), `better-sqlite3` (sync), git via `child_process`, `vitest`.

## Layout
- `src/git/` — git plumbing: `exec` (runGit), `repo` (root/git-dir), `blob` (hash + anchor resolution).
- `src/db/` — `schema` (versioned migrations), `connection` (open/migrate), `intents` (data access).
- `src/capture.ts` — write-side business logic (git + db), transport-agnostic.
- `src/query.ts` — read-side service: queries + query-time line resolution via `resolveAnchor`.
- `src/mcp/` — `server` (MCP tool wiring) + `stdio` (entry point, `bin: mcp-intent-server`).
- `src/index.ts` — public API barrel. `src/types.ts` — domain types.

## Commands
- `npm test` — vitest. `npm run typecheck`. `npm run build` → `dist/`.
- MCP server: `mcp-intent-server` (stdio) — run from inside a git repo. `MCP_INTENT_SESSION_ID` env sets the session id.

## Status
- **Milestone 1 done**: core DB + schema + migrations + blob-hash resolution.
- **Milestone 2 done**: write-side MCP server — `annotate_intent`, `update_intent` (`@modelcontextprotocol/sdk`).
  - annotate_intent takes an optional `intent_id` to attach multi-file tasks to one intent (spec Q5).
- **Milestone 3 done**: read-side tools — `get_intent`, `search_intent`, `get_file_intent`, `get_session_intent`.
  - Lines re-resolved at query time (`exact`/`fragment`/`drifted`/`missing`); only exact+fragment count for line coverage.
  - `get_intent` returns current line positions even after the file drifts; results carry `original_*` + current `line_*`.
  - search uses FTS5 bm25; free-text queries sanitised via `toFtsQuery` (token-quote + AND) to dodge FTS syntax errors.
- Next: M4 auto-capture hooks (session-start context injection), then M5 CLI, M6 post-commit hook, M7 export.
