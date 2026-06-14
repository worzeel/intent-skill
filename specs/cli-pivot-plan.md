# Plan — Pivot from MCP server to a droppable `intent` skill

> Status: **complete** (historical record). The runtime/distribution decisions below
> (`node:sqlite`, `install.mjs`, PATH shims) were later superseded by the Bun migration —
> see [bun-migration-plan.md](bun-migration-plan.md): `bun:sqlite`, a single compiled binary,
> and self-install via `intent install`.
> Originally superseded milestones M5–M7 in [mcp-intent-spec.md](mcp-intent-spec.md).
>
> Decisions:
> - Drop the MCP server entirely; rename `mcp-intent` → `intent`.
> - Hand-rolled zero-dep CLI as the single interface for humans + Claude.
> - **Swap `better-sqlite3` → `node:sqlite`** (built-in, sync, FTS5+bm25 verified) so the
>   tool is pure JS with zero runtime deps — no native compile, no `node_modules`.
> - Ship as a **self-contained skill bundle** droppable into any `.claude/skills/`
>   (project or `~/.claude`), with an `install.mjs` that wires hooks + PATH shims.

## Why

The thing is per-repo. Running a long-lived MCP server process for every repo on the
machine is silly when the work is "shell out to a tiny tool against `.git/intent.db`".

Three facts make this cheap:

1. **The core is already transport-agnostic** — `src/capture.ts` + `src/query.ts` hold all
   the logic; MCP was just a lid over them. The CLI bolts onto the identical functions.
2. **The hooks already bypass MCP** — `src/hooks/handler.ts` calls `db` + `query` directly,
   zero MCP dependency. The deterministic capture/inject loop survives untouched.
3. **`zod` + `@modelcontextprotocol/sdk` are confined to `src/mcp/`** — removing MCP drops
   the dependency tree to a single runtime dep: `better-sqlite3`.

## Target architecture

```mermaid
graph TD
    subgraph core["Core (transport-agnostic — unchanged)"]
        capture["capture.ts<br/>annotateIntent / updateIntent"]
        query["query.ts<br/>get* / search"]
        db["db/ + git/"]
        capture --> db
        query --> db
    end

    cli["src/cli/<br/>bin: intent"]
    hook["src/hooks/<br/>bin: intent-hook"]
    skill[".claude/skills/intent/<br/>/intent"]

    human(("Human")) --> cli
    cc(("Claude Code")) -. types /intent .-> skill
    skill --> cli
    cc -. shells out .-> cli
    cchooks(("CC hook events")) --> hook

    cli --> capture
    cli --> query
    hook --> query
    hook --> db

    classDef gone fill:#fdd,stroke:#c00,stroke-dasharray:5 5;
    mcp["src/mcp/ — DELETED<br/>+ @modelcontextprotocol/sdk, zod"]:::gone
```

