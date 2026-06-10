/**
 * Core domain types for intent.
 *
 * These mirror the SQLite schema (see src/db/schema.ts) but use camelCase and
 * explicit nullability. Row <-> domain mapping happens at the db boundary.
 */

/** One logical task / user request / Claude session intent. */
export interface Intent {
  id: string;
  sessionId: string | null;
  summary: string;
  detail: string | null;
  taskRef: string | null;
  createdAt: number;
}

/** One file + blob range anchored to an intent. */
export interface IntentLine {
  id: string;
  intentId: string;
  filePath: string;
  blobHash: string;
  commitHash: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  fragment: string | null;
}
