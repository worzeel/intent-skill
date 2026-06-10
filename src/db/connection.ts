import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getGitDir } from "../git/repo.js";
import { migrations } from "./schema.js";

/**
 * SQLite via node's built-in `node:sqlite` (DatabaseSync) — synchronous, no
 * native module to compile, no runtime dependency. Keeps the whole tool pure JS
 * so it ships as a droppable skill bundle. Foreign keys are on by default
 * (`enableForeignKeyConstraints`).
 */
export type IntentDatabase = DatabaseSync;

export interface OpenOptions {
  /** Open read-only. Skips WAL + migrations (a read-only handle can't write). */
  readonly?: boolean;
}

/** Conventional location of the per-repo intent database, inside `.git/`. */
export async function resolveDbPath(cwd: string): Promise<string> {
  const gitDir = await getGitDir(cwd);
  return path.join(gitDir, "intent.db");
}

/**
 * Open (creating if needed) the intent database at an explicit path and bring
 * it up to the latest schema version. Use {@link openIntentDbForCwd} to derive
 * the path from a repo automatically.
 */
export function openIntentDb(dbPath: string, opts: OpenOptions = {}): IntentDatabase {
  const readonly = opts.readonly ?? false;
  const db = new DatabaseSync(dbPath, { readOnly: readonly });

  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
  }

  return db;
}

/** Open the intent database for whichever repo `cwd` belongs to. */
export async function openIntentDbForCwd(
  cwd: string,
  opts: OpenOptions = {},
): Promise<IntentDatabase> {
  const dbPath = await resolveDbPath(cwd);
  return openIntentDb(dbPath, opts);
}

/**
 * Apply any pending migrations, tracked via PRAGMA user_version. Each migration
 * runs in its own transaction so a failure leaves the version untouched.
 */
export function migrate(db: IntentDatabase): void {
  const current = getUserVersion(db);
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    transaction(db, () => {
      m.up(db);
      // user_version can't be parameterised; version is an internal integer.
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
}

/** Current PRAGMA user_version (schema version) for the connection. */
export function getUserVersion(db: IntentDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Run `fn` inside a transaction. node:sqlite has no `db.transaction()` helper
 * (unlike better-sqlite3), so we drive BEGIN/COMMIT/ROLLBACK by hand. Rethrows
 * after rolling back on failure.
 */
export function transaction<T>(db: IntentDatabase, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
