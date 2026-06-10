import type { ResolvedIntent, ResolvedIntentLine } from "../query.js";
import type { IntentStats } from "../db/intents.js";

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
