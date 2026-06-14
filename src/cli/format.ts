import type { ResolvedIntent, ResolvedIntentLine } from "../query.js";
import type { IntentStats } from "../db/intents.js";
import type { BlameLine } from "../git/blame.js";

/**
 * Output formatters for the CLI. Two shapes for every read result:
 *   - `serializeIntents` — stable snake_case JSON for machine consumers
 *     (Claude shelling out with `--json`, and `intent export`).
 *   - `formatIntents` — terse human-readable text, the default.
 */

export function serializeIntents(resolved: ResolvedIntent[]): unknown {
  return { intents: resolved.map(serializeIntent) };
}

/** One resolved intent as a plain JSON object (also one ndjson export line). */
export function serializeIntent(r: ResolvedIntent): unknown {
  return {
    intent_id: r.intent.id,
    summary: r.intent.summary,
    detail: r.intent.detail,
    task_ref: r.intent.taskRef,
    session_id: r.intent.sessionId,
    created_at: r.intent.createdAt,
    // True when none of this intent's anchors still resolve to live code — it's
    // historical context a later change superseded. Kept on purpose; not a dup.
    superseded: !isLive(r),
    lines: r.lines.map((l) => ({
      file: l.line.filePath,
      blob_hash: l.line.blobHash,
      commit_hash: l.line.commitHash,
      status: l.status,
      line_start: l.currentLineStart,
      line_end: l.currentLineEnd,
      original_line_start: l.line.lineStart,
      original_line_end: l.line.lineEnd,
    })),
  };
}

export function formatIntents(resolved: ResolvedIntent[]): string {
  if (resolved.length === 0) return "No intent recorded.";
  return resolved.map(formatIntent).join("\n\n");
}

/**
 * File-scoped view: when a file has both live and superseded intents (the same
 * region captured across several edits), split them under headers so the reader
 * sees the current reasoning first and understands the older entries are kept
 * history — not duplicates to prune. With no superseded entries it's identical
 * to {@link formatIntents}.
 */
export function formatFileIntents(resolved: ResolvedIntent[]): string {
  if (resolved.length === 0) return "No intent recorded.";

  const live = resolved.filter(isLive);
  const superseded = resolved.filter((r) => !isLive(r));
  if (superseded.length === 0) return live.map(formatIntent).join("\n\n");

  const current = live.length
    ? live.map(formatIntent).join("\n\n")
    : "(none — every intent for this file has been superseded)";
  return [
    "# current",
    current,
    "# superseded (history — kept on purpose; don't delete or rewrite these)",
    superseded.map(formatIntent).join("\n\n"),
  ].join("\n\n");
}

/**
 * `intent show <file>:<line>` had no DB hit — fall back to git blame so the
 * caller still gets the commit that last touched the line without reading code.
 */
export function formatShowFallback(
  file: string,
  line: number,
  blame: BlameLine | null,
): string {
  const head = `No recorded intent for ${file}:${line}.`;
  if (!blame) return head;
  if (blame.uncommitted) {
    return `${head} Line is an uncommitted local change — capture why with \`intent annotate\`.`;
  }
  const date = formatDate(blame.authorTime);
  return `${head}\ngit blame: ${short(blame.commitHash)}  ${blame.summary}  (${blame.author}, ${date})`;
}

/** True when at least one anchor still resolves to live code (exact/fragment). */
function isLive(r: ResolvedIntent): boolean {
  return r.lines.some((l) => l.status === "exact" || l.status === "fragment");
}

export function formatStats(s: IntentStats): string {
  return `${s.intents} intent(s), ${s.lines} line anchor(s) across ${s.files} file(s).`;
}

function formatIntent(r: ResolvedIntent): string {
  const out: string[] = [];

  const ref = r.intent.taskRef ? `  [${r.intent.taskRef}]` : "";
  out.push(`${r.intent.summary}${ref}`);

  const meta = [`id ${short(r.intent.id)}`, formatDate(r.intent.createdAt)];
  if (r.intent.sessionId) meta.push(`session ${short(r.intent.sessionId)}`);
  out.push(`  ${meta.join("  ")}`);

  if (r.intent.detail) out.push(`  why: ${r.intent.detail.replace(/\n/g, "\n       ")}`);

  for (const l of r.lines) {
    out.push(`  ${formatLoc(l)}  ${l.line.filePath}  (${l.status})`);
  }

  return out.join("\n");
}

function formatLoc(l: ResolvedIntentLine): string {
  if (l.currentLineStart === null) return "L?";
  if (l.currentLineEnd === null || l.currentLineEnd === l.currentLineStart) {
    return `L${l.currentLineStart}`;
  }
  return `L${l.currentLineStart}-${l.currentLineEnd}`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
