import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { annotateIntent, updateIntent, type CaptureContext } from "../capture.js";
import {
  getAllResolvedIntents,
  getFileIntent,
  getIntentAtLine,
  getSessionIntent,
  searchIntent,
  type ResolvedIntent,
} from "../query.js";
import { getStats } from "../db/intents.js";
import { backfillHeadCommit } from "../backfill.js";
import {
  backfillFromTranscriptFile,
  resolveCandidatesFromFile,
  discoverTranscripts,
  type BackfillCandidate,
  type TranscriptBackfillResult,
} from "../backfill-transcript.js";
import { getGitDir } from "../git/repo.js";
import { toRepoRelative } from "../git/paths.js";
import { blameLine } from "../git/blame.js";
import { statSync, readdirSync } from "node:fs";
import type { ParsedArgs } from "./parse.js";
import {
  formatFileIntents,
  formatIntents,
  formatShowFallback,
  formatStats,
  serializeIntent,
  serializeIntents,
} from "./format.js";

/**
 * CLI command handlers over the same capture/query services the hooks use.
 * Each returns the string to print; main.ts owns stdin/stdout/exit codes.
 *
 * Write commands (`annotate`, `update`) take their payload as JSON on stdin so
 * multiline detail / quotes never hit shell escaping. Read commands honour
 * `--json` for machine output and default to terse human text.
 */

/** A user error (bad args/payload) — main exits 2 and prints usage, not a stack. */
export class UsageError extends Error {}

export interface CommandDeps {
  /** Reads the full JSON payload for write commands. */
  readStdin: () => Promise<string>;
}

export async function runCommand(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  deps: CommandDeps,
): Promise<string> {
  const json = parsed.flags.json === true;

  switch (parsed.command) {
    case "annotate":
      return annotate(ctx, deps, json);
    case "update":
      return update(ctx, deps, json);
    case "show":
      return show(ctx, parsed, json);
    case "file":
    case "log":
      return fileLog(ctx, parsed, json);
    case "search":
      return search(ctx, parsed, json);
    case "session":
      return session(ctx, parsed, json);
    case "stats":
      return stats(ctx, json);
    case "export":
      return exportAll(ctx);
    case "backfill":
      return backfill(ctx, json);
    case "backfill-transcript":
      return backfillTranscript(ctx, parsed, json);
    case "install-commit-hook":
      return installCommitHook(ctx);
    case "help":
    case undefined:
      return helpText();
    default:
      throw new UsageError(`unknown command: ${parsed.command}`);
  }
}

async function annotate(
  ctx: CaptureContext,
  deps: CommandDeps,
  json: boolean,
): Promise<string> {
  const payload = await readPayload(deps);
  const result = await annotateIntent(ctx, {
    file: reqStr(payload, "file"),
    lineStart: reqInt(payload, "line_start"),
    lineEnd: reqInt(payload, "line_end"),
    summary: reqStr(payload, "summary"),
    detail: optStr(payload, "detail"),
    taskRef: optStr(payload, "task_ref"),
    intentId: optStr(payload, "intent_id"),
    sessionId: optStr(payload, "session_id"),
    createdAt: optInt(payload, "created_at"),
  });
  return json
    ? JSON.stringify({
        intent_id: result.intentId,
        intent_line_id: result.intentLineId,
        blob_hash: result.blobHash,
      })
    : `annotated ${result.intentId} (${result.blobHash.slice(0, 8)})`;
}

async function update(
  ctx: CaptureContext,
  deps: CommandDeps,
  json: boolean,
): Promise<string> {
  const payload = await readPayload(deps);
  const intent = updateIntent(ctx, {
    intentId: reqStr(payload, "intent_id"),
    detail: reqStr(payload, "detail"),
    append: typeof payload.append === "boolean" ? payload.append : undefined,
  });
  return json
    ? JSON.stringify({ intent_id: intent.id, detail: intent.detail })
    : `updated ${intent.id}`;
}

async function show(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  json: boolean,
): Promise<string> {
  const target = parsed.positionals[0];
  if (!target) throw new UsageError("usage: intent show <file>:<line>");
  const { file, line } = parseTarget(target);
  const key = toRepoRelative(ctx.repoRoot, file, process.cwd());

  const resolved = await getIntentAtLine(ctx, key, line);
  if (resolved.length > 0) return render(resolved, json);

  // No recorded intent for this line — fall back to git blame so the caller
  // still gets the last-touching commit without re-reading the code.
  const blame = await blameLine(ctx.repoRoot, key, line);
  if (json) {
    return JSON.stringify({
      intents: [],
      source: blame ? "git-blame" : "none",
      blame: blame
        ? {
            commit_hash: blame.commitHash,
            summary: blame.summary,
            author: blame.author,
            author_time: blame.authorTime,
            uncommitted: blame.uncommitted,
          }
        : null,
    });
  }
  return formatShowFallback(key, line, blame);
}

