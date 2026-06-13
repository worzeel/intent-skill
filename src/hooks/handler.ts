import path from "node:path";
import type { IntentDatabase } from "../db/connection.js";
import { getRecentIntents, getStats } from "../db/intents.js";
import { getFileIntent, type QueryContext } from "../query.js";
import { toRepoRelative } from "../git/paths.js";

/**
 * Claude Code hook logic — the deterministic harness glue around the `intent`
 * CLI. The hooks carry the exact CLI command in their injected context so the
 * capture/query loop needs no MCP server process.
 *
 *  - SessionStart: inject a short repo provenance summary so Claude knows intent
 *    history exists and which commands to run.
 *  - PreToolUse (edits): inject existing provenance for the file about to be
 *    touched, so Claude doesn't contradict or re-solve prior decisions.
 *  - PostToolUse (edits): a gentle nudge to capture intent for the change.
 *
 * Kept pure (db + repoRoot in, context string out) so it's testable without a
 * live Claude Code session. The CLI in cli.ts adapts stdin/stdout to this.
 */

export interface HookContext extends QueryContext {
  db: IntentDatabase;
  repoRoot: string;
}

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
  cwd?: string;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

/** Edit-shaped tools whose file target carries provenance worth surfacing. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

const RECENT_LIMIT = 5;

export async function handleHook(ctx: HookContext, input: HookInput): Promise<HookOutput> {
  switch (input.hook_event_name) {
    case "SessionStart": {
      const text = buildSessionStartContext(ctx);
      return text ? wrap("SessionStart", text) : {};
    }
    case "PreToolUse": {
      if (!isEditTool(input.tool_name)) return {};
      const file = relevantFile(ctx.repoRoot, input.tool_input);
      if (!file) return {};
      const text = await buildPreEditContext(ctx, file);
      return text ? wrap("PreToolUse", text) : {};
    }
    case "PostToolUse": {
      if (!isEditTool(input.tool_name)) return {};
      const file = relevantFile(ctx.repoRoot, input.tool_input);
      if (!file) return {};
      return wrap("PostToolUse", buildPostEditReminder(file));
    }
    default:
      return {};
  }
}

/** Repo-level provenance summary for session start. Null when nothing recorded. */
export function buildSessionStartContext(ctx: HookContext): string | null {
  const stats = getStats(ctx.db);
  if (stats.intents === 0) return null;

  const recent = getRecentIntents(ctx.db, RECENT_LIMIT);
  const bullets = recent.map(
    (i) => `- ${i.summary}${i.taskRef ? ` (${i.taskRef})` : ""}`,
  );

  return [
    `intent: ${stats.intents} intent(s) recorded across ${stats.files} file(s).`,
    "Most recent:",
    ...bullets,
    "Before editing a file, run `intent file <path>` to see prior decisions; after a significant change, run `intent annotate` (JSON payload on stdin).",
  ].join("\n");
}

/** Existing provenance for a file about to be edited. Null when there's none. */
export async function buildPreEditContext(
  ctx: HookContext,
  file: string,
): Promise<string | null> {
  const resolved = await getFileIntent(ctx, file);
  if (resolved.length === 0) return null;

  const bullets = resolved.map((r) => {
    const loc = r.lines
      .map((l) => (l.currentLineStart !== null ? `L${l.currentLineStart}` : "?"))
      .join(",");
    const why = r.intent.detail ? ` — ${r.intent.detail}` : "";
    return `- [${loc}] ${r.intent.summary}${why}`;
  });

  return [
    `Existing intent provenance for ${file} (don't contradict or re-solve these):`,
    ...bullets,
  ].join("\n");
}

export function buildPostEditReminder(file: string): string {
  return (
    `Edited ${file}. If this was a significant change (new logic, a workaround, ` +
    `an architectural decision), capture why: pipe a JSON payload to ` +
    "`intent annotate --json -` — " +
    `{"file":"${file}","line_start":N,"line_end":N,"summary":"…","detail":"…"}.`
  );
}

function isEditTool(toolName: string | undefined): boolean {
  return toolName !== undefined && EDIT_TOOLS.has(toolName);
}

/** Pull the target file from a tool input and make it the canonical repo key. */
export function relevantFile(
  repoRoot: string,
  toolInput: Record<string, unknown> | undefined,
): string | null {
  const raw = toolInput?.["file_path"] ?? toolInput?.["notebook_path"];
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Canonical repo-relative POSIX key — same form capture stores, so the nudge
  // tells Claude the exact path that `intent file` will match. toRepoRelative
  // resolves symlinks on both ends (a symlinked cwd like macOS /var ->
  // /private/var won't look like it escapes the repo).
  const key = toRepoRelative(repoRoot, raw);

  // Outside the repo — the fallback leaves an absolute path or a leading "..".
  if (key.length === 0 || key.startsWith("..") || path.isAbsolute(key)) return null;
  return key;
}

function wrap(hookEventName: string, additionalContext: string): HookOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}
