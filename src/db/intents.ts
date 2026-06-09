import { randomUUID } from "node:crypto";
import type { IntentDatabase } from "./connection.js";
import type { Intent, IntentLine } from "../types.js";

/**
 * Data-access layer for the intent tables. Pure functions over a database
 * handle — no git, no MCP. The FTS index is kept in sync by triggers, so these
 * just touch the base tables.
 */

interface IntentRow {
  id: string;
  session_id: string | null;
  summary: string;
  detail: string | null;
  task_ref: string | null;
  created_at: number;
}

interface IntentLineRow {
  id: string;
  intent_id: string;
  file_path: string;
  blob_hash: string;
  commit_hash: string | null;
  line_start: number | null;
  line_end: number | null;
  fragment: string | null;
}

function toIntent(r: IntentRow): Intent {
  return {
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    detail: r.detail,
    taskRef: r.task_ref,
    createdAt: r.created_at,
  };
}

function toIntentLine(r: IntentLineRow): IntentLine {
  return {
    id: r.id,
    intentId: r.intent_id,
    filePath: r.file_path,
    blobHash: r.blob_hash,
    commitHash: r.commit_hash,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    fragment: r.fragment,
  };
}

export interface NewIntent {
  summary: string;
  detail?: string | null;
  taskRef?: string | null;
  sessionId?: string | null;
  /** Unix seconds; defaults to now. */
  createdAt?: number;
}

export function createIntent(db: IntentDatabase, input: NewIntent): Intent {
  const row: IntentRow = {
    id: randomUUID(),
    session_id: input.sessionId ?? null,
    summary: input.summary,
    detail: input.detail ?? null,
    task_ref: input.taskRef ?? null,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
  };
  db.prepare(
    `INSERT INTO intent (id, session_id, summary, detail, task_ref, created_at)
     VALUES (@id, @session_id, @summary, @detail, @task_ref, @created_at)`,
  ).run(row);
  return toIntent(row);
}

export interface NewIntentLine {
  intentId: string;
  filePath: string;
  blobHash: string;
  commitHash?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  fragment?: string | null;
}

export function insertIntentLine(db: IntentDatabase, input: NewIntentLine): IntentLine {
  const row: IntentLineRow = {
    id: randomUUID(),
    intent_id: input.intentId,
    file_path: input.filePath,
    blob_hash: input.blobHash,
    commit_hash: input.commitHash ?? null,
    line_start: input.lineStart ?? null,
    line_end: input.lineEnd ?? null,
    fragment: input.fragment ?? null,
  };
  db.prepare(
    `INSERT INTO intent_line
       (id, intent_id, file_path, blob_hash, commit_hash, line_start, line_end, fragment)
     VALUES
       (@id, @intent_id, @file_path, @blob_hash, @commit_hash, @line_start, @line_end, @fragment)`,
  ).run(row);
  return toIntentLine(row);
}

export function getIntent(db: IntentDatabase, id: string): Intent | null {
  const row = db.prepare("SELECT * FROM intent WHERE id = ?").get(id) as IntentRow | undefined;
  return row ? toIntent(row) : null;
}

export function getIntentLines(db: IntentDatabase, intentId: string): IntentLine[] {
  const rows = db
    .prepare("SELECT * FROM intent_line WHERE intent_id = ? ORDER BY rowid")
    .all(intentId) as IntentLineRow[];
  return rows.map(toIntentLine);
}

export function getIntentLinesByFile(db: IntentDatabase, filePath: string): IntentLine[] {
  const rows = db
    .prepare("SELECT * FROM intent_line WHERE file_path = ? ORDER BY rowid")
    .all(filePath) as IntentLineRow[];
  return rows.map(toIntentLine);
}

export function getIntentsBySession(db: IntentDatabase, sessionId: string): Intent[] {
  const rows = db
    .prepare("SELECT * FROM intent WHERE session_id = ? ORDER BY created_at, rowid")
    .all(sessionId) as IntentRow[];
  return rows.map(toIntent);
}

export function getRecentIntents(db: IntentDatabase, limit: number): Intent[] {
  const rows = db
    .prepare("SELECT * FROM intent ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit) as IntentRow[];
  return rows.map(toIntent);
}

export interface IntentStats {
  intents: number;
  lines: number;
  files: number;
}

export function getStats(db: IntentDatabase): IntentStats {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    intents: one("SELECT count(*) AS n FROM intent"),
    lines: one("SELECT count(*) AS n FROM intent_line"),
    files: one("SELECT count(DISTINCT file_path) AS n FROM intent_line"),
  };
}

/**
 * Full-text search over summary + detail, ranked by bm25. `ftsQuery` must be a
 * valid FTS5 MATCH string (see toFtsQuery in query.ts). Returns intent ids,
 * best match first, optionally restricted to intents touching `filePath`.
 */
export function searchIntentIds(
  db: IntentDatabase,
  ftsQuery: string,
  limit: number,
  filePath?: string | null,
): string[] {
  const rows = filePath
    ? (db
        .prepare(
          `SELECT intent.id AS id
             FROM intent_fts
             JOIN intent ON intent.rowid = intent_fts.rowid
            WHERE intent_fts MATCH ?
              AND intent.id IN (SELECT intent_id FROM intent_line WHERE file_path = ?)
            ORDER BY bm25(intent_fts)
            LIMIT ?`,
        )
        .all(ftsQuery, filePath, limit) as Array<{ id: string }>)
    : (db
        .prepare(
          `SELECT intent.id AS id
             FROM intent_fts
             JOIN intent ON intent.rowid = intent_fts.rowid
            WHERE intent_fts MATCH ?
            ORDER BY bm25(intent_fts)
            LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ id: string }>);
  return rows.map((r) => r.id);
}

/**
 * Amend an intent's detail. `append` adds to the existing detail (separated by
 * a blank line); otherwise it replaces. Returns the updated intent, or null if
 * no intent has that id.
 */
export function updateIntentDetail(
  db: IntentDatabase,
  id: string,
  detail: string,
  append: boolean,
): Intent | null {
  const existing = getIntent(db, id);
  if (!existing) return null;

  const next =
    append && existing.detail ? `${existing.detail}\n\n${detail}` : detail;

  db.prepare("UPDATE intent SET detail = ? WHERE id = ?").run(next, id);
  return { ...existing, detail: next };
}
