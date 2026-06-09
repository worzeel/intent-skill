/**
 * mcp-intent public API.
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
  type IntentDatabase,
  type OpenOptions,
} from "./db/connection.js";
export { migrations, LATEST_SCHEMA_VERSION, type Migration } from "./db/schema.js";

// Git anchoring
export { runGit, GitError, type GitRunOptions } from "./git/exec.js";
export { getRepoRoot, getGitDir, isGitRepo } from "./git/repo.js";
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