Capture/inject loop after the pivot (no server process anywhere):

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as intent-hook
    participant CLI as intent (CLI)
    participant DB as .git/intent.db

    Note over CC,DB: Session start
    CC->>Hook: SessionStart
    Hook->>DB: stats + recent
    Hook-->>CC: additionalContext (provenance summary)

    Note over CC,DB: About to edit a file
    CC->>Hook: PreToolUse(Edit)
    Hook->>DB: getFileIntent(file)
    Hook-->>CC: additionalContext (existing intent — don't re-solve)

    Note over CC,DB: After a significant edit
    CC->>Hook: PostToolUse(Edit)
    Hook-->>CC: additionalContext: "run `intent annotate --json -`"
    CC->>CLI: intent annotate --json - (piped payload)
    CLI->>DB: annotateIntent(...)
```

## CLI surface (`bin: intent`)

Default output is human-readable; `--json` is machine-readable (what Claude uses).
Writes accept a JSON payload on stdin so multiline `detail` / quotes never hit shell escaping.

| Command | Maps to | Notes |
|---|---|---|
| `intent annotate --json -` | `annotateIntent` | reads JSON payload from stdin; prints new `intent_id` |
| `intent update --json -` | `updateIntent` | append/replace detail on an existing intent |
| `intent show <file>:<line>` | `getIntentAtLine` | intent at a current line position |
| `intent file <file>` (alias `log`) | `getFileIntent` | full provenance for a file |
| `intent search <query> [--file f] [--limit n]` | `searchIntent` | FTS5 search |
| `intent session <id>` | `getSessionIntent` | what a session did + why |
| `intent stats` | `getStats` | repo summary |
| `intent export [--format json]` | (new, folds in old M7) | ndjson to stdout |

Write payload contract (`annotate`):

```json
{ "file": "src/x.ts", "line_start": 10, "line_end": 24,
  "summary": "…", "detail": "…", "task_ref": "GH-142",
  "intent_id": "…optional, attach multi-file task…",
  "session_id": "…from INTENT_SESSION_ID…" }
```

## Distribution — the droppable skill bundle

Built output is a self-contained directory copied into any `.claude/skills/`:

```
intent/
  SKILL.md                    /intent + capture convention (Phase 3)
  dist/                       compiled JS — pure node:sqlite, no node_modules
  bin/intent                  shim: NODE_NO_WARNINGS=1 node --experimental-sqlite <dist>/cli/main.js "$@"
  bin/intent-hook             shim: same, → dist/hooks/cli.js
  install.mjs                 one-shot setup (node — present by definition)
```

`install.mjs` is idempotent and does three things:
1. Merge the 3 hooks (SessionStart / PreToolUse / PostToolUse) into the target
   `settings.json` **without clobbering** existing hook entries.
2. Drop `intent` + `intent-hook` shims onto PATH (`~/.local/bin`), so humans and Claude
   both just call `intent`.
3. Write the hook `command` as the absolute shim path — no PATH assumption for the hook.

Shims bake in `--experimental-sqlite` + `NODE_NO_WARNINGS=1` so the experimental flag and
its warning never leak. (Flag is a no-op / unneeded on node ≥ 23.4.)

## Phases

### Phase 1 — CLI spine ✅ DONE
`src/cli/` (parse, format, commands, main), `bin: intent`, JSON-on-stdin writes, 22 tests.

### Phase 2 — Rewire hooks ✅ DONE
Hook nudges name CLI commands; bin `mcp-intent-hook` → `intent-hook`; example + live configs updated.

### Phase 3 — Skill ✅ DONE
`.claude/skills/intent/SKILL.md` — `/intent`, CLI surface, capture convention, heredoc capture pattern.
*(Outstanding: PATH allow-list entry in `settings.local.json` was classifier-denied; needs user ok.)*

### Phase 4 — DB driver swap (`better-sqlite3` → `node:sqlite`) ✅ DONE
- [x] `connection.ts`: `DatabaseSync`, `transaction()` helper (manual BEGIN/COMMIT/ROLLBACK),
      `getUserVersion()` via `PRAGMA`. FK on by default.
- [x] `intents.ts`: row interfaces gained a `[column: string]: SQLOutputValue` index signature so
      they double as bind params + result cast target. Named-param `.run(row)` works unchanged.
- [x] `capture.ts`: switched to the `transaction()` helper.
- [x] All 74 tests pass (FTS5 triggers + bm25 + cascade intact). `better-sqlite3` removed.
- [x] `npm test` runs under `NODE_OPTIONS=--experimental-sqlite --no-warnings`.
- Note: on node 22.18 `node:sqlite` works *without* the flag (warns only); shim keeps `--no-warnings`.

### Phase 5 — Remove MCP (was 4) ✅ DONE
- [x] Deleted `src/mcp/` + stale `dist/mcp/`; dropped `mcp-intent-server` bin, `@modelcontextprotocol/sdk`, `zod`.
- [x] Deleted `.mcp.json` + `examples/.mcp.json`; stripped `enabledMcpjsonServers` + `mcp__intent__*` perms.
- [x] Removed `createIntentServer` from the barrel; rewrote docs (CLI + hooks + skill); updated CLAUDE.md.
- [x] **`dependencies: {}`** — zero runtime deps. 69 tests pass, typecheck clean.

### Phase 6 — Rename `mcp-intent` → `intent` (was 5) ✅ DONE
- [x] `package.json` name → `intent`. CLAUDE.md title, comments, hook output prefix, temp-dir prefix.
- [x] `INTENT_SESSION_ID` now primary, `MCP_INTENT_SESSION_ID` kept as legacy fallback.
- Left `specs/mcp-intent-spec.md` untouched (founding historical spec). Repo *directory* rename is the user's.

### Phase 7 — Bundle + `install.mjs` (distribution) ✅ DONE
- [x] `scripts/bundle.mjs` (`npm run bundle`) assembles `bundle/intent/` = SKILL.md + dist + install.mjs + README.
- [x] `scripts/install.mjs`: idempotent settings.json hook merge (preserves foreign hooks/keys, self-heals
      on path change), PATH shims with `--experimental-sqlite --no-warnings` baked in, `--dry-run`,
      `--project`/`--settings`/`--bin-dir` flags. Default target `~/.claude` (all repos).
- [x] `mergeHooks`/`shimContent` unit-tested (7 tests); vitest include extended to `scripts/**/*.test.mjs`.
- [x] Dogfooded: bundle → install to temp → generated shim runs clean → idempotent re-run verified.
- Note: hook command is the absolute shim path, so hooks work without PATH; only the human/Claude
  `intent` invocation needs the shim dir on PATH (installer warns if it isn't).

### Phase 8 — Post-commit backfill (was M6) ✅ DONE
- [x] `src/git/commit.ts` (`getHeadCommit`, `getCommitBlobs` via `diff-tree --root`), `backfillCommitHash`
      (db), `backfillHeadCommit` (service). Matched by blob hash; only stamps rows where commit_hash IS NULL.
- [x] CLI: `intent backfill` + `intent install-commit-hook` (writes a fail-safe `.git/hooks/post-commit`).
- [x] 3 backfill tests (stamp / idempotent / blob-not-in-commit). Dogfooded live in a temp repo.

### Repo tidy (source repo no longer self-uses the tool)
- [x] Relocated skill source `.claude/skills/intent/SKILL.md` → `skill/SKILL.md`; `bundle.mjs` follows.
- [x] Removed `.claude/settings.json` (the hooks) and the throwaway `.git/intent.db`. This repo builds
      the bundle but doesn't run intent on itself.

### Phase 9 — Export ✅ effectively done
`intent export` (ndjson) landed in Phase 1; revisit only if cross-repo ingest needs a different shape.

## Files: add / change / delete

- **Add**: `src/cli/*` ✅, `.claude/skills/intent/SKILL.md` ✅, `install.mjs`, `bin/` shims
- **Change**: `src/hooks/*` ✅, `src/db/*` (node:sqlite swap), `src/capture.ts` (txn), `package.json`,
  CLAUDE.md, spec, docs, examples
- **Delete**: `src/mcp/`, `.mcp.json`, `better-sqlite3` + `@modelcontextprotocol/sdk` + `zod` deps

## Risks / watch-outs

- **Model invocation reliability** — shelling out to a CLI is slightly more brittle than a
  structured MCP tool call. Mitigated by JSON-stdin (no escaping) + a terse, exact command in
  the hook's `additionalContext`. Verify with a real edit→annotate round-trip once wired.
- **Permission prompts** — the model running `intent annotate …` each significant edit may
  prompt. Add an allowlist entry for `intent` in project `.claude/settings.json` (or
  `/fewer-permission-prompts` after the fact).
- **Reversibility** — core stays agnostic, so an MCP lid is a ~30-min resurrect if a non-Claude
  client ever needs it. We're not burning the bridge, just not paying for it per-repo.
