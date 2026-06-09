import path from "node:path";
import Database from "better-sqlite3";
import { getGitDir } from "../git/repo.js";
import { migrations } from "./schema.js";

export type IntentDatabase = Database.Database;

export interface OpenOptions {
  /** Open read-only. Skips migrations (a read-only handle cannot write schema). */
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
  const db = new Database(dbPath, { readonly });

  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  } else {
    db.pragma("foreign_keys = ON");
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
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    const apply = db.transaction(() => {
      m.up(db);
      // user_version can't be parameterised; version is an internal integer.
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
  }
}