async function fileLog(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  json: boolean,
): Promise<string> {
  const file = parsed.positionals[0];
  if (!file) throw new UsageError("usage: intent file <path>");
  const key = toRepoRelative(ctx.repoRoot, file, process.cwd());
  const resolved = await getFileIntent(ctx, key);
  // File view splits current vs superseded so multi-edit history reads as
  // history, not duplicates. Other read commands use the flat formatter.
  return json ? JSON.stringify(serializeIntents(resolved)) : formatFileIntents(resolved);
}

async function search(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  json: boolean,
): Promise<string> {
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new UsageError("usage: intent search <query> [--file f] [--limit n]");
  const file =
    typeof parsed.flags.file === "string"
      ? toRepoRelative(ctx.repoRoot, parsed.flags.file, process.cwd())
      : undefined;
  const limit = optLimit(parsed.flags.limit);
  return render(await searchIntent(ctx, query, { file, limit }), json);
}

async function session(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  json: boolean,
): Promise<string> {
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("usage: intent session <session-id>");
  return render(await getSessionIntent(ctx, id), json);
}

function stats(ctx: CaptureContext, json: boolean): string {
  const s = getStats(ctx.db);
  return json ? JSON.stringify(s) : formatStats(s);
}

async function exportAll(ctx: CaptureContext): Promise<string> {
  const resolved = await getAllResolvedIntents(ctx);
  return resolved.map((r) => JSON.stringify(serializeIntent(r))).join("\n");
}

async function backfill(ctx: CaptureContext, json: boolean): Promise<string> {
  const { commit, updated } = await backfillHeadCommit(ctx);
  return json
    ? JSON.stringify({ commit, updated })
    : `backfilled ${updated} record(s) → ${commit.slice(0, 8)}`;
}

/**
 * Recover provenance from Claude Code session transcripts. With no path, it
 * auto-discovers this repo's transcripts under ~/.claude/projects; a path may be
 * a single .jsonl file or a directory of them. Best-effort — only edits whose
 * content still matches the current working tree get an intent.
 *
 * `--dry-run` writes nothing and instead emits the matched, de-duplicated
 * candidates (with resolved line ranges + raw reasoning). That's the hand-off to
 * the `intent-backfill` skill, which synthesises a tight summary per candidate
 * and writes them via `intent annotate`. Without `--dry-run`, the raw reasoning
 * is stored verbatim.
 */
async function backfillTranscript(
  ctx: CaptureContext,
  parsed: ParsedArgs,
  json: boolean,
): Promise<string> {
  const files = resolveTranscriptFiles(ctx.repoRoot, parsed.positionals[0]);
  if (files.length === 0) {
    throw new UsageError(
      "no transcripts found — pass a .jsonl file/dir, or check ~/.claude/projects for this repo",
    );
  }
  const dryRun = parsed.flags["dry-run"] === true;

  const totals: TranscriptBackfillResult = {
    parsed: 0,
    created: 0,
    skippedNoMatch: 0,
    skippedOutsideRepo: 0,
    skippedTrivial: 0,
    duplicates: 0,
  };
  const candidates: BackfillCandidate[] = [];

  for (const file of files) {
    if (dryRun) {
      const { candidates: cs, result } = await resolveCandidatesFromFile(ctx, file);
      candidates.push(...cs);
      for (const k of Object.keys(totals) as (keyof TranscriptBackfillResult)[]) totals[k] += result[k];
    } else {
      const r = await backfillFromTranscriptFile(ctx, file);
      for (const k of Object.keys(totals) as (keyof TranscriptBackfillResult)[]) totals[k] += r[k];
    }
  }

  if (dryRun) {
    // Emit candidates for the synthesis skill. JSON regardless of --json: the
    // payload is the whole point of dry-run.
    return JSON.stringify({ transcripts: files.length, candidates }, null, json ? 0 : 2);
  }

  if (json) return JSON.stringify({ transcripts: files.length, ...totals });
  return (
    `transcripts: ${files.length} | edits: ${totals.parsed} → ` +
    `created ${totals.created}, dupes ${totals.duplicates}, ` +
    `no-match ${totals.skippedNoMatch}, trivial ${totals.skippedTrivial}, ` +
    `outside-repo ${totals.skippedOutsideRepo}`
  );
}

/** Expand the optional path arg into a list of .jsonl files (or auto-discover). */
function resolveTranscriptFiles(repoRoot: string, arg: string | undefined): string[] {
  if (!arg) return discoverTranscripts(repoRoot);
  const resolved = path.resolve(arg);
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (!stat) throw new UsageError(`no such file or directory: ${arg}`);
  if (stat.isDirectory()) {
    return readdirSync(resolved)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(resolved, f));
  }
  return [resolved];
}

/** Marker line identifying a post-commit hook as ours (for self-heal/idempotency). */
const COMMIT_HOOK_MARKER = "# intent backfill hook";

