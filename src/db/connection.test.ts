import path from "node:path";
import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { LATEST_SCHEMA_VERSION } from "./schema.js";
import { migrate, openIntentDb, openIntentDbForCwd, resolveDbPath } from "./connection.js";

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeTempRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

function tableNames(db: ReturnType<typeof openIntentDb>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
}

describe("schema + migrations", () => {
  it("creates the expected tables and sets user_version", () => {
    const db = openIntentDb(":memory:");
    const names = tableNames(db);

    expect(names).toContain("intent");
    expect(names).toContain("intent_line");
    expect(names).toContain("intent_fts");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    db.close();
  });

  it("is idempotent — re-running migrate applies nothing new", () => {
    const db = openIntentDb(":memory:");
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("keeps the FTS index in sync via triggers", () => {
    const db = openIntentDb(":memory:");
    db.prepare(
      "INSERT INTO intent (id, summary, detail, created_at) VALUES (?, ?, ?, ?)",
    ).run("i1", "Add retry logic to API client", "exponential backoff with jitter", 1700000000);

    const hit = db
      .prepare("SELECT id FROM intent WHERE rowid IN (SELECT rowid FROM intent_fts WHERE intent_fts MATCH ?)")
      .get("retry");
    expect(hit).toMatchObject({ id: "i1" });

    // Deletion should also propagate out of the FTS index.
    db.prepare("DELETE FROM intent WHERE id = ?").run("i1");
    const afterDelete = db
      .prepare("SELECT count(*) AS n FROM intent_fts WHERE intent_fts MATCH ?")
      .get("retry") as { n: number };
    expect(afterDelete.n).toBe(0);

    db.close();
  });

  it("cascades intent_line deletes when the parent intent is removed", () => {
    const db = openIntentDb(":memory:");
    db.prepare("INSERT INTO intent (id, summary, created_at) VALUES (?, ?, ?)").run(
      "i1",
      "summary",
      1,
    );
    db.prepare(
      "INSERT INTO intent_line (id, intent_id, file_path, blob_hash) VALUES (?, ?, ?, ?)",
    ).run("l1", "i1", "a.ts", "deadbeef");

    db.prepare("DELETE FROM intent WHERE id = ?").run("i1");
    const rows = db.prepare("SELECT count(*) AS n FROM intent_line").get() as { n: number };
    expect(rows.n).toBe(0);

    db.close();
  });
});

describe("repo-scoped open", () => {
  it("resolves the db path inside the repo's .git dir", async () => {
    const dbPath = await resolveDbPath(repo.root);
    // git resolves symlinks (macOS /var -> /private/var), so compare realpaths.
    const expected = path.join(await realpath(repo.root), ".git", "intent.db");
    expect(dbPath).toBe(expected);
  });

  it("opens and migrates a real on-disk db for the repo", async () => {
    const db = await openIntentDbForCwd(repo.root);
    expect(tableNames(db)).toContain("intent");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});
