import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "./test-helpers.js";
import { openIntentDb, type IntentDatabase } from "./db/connection.js";
import { annotateIntent } from "./capture.js";
import {
  getFileIntent,
  getIntentAtLine,
  getSessionIntent,
  searchIntent,
  toFtsQuery,
} from "./query.js";

let repo: TempRepo;
let db: IntentDatabase;

beforeEach(async () => {
  repo = await makeTempRepo();
  db = openIntentDb(":memory:");
});

afterEach(async () => {
  db.close();
  await repo.cleanup();
});

function write(rel: string, content: string): Promise<void> {
  return writeFile(path.join(repo.root, rel), content);
}

const ctx = () => ({ db, repoRoot: repo.root });

describe("getIntentAtLine", () => {
  it("returns intents covering a line in the unchanged file", async () => {
    await write("api.ts", "a\nb\nretry()\nc\n");
    await annotateIntent(ctx(), { file: "api.ts", lineStart: 3, lineEnd: 3, summary: "retry" });

    const hit = await getIntentAtLine(ctx(), "api.ts", 3);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.intent.summary).toBe("retry");
    expect(hit[0]!.lines[0]).toMatchObject({ status: "exact", currentLineStart: 3 });

    expect(await getIntentAtLine(ctx(), "api.ts", 1)).toHaveLength(0);
  });

  it("follows the line via fragment after the file drifts", async () => {
    await write("api.ts", "retry()\n");
    await annotateIntent(ctx(), { file: "api.ts", lineStart: 1, lineEnd: 1, summary: "retry" });

    // Insert two lines above — the anchored code moves to line 3.
    await write("api.ts", "header\nimports\nretry()\n");

    expect(await getIntentAtLine(ctx(), "api.ts", 1)).toHaveLength(0);
    const moved = await getIntentAtLine(ctx(), "api.ts", 3);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.lines[0]).toMatchObject({ status: "fragment", currentLineStart: 3 });
  });
});

describe("getFileIntent", () => {
  it("returns all intents for a file ordered by current line", async () => {
    await write("api.ts", "one\ntwo\nthree\nfour\n");
    await annotateIntent(ctx(), { file: "api.ts", lineStart: 3, lineEnd: 3, summary: "third" });
    await annotateIntent(ctx(), { file: "api.ts", lineStart: 1, lineEnd: 1, summary: "first" });

    const all = await getFileIntent(ctx(), "api.ts");
    expect(all.map((r) => r.intent.summary)).toEqual(["first", "third"]);
  });
});

describe("searchIntent", () => {
  beforeEach(async () => {
    await write("api.ts", "x\n");
    await write("ui.ts", "y\n");
    await annotateIntent(ctx(), {
      file: "api.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "Add retry logic to API client",
      detail: "exponential backoff with jitter",
    });
    await annotateIntent(ctx(), {
      file: "ui.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "Fix button alignment",
      detail: "flexbox tweak",
    });
  });

  it("finds intents by summary/detail terms", async () => {
    const hits = await searchIntent(ctx(), "retry backoff");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.intent.summary).toBe("Add retry logic to API client");
  });

  it("scopes results to a file when given", async () => {
    expect(await searchIntent(ctx(), "logic", { file: "ui.ts" })).toHaveLength(0);
    expect(await searchIntent(ctx(), "logic", { file: "api.ts" })).toHaveLength(1);
  });

  it("does not choke on punctuation-only queries", async () => {
    expect(await searchIntent(ctx(), "!!! ---")).toEqual([]);
  });

  it("survives punctuation mixed with real terms", async () => {
    const hits = await searchIntent(ctx(), "retry-logic!");
    expect(hits).toHaveLength(1);
  });
});

describe("getSessionIntent", () => {
  it("returns intents for a session, resolved", async () => {
    await write("a.ts", "x\n");
    await write("b.ts", "y\n");
    await annotateIntent({ ...ctx(), sessionId: "s1" }, { file: "a.ts", lineStart: 1, lineEnd: 1, summary: "a" });
    await annotateIntent({ ...ctx(), sessionId: "s2" }, { file: "b.ts", lineStart: 1, lineEnd: 1, summary: "b" });

    const s1 = await getSessionIntent(ctx(), "s1");
    expect(s1.map((r) => r.intent.summary)).toEqual(["a"]);
    expect(s1[0]!.lines[0]!.status).toBe("exact");
  });
});

describe("toFtsQuery", () => {
  it("quotes and ANDs tokens", () => {
    expect(toFtsQuery("retry logic")).toBe('"retry" "logic"');
  });
  it("strips punctuation", () => {
    expect(toFtsQuery("retry-logic!")).toBe('"retry" "logic"');
  });
  it("returns null when nothing is searchable", () => {
    expect(toFtsQuery("!!! ---")).toBeNull();
  });
});