/**
 * Build the post-commit hook body. It pins BOTH the node binary and the CLI
 * entry to absolute paths captured at install time, so the hook is fully
 * PATH-independent.
 *
 * Why the node path matters: a bare `node` resolves through PATH, but GUI git
 * clients (Fork, Rider, SourceTree, VS Code…) don't source the shell's
 * nvm/fnm/asdf init, so a version-managed `node` isn't on their PATH — the hook
 * fires, can't find node, and `|| true` silently swallows it. Baking in
 * `process.execPath` (the node that ran the install) fixes that. We still fall
 * back to a PATH `node` if that exact binary later disappears (e.g. the nvm
 * version got uninstalled). Forward-slash both paths so git-bash is happy on
 * Windows.
 */
function commitHookScript(): string {
  const entry = fileURLToPath(new URL("./main.js", import.meta.url)).replace(/\\/g, "/");
  const node = process.execPath.replace(/\\/g, "/");
  return (
    "#!/bin/sh\n" +
    `${COMMIT_HOOK_MARKER} — stamp commit_hash onto captured intents (never blocks a commit)\n` +
    `NODE="${node}"\n` +
    `[ -x "$NODE" ] || NODE=node\n` +
    `"$NODE" --experimental-sqlite --no-warnings "${entry}" backfill >/dev/null 2>&1 || true\n`
  );
}

/** Install a fail-safe post-commit git hook that runs `intent backfill`. */
async function installCommitHook(ctx: CaptureContext): Promise<string> {
  const gitDir = await getGitDir(ctx.repoRoot);
  const hookPath = path.join(gitDir, "hooks", "post-commit");
  const script = commitHookScript();

  let verb = "installed";
  if (existsSync(hookPath)) {
    const current = readFileSync(hookPath, "utf8");
    // Foreign hook we didn't write — never clobber it.
    if (!current.includes(COMMIT_HOOK_MARKER) && !current.includes("intent backfill")) {
      throw new UsageError(
        `a post-commit hook already exists at ${hookPath}; add 'intent backfill' to it manually`,
      );
    }
    if (current === script) return `post-commit hook already installed → ${hookPath}`;
    verb = "updated"; // ours, but stale (e.g. old PATH-based body) — self-heal.
  }

  mkdirSync(path.dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  return `${verb} post-commit hook → ${hookPath}`;
}

function render(resolved: ResolvedIntent[], json: boolean): string {
  return json ? JSON.stringify(serializeIntents(resolved)) : formatIntents(resolved);
}

// --- payload + arg helpers ---------------------------------------------------

async function readPayload(deps: CommandDeps): Promise<Record<string, unknown>> {
  const raw = (await deps.readStdin()).trim();
  if (!raw) throw new UsageError("expected a JSON payload on stdin");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("invalid JSON payload on stdin");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("JSON payload must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseTarget(target: string): { file: string; line: number } {
  const idx = target.lastIndexOf(":");
  if (idx === -1) throw new UsageError("expected <file>:<line>");
  const file = target.slice(0, idx);
  const line = Number(target.slice(idx + 1));
  if (!file || !Number.isInteger(line) || line < 1) {
    throw new UsageError("expected <file>:<line> with a positive integer line");
  }
  return { file, line };
}

function reqStr(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(`missing required string field: ${key}`);
  }
  return v;
}

function reqInt(payload: Record<string, unknown>, key: string): number {
  const v = payload[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new UsageError(`missing/invalid integer field: ${key}`);
  }
  return v;
}

function optStr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optInt(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function optLimit(flag: string | boolean | undefined): number | undefined {
  if (flag === undefined || flag === true || flag === false) return undefined;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < 1) throw new UsageError("--limit must be a positive integer");
  return n;
}

export function helpText(): string {
  return [
    "intent — AI code provenance, anchored to git blob hashes.",
    "",
    "Usage:",
    "  intent show <file>:<line>            intent covering a current line (falls back to git blame)",
    "  intent file <path>                   full provenance for a file (alias: log)",
    "  intent search <query> [--file f] [--limit n]",
    "  intent session <session-id>          what a session did + why",
    "  intent stats                         repo summary",
    "  intent export                        ndjson of every intent",
    "  intent annotate                      capture (JSON payload on stdin)",
    "  intent update                        amend detail (JSON payload on stdin)",
    "  intent backfill                      stamp commit_hash from the HEAD commit",
    "  intent backfill-transcript [path] [--dry-run]   recover intents from transcript(s)",
    "  intent install-commit-hook           add a post-commit hook that backfills",
    "",
    "Flags:",
    "  --json     machine-readable output (read commands)",
    "",
    "Write payload (annotate): { file, line_start, line_end, summary,",
    "  detail?, task_ref?, intent_id?, session_id?, created_at? }",
    "Write payload (update):   { intent_id, detail, append? }",
  ].join("\n");
}
