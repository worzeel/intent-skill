import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

/**
 * Ordered schema migrations. Applied by version against PRAGMA user_version.
 * Never edit a shipped migration in place — add a new one.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        -- One record per logical task / user request / Claude session intent
        CREATE TABLE intent (
          id          TEXT PRIMARY KEY,
          session_id  TEXT,
          summary     TEXT NOT NULL,
          detail      TEXT,
          task_ref    TEXT,
          created_at  INTEGER NOT NULL
        );

        -- One record per file + blob range anchored to an intent
        CREATE TABLE intent_line (
          id          TEXT PRIMARY KEY,
          intent_id   TEXT NOT NULL REFERENCES intent(id) ON DELETE CASCADE,
          file_path   TEXT NOT NULL,
          blob_hash   TEXT NOT NULL,
          commit_hash TEXT,
          line_start  INTEGER,
          line_end    INTEGER,
          fragment    TEXT
        );

        CREATE INDEX idx_intent_line_file ON intent_line(file_path);
        CREATE INDEX idx_intent_line_blob ON intent_line(blob_hash);
        CREATE INDEX idx_intent_line_intent ON intent_line(intent_id);
        CREATE INDEX idx_intent_session ON intent(session_id);

        -- Full-text search over summary + detail, kept in sync via triggers.
        CREATE VIRTUAL TABLE intent_fts USING fts5(
          summary,
          detail,
          content=intent,
          content_rowid=rowid
        );

        CREATE TRIGGER intent_ai AFTER INSERT ON intent BEGIN
          INSERT INTO intent_fts(rowid, summary, detail)
          VALUES (new.rowid, new.summary, new.detail);
        END;

        CREATE TRIGGER intent_ad AFTER DELETE ON intent BEGIN
          INSERT INTO intent_fts(intent_fts, rowid, summary, detail)
          VALUES ('delete', old.rowid, old.summary, old.detail);
        END;

        CREATE TRIGGER intent_au AFTER UPDATE ON intent BEGIN
          INSERT INTO intent_fts(intent_fts, rowid, summary, detail)
          VALUES ('delete', old.rowid, old.summary, old.detail);
          INSERT INTO intent_fts(rowid, summary, detail)
          VALUES (new.rowid, new.summary, new.detail);
        END;
      `);
    },
  },
];

/** Highest migration version defined. */
export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
