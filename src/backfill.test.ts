import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "./test-helpers.js";
import { openIntentDb, type IntentDatabase } from "./db/connection.js";
import { getIntentLines } from "./db/intents.js";
import { annotateIntent, type CaptureContext } from "./capture.js";
import { backfillHeadCommit } from "./backfill.js";
import { runGit } from "./git/exec.js";

let repo: TempRepo;
let db: IntentDatabase;
let ctx: CaptureContext;

beforeEach(async () => {
  repo = await makeTempRepo();
  db = openIntentDb(":memory:");
  ctx = { db, repoRoot: repo.root };
});

afterEach(async () => {
  db.close();
  await repo.cleanup();
});

function write(rel: string, content: string): Promise<void> {
  return writeFile(path.join(repo.root, rel), content);
}

async function commit(message: string, ...paths: string[]): Promise<string> {
  await runGit(["add", ...(paths.length ? paths : ["-A"])], { cwd: repo.root });
  await runGit(["commit", "-q", "-m", message], { cwd: repo.root });
  return (await runGit(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
}

describe("backfillHeadCommit", () => {
  it("stamps commit_hash on a pending row once its blob is committed", async () => {
    await write("a.ts", "alpha\nbeta\n");
    // Captured pre-commit — commit_hash starts NULL.
    const { intentId } = await annotateIntent(ctx, {
      file: "a.ts",
      lineStart: 1,
      lineEnd: 2,
      summary: "Add a",
    });
    expect(getIntentLines(db, intentId)[0].commitHash).toBeNull();

    const head = await commit("add a");
    const result = await backfillHeadCommit(ctx);

    expect(result.commit).toBe(head);
    expect(result.updated).toBe(1);
    expect(getIntentLines(db, intentId)[0].commitHash).toBe(head);
  });

  it("is idempotent — a second run updates nothing", async () => {
    await write("a.ts", "alpha\n");
    await annotateIntent(ctx, { file: "a.ts", lineStart: 1, lineEnd: 1, summary: "Add a" });
    await commit("add a");

    expect((await backfillHeadCommit(ctx)).updated).toBe(1);
    expect((await backfillHeadCommit(ctx)).updated).toBe(0);
  });

  it("leaves rows whose blob isn't in the HEAD commit untouched", async () => {
    // Capture b.ts but never commit it; commit only a.ts.
    await write("b.ts", "uncommitted\n");
    const { intentId } = await annotateIntent(ctx, {
      file: "b.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "Add b",
    });

    await write("a.ts", "committed\n");
    await commit("add a only", "a.ts");

    expect((await backfillHeadCommit(ctx)).updated).toBe(0);
    expect(getIntentLines(db, intentId)[0].commitHash).toBeNull();
  });
});
