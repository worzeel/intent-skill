# mcp-intent

AI code provenance tracking for Claude Code. Captures *why* code was written, anchored to git blob hashes (stable across line drift), in a per-repo SQLite db at `.git/intent.db`.

- Spec: [specs/mcp-intent-spec.md](specs/mcp-intent-spec.md) — source of truth, milestones at the bottom.
- Stack: TypeScript (ESM, NodeNext), `better-sqlite3` (sync), git via `child_process`, `vitest`.

## Layout
- `src/git/` — git plumbing: `exec` (runGit), `repo` (root/git-dir), `blob` (hash + anchor resolution).
- `src/db/` — `schema` (versioned migrations) + `connection` (open/migrate).
- `src/index.ts` — public API barrel. `src/types.ts` — domain types.

## Commands
- `npm test` — vitest. `npm run typecheck`. `npm run build` → `dist/`.

## Status
- **Milestone 1 done**: core DB + schema + migrations + blob-hash resolution.
- Next: M2 write-side MCP tools (`annotate_intent`, `update_intent`).
