import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IntentDatabase } from "./db/connection.js";
import type { Intent } from "./types.js";
import {
  createIntent,
  getIntent,
  insertIntentLine,
  updateIntentDetail,
} from "./db/intents.js";
import { hashFile } from "./git/blob.js";

/**
 * Capture service — the write-side business logic. Ties git blob resolution to
 * the intent tables, independent of the MCP transport so it can be tested and
 * reused directly.
 */

export interface CaptureContext {
  db: IntentDatabase;
  /** Absolute repo root, used for git blob resolution and path resolution. */
  repoRoot: string;
  /** Falls back here when a call doesn't supply a session id. */
  sessionId?: string | null;
}

/** Max characters kept in a captured fragment snippet. */
const FRAGMENT_MAX_CHARS = 600;

export interface AnnotateParams {
  file: string;
  lineStart: number;
  lineEnd: number;
  summary: string;
  detail?: string | null;
  taskRef?: string | null;
  /**
   * Attach this annotation to an existing intent instead of creating a new one.
   * Lets a multi-file task share one intent across several files (see spec Q5).
   */
  intentId?: string | null;
  sessionId?: string | null;
}

export interface AnnotateResult {
  intentId: string;
  intentLineId: string;
  blobHash: string;
  fragment: string | null;
}

/**
 * Capture an intent for a file change. Resolves and persists the blob hash
 * (writing it into git's object store so it stays resolvable pre-commit),
 * snapshots a fragment of the changed lines, and writes the intent +
 * intent_line records atomically.
 */
export async function annotateIntent(
  ctx: CaptureContext,
  params: AnnotateParams,
): Promise<AnnotateResult> {
  const blobHash = await hashFile(ctx.repoRoot, params.file, { write: true });
  const fragment = await extractFragment(
    ctx.repoRoot,
    params.file,
    params.lineStart,
    params.lineEnd,
  );
  const sessionId = params.sessionId ?? ctx.sessionId ?? null;

  const write = ctx.db.transaction((): { intentId: string; intentLineId: string } => {
    let intentId = params.intentId ?? null;
    if (intentId) {
      if (!getIntent(ctx.db, intentId)) {
        throw new Error(`intent not found: ${intentId}`);
      }
    } else {
      intentId = createIntent(ctx.db, {
        summary: params.summary,
        detail: params.detail,
        taskRef: params.taskRef,
        sessionId,
      }).id;
    }

    const line = insertIntentLine(ctx.db, {
      intentId,
      filePath: params.file,
      blobHash,
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      fragment,
    });
    return { intentId, intentLineId: line.id };
  });

  const { intentId, intentLineId } = write();
  return { intentId, intentLineId, blobHash, fragment };
}

export interface UpdateParams {
  intentId: string;
  detail: string;
  append?: boolean;
}

/** Amend an existing intent's detail. Throws if the intent doesn't exist. */
export function updateIntent(ctx: CaptureContext, params: UpdateParams): Intent {
  const updated = updateIntentDetail(
    ctx.db,
    params.intentId,
    params.detail,
    params.append ?? true,
  );
  if (!updated) throw new Error(`intent not found: ${params.intentId}`);
  return updated;
}

/** Snapshot the changed line range as a short text fragment for later anchoring. */
async function extractFragment(
  repoRoot: string,
  file: string,
  lineStart: number,
  lineEnd: number,
): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(path.resolve(repoRoot, file), "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const start = Math.max(1, Math.min(lineStart, lines.length));
  const end = Math.max(start, Math.min(lineEnd, lines.length));
  const snippet = lines.slice(start - 1, end).join("\n");

  return snippet.length > FRAGMENT_MAX_CHARS
    ? snippet.slice(0, FRAGMENT_MAX_CHARS)
    : snippet;
}
