import { transaction, type IntentDatabase } from "./db/connection.js";
import { backfillCommitHash } from "./db/intents.js";
import { getCommitBlobs, getHeadCommit } from "./git/commit.js";

/**
 * Post-commit backfill service. Blob hashes are captured pre-commit (so intent
 * is recorded the moment Claude writes), which leaves `commit_hash` NULL until
 * the content is committed. Run after a commit to stamp the now-known commit
 * onto any pending rows whose blob landed in it. Transport-agnostic.
 */

export interface BackfillContext {
  db: IntentDatabase;
  repoRoot: string;
}

export interface BackfillResult {
  commit: string;
  updated: number;
}

/** Backfill `commit_hash` for pending rows whose blob is in the HEAD commit. */
export async function backfillHeadCommit(ctx: BackfillContext): Promise<BackfillResult> {
  const commit = await getHeadCommit(ctx.repoRoot);
  const blobs = await getCommitBlobs(ctx.repoRoot, commit);
  const updated = transaction(ctx.db, () => backfillCommitHash(ctx.db, commit, blobs));
  return { commit, updated };
}
