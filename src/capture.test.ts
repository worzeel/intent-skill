import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "./test-helpers.js";
import { openIntentDb, type IntentDatabase } from "./db/connection.js";
import { getIntent, getIntentLines } from "./db/intents.js";
import { runGit } from "./git/exec.js";
import { annotateIntent, updateIntent } from "./capture.js";

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

async function writeRepoFile(rel: string, content: string): Promise<void> {
  await writeFile(path.join(repo.root, rel), content);
}

describe("annotateIntent", () => {
  it("creates an intent + line with the git blob hash and a fragment", async () => {
    await writeRepoFile("api.ts", "function a() {}\nfunction retry() {}\nfunction b() {}\n");

    const result = await annotateIntent(
      { db, repoRoot: repo.root },
      {
        file: "api.ts",
        lineStart: 2,
        lineEnd: 2,
        summary: "Add retry logic",
        detail: "exponential backoff",
        taskRef: "GH-1",
      },
    );

    const gitHash = (await runGit(["hash-object", "api.ts"], { cwd: repo.root })).trim();
    expect(result.blobHash).toBe(gitHash);
    expect(result.fragment).toBe("function retry() {}");

    const intent = getIntent(db, result.intentId);
    expect(intent).toMatchObject({ summary: "Add retry logic", detail: "exponential backoff", taskRef: "GH-1" });

    const lines = getIntentLines(db, result.intentId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ filePath: "api.ts", blobHash: gitHash, lineStart: 2, lineEnd: 2 });
  });

  it("persists the blob so it is resolvable before any commit", async () => {
    await writeRepoFile("a.ts", "const x = 1;\n");
    const result = await annotateIntent({ db, repoRoot: repo.root }, {
      file: "a.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "init",
    });

    // cat-file -e succeeds only if the blob is in the object store
    await expect(
      runGit(["cat-file", "-e", `${result.blobHash}^{blob}`], { cwd: repo.root }),
    ).resolves.toBeDefined();
  });

  it("attaches a second file to an existing intent when intent_id is given", async () => {
    await writeRepoFile("controller.ts", "// controller\n");
    await writeRepoFile("service.ts", "// service\n");

    const first = await annotateIntent({ db, repoRoot: repo.root }, {
      file: "controller.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "Add endpoint",
    });

    const second = await annotateIntent({ db, repoRoot: repo.root }, {
      file: "service.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "ignored when attaching",
      intentId: first.intentId,
    });

    expect(second.intentId).toBe(first.intentId);
    const lines = getIntentLines(db, first.intentId);
    expect(lines.map((l) => l.filePath).sort()).toEqual(["controller.ts", "service.ts"]);
  });

  it("throws when attaching to a non-existent intent", async () => {
    await writeRepoFile("a.ts", "x\n");
    await expect(
      annotateIntent({ db, repoRoot: repo.root }, {
        file: "a.ts",
        lineStart: 1,
        lineEnd: 1,
        summary: "x",
        intentId: "does-not-exist",
      }),
    ).rejects.toThrow(/intent not found/);
  });

  it("uses the context session id when none is supplied", async () => {
    await writeRepoFile("a.ts", "x\n");
    const result = await annotateIntent(
      { db, repoRoot: repo.root, sessionId: "sess-123" },
      { file: "a.ts", lineStart: 1, lineEnd: 1, summary: "x" },
    );
    expect(getIntent(db, result.intentId)?.sessionId).toBe("sess-123");
  });
});

describe("updateIntent", () => {
  it("appends to existing detail by default", async () => {
    await writeRepoFile("a.ts", "x\n");
    const { intentId } = await annotateIntent({ db, repoRoot: repo.root }, {
      file: "a.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "x",
      detail: "first",
    });

    const updated = updateIntent({ db, repoRoot: repo.root }, { intentId, detail: "second" });
    expect(updated.detail).toBe("first\n\nsecond");
  });

  it("replaces detail when append is false", async () => {
    await writeRepoFile("a.ts", "x\n");
    const { intentId } = await annotateIntent({ db, repoRoot: repo.root }, {
      file: "a.ts",
      lineStart: 1,
      lineEnd: 1,
      summary: "x",
      detail: "first",
    });

    const updated = updateIntent(
      { db, repoRoot: repo.root },
      { intentId, detail: "replaced", append: false },
    );
    expect(updated.detail).toBe("replaced");
  });

  it("throws for an unknown intent", () => {
    expect(() =>
      updateIntent({ db, repoRoot: repo.root }, { intentId: "nope", detail: "x" }),
    ).toThrow(/intent not found/);
  });
});
