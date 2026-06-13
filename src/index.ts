/**
 * intent public API.
 *
 * Milestone 1 surface: domain types, the per-repo SQLite database (schema +
 * migrations), and git blob-hash resolution. Write/read MCP tools and the CLI
 * land in later milestones.
 */

export type { Intent, IntentLine } from "./types.js";

// Database
export {
  openIntentDb,
  openIntentDbForCwd,
  resolveDbPath,
  migrate,
  transaction,
  getUserVersion,
  type IntentDatabase,
  type OpenOptions,
} from "./db/connection.js";
export { migrations, LATEST_SCHEMA_VERSION, type Migration } from "./db/schema.js";
export {
  createIntent,
  insertIntentLine,
  getIntent,
  getIntentLines,
  updateIntentDetail,
  type NewIntent,
  type NewIntentLine,
} from "./db/intents.js";

// Capture service (write-side)
export {
  annotateIntent,
  updateIntent,
  type CaptureContext,
  type AnnotateParams,
  type AnnotateResult,
  type UpdateParams,
} from "./capture.js";

// Query service (read-side)
export {
  getIntentAtLine,
  getFileIntent,
  searchIntent,
  getSessionIntent,
  getAllResolvedIntents,
  toFtsQuery,
  type QueryContext,
  type ResolvedIntent,
  type ResolvedIntentLine,
} from "./query.js";
export {
  getAllIntents,
  getRecentIntents,
  getStats,
  backfillCommitHash,
  type IntentStats,
} from "./db/intents.js";

// Post-commit backfill
export {
  backfillHeadCommit,
  type BackfillContext,
  type BackfillResult,
} from "./backfill.js";

// Transcript backfill (recover provenance from Claude Code session transcripts)
export {
  backfillFromEdits,
  backfillFromTranscriptFile,
  resolveCandidates,
  resolveCandidatesFromFile,
  discoverTranscripts,
  type BackfillCandidate,
  type ResolvedCandidates,
  type TranscriptBackfillResult,
} from "./backfill-transcript.js";
export { parseTranscript, type TranscriptEdit } from "./transcript.js";

// CLI
export {
  runCommand,
  helpText,
  UsageError,
  type CommandDeps,
} from "./cli/commands.js";
export { parseArgs, type ParsedArgs } from "./cli/parse.js";

// Claude Code hook integration
export {
  handleHook,
  buildSessionStartContext,
  buildPreEditContext,
  buildPostEditReminder,
  relevantFile,
  type HookContext,
  type HookInput,
  type HookOutput,
} from "./hooks/handler.js";

// Git anchoring
export { runGit, GitError, type GitRunOptions } from "./git/exec.js";
export { getRepoRoot, getGitDir, isGitRepo } from "./git/repo.js";
export { getHeadCommit, getCommitBlobs } from "./git/commit.js";
export {
  hashFile,
  hashContent,
  blobExists,
  getBlob,
  resolveAnchor,
  locateFragment,
  type HashOptions,
  type AnchorStatus,
  type AnchorInput,
  type ResolvedAnchor,
} from "./git/blob.js";
