import type { IntentDatabase } from "./db/connection.js";
import type { Intent, IntentLine } from "./types.js";
import {
  getIntent,
  getIntentLines,
  getIntentLinesByFile,
  getIntentsBySession,
  searchIntentIds,
} from "./db/intents.js";
import { resolveAnchor, type AnchorStatus } from "./git/blob.js";

/**
 * Read service — query side. Ties the intent tables to git resolution so every
 * result carries the line range where the anchored code *currently* lives, not
 * where it was when captured. Transport-agnostic; the MCP read tools wrap this.
 */

export interface QueryContext {
  db: IntentDatabase;
  repoRoot: string;
}

export interface ResolvedIntentLine {
  line: IntentLine;
  /** How the current position was derived (see resolveAnchor). */
  status: AnchorStatus;
  /** Current 1-based range, or null when it can't be determined. */
  currentLineStart: number | null;
  currentLineEnd: number | null;
}

export interface ResolvedIntent {
  intent: Intent;
  lines: ResolvedIntentLine[];
}

/** Statuses whose resolved line range we trust for line-coverage queries. */
const TRUSTED_STATUSES: ReadonlySet<AnchorStatus> = new Set(["exact", "fragment"]);

async function resolveLine(
  repoRoot: string,
  line: IntentLine,
): Promise<ResolvedIntentLine> {
  const resolved = await resolveAnchor(repoRoot, {
    filePath: line.filePath,
    blobHash: line.blobHash,
    fragment: line.fragment,
    lineStart: line.lineStart,
    lineEnd: line.lineEnd,
  });
  return {
    line,
    status: resolved.status,
    currentLineStart: resolved.lineStart,
    currentLineEnd: resolved.lineEnd,
  };
}

/** Group resolved lines back under their parent intents, preserving order. */
function groupByIntent(
  db: IntentDatabase,
  resolved: ResolvedIntentLine[],
): ResolvedIntent[] {
  const order: string[] = [];
  const byIntent = new Map<string, ResolvedIntentLine[]>();
  for (const r of resolved) {
    const id = r.line.intentId;
    let bucket = byIntent.get(id);
    if (!bucket) {
      bucket = [];
      byIntent.set(id, bucket);
      order.push(id);
    }
    bucket.push(r);
  }

  const out: ResolvedIntent[] = [];
  for (const id of order) {
    const intent = getIntent(db, id);
    if (intent) out.push({ intent, lines: byIntent.get(id)! });
  }
  return out;
}

/** Build a fully-resolved intent (all of its lines) from an intent id. */
async function loadResolvedIntent(
  ctx: QueryContext,
  intentId: string,
): Promise<ResolvedIntent | null> {
  const intent = getIntent(ctx.db, intentId);
  if (!intent) return null;
  const lines = getIntentLines(ctx.db, intentId);
  const resolved = await Promise.all(lines.map((l) => resolveLine(ctx.repoRoot, l)));
  return { intent, lines: resolved };
}

function covers(line: ResolvedIntentLine, at: number): boolean {
  if (!TRUSTED_STATUSES.has(line.status)) return false;
  if (line.currentLineStart === null || line.currentLineEnd === null) return false;
  return at >= line.currentLineStart && at <= line.currentLineEnd;
}

function minStart(intent: ResolvedIntent): number {
  let min = Number.POSITIVE_INFINITY;
  for (const l of intent.lines) {
    if (l.currentLineStart !== null && l.currentLineStart < min) min = l.currentLineStart;
  }
  return min;
}

/**
 * All intents whose anchored range currently covers `line` in `file`. Position
 * is re-resolved at query time; only exact/fragment matches count toward
 * coverage (a drifted anchor's stored hint isn't trusted for this).
 */
export async function getIntentAtLine(
  ctx: QueryContext,
  file: string,
  line: number,
): Promise<ResolvedIntent[]> {
  const lines = getIntentLinesByFile(ctx.db, file);
  const resolved = await Promise.all(lines.map((l) => resolveLine(ctx.repoRoot, l)));
  const matching = resolved.filter((r) => covers(r, line));
  return groupByIntent(ctx.db, matching);
}

/**
 * All intents for a file, each with its lines resolved to current positions,
 * ordered by current line position (unresolved anchors sort last).
 */
export async function getFileIntent(
  ctx: QueryContext,
  file: string,
): Promise<ResolvedIntent[]> {
  const lines = getIntentLinesByFile(ctx.db, file);
  const resolved = await Promise.all(lines.map((l) => resolveLine(ctx.repoRoot, l)));
  const grouped = groupByIntent(ctx.db, resolved);
  return grouped.sort((a, b) => minStart(a) - minStart(b));
}

/**
 * Full-text search across summary + detail. Optional `file` restricts to
 * intents touching that file. Results are bm25-ranked and fully resolved.
 */
export async function searchIntent(
  ctx: QueryContext,
  query: string,
  options: { file?: string | null; limit?: number } = {},
): Promise<ResolvedIntent[]> {
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery === null) return [];

  const limit = options.limit ?? 20;
  const ids = searchIntentIds(ctx.db, ftsQuery, limit, options.file ?? null);
  const resolved = await Promise.all(ids.map((id) => loadResolvedIntent(ctx, id)));
  return resolved.filter((r): r is ResolvedIntent => r !== null);
}

/** All intents created in a Claude Code session, fully resolved. */
export async function getSessionIntent(
  ctx: QueryContext,
  sessionId: string,
): Promise<ResolvedIntent[]> {
  const intents = getIntentsBySession(ctx.db, sessionId);
  const resolved = await Promise.all(
    intents.map((i) => loadResolvedIntent(ctx, i.id)),
  );
  return resolved.filter((r): r is ResolvedIntent => r !== null);
}

/**
 * Turn a free-text query into a safe FTS5 MATCH string: extract word/number
 * tokens, quote each as a phrase, and AND them together. This sidesteps FTS5
 * query-syntax errors from punctuation in user input. Returns null if there's
 * nothing searchable.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}
