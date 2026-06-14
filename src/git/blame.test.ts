import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { runGit } from "./exec.js";
import { blameLine, parseBlamePorcelain } from "./blame.js";

describe("parseBlamePorcelain", () => {
  const sample = [
    "1a2b3c4d5e6f70819293a4b5c6d7e8f901234567 12 12 1",
    "author Antonio",
    "author-mail <a@example.com>",
    "author-time 1700000000",
    "author-tz +1300",
    "summary switch to BigInt for precision",
    "filename src/calc.ts",
    "\tconst total = a + b;",
  ].join("\n");

  it("pulls sha, summary, author and time out of porcelain output", () => {
    expect(parseBlamePorcelain(sample)).toEqual({
      commitHash: "1a2b3c4d5e6f70819293a4b5c6d7e8f901234567",
      summary: "switch to BigInt for precision",
      author: "Antonio",
      authorTime: 1700000000,
      uncommitted: false,
    });
  });

  it("flags an all-zero sha as uncommitted", () => {
    const out = "0".repeat(40) + " 1 1 1\nauthor Not Committed Yet\n\tx\n";
    expect(parseBlamePorcelain(out)?.uncommitted).toBe(true);
  });

  it("returns null when there's no parseable sha", () => {
    expect(parseBlamePorcelain("")).toBeNull();
    expect(parseBlamePorcelain("garbage line\n")).toBeNull();
  });
});

describe("blameLine", () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("returns the committing change for a tracked line", async () => {
    await writeFile(path.join(repo.root, "a.txt"), "one\ntwo\nthree\n");
    await runGit(["add", "a.txt"], { cwd: repo.root });
    await runGit(["commit", "-q", "-m", "add a.txt"], { cwd: repo.root });

    const blame = await blameLine(repo.root, "a.txt", 2);
    expect(blame?.summary).toBe("add a.txt");
    expect(blame?.author).toBe("Test");
    expect(blame?.uncommitted).toBe(false);
    expect(blame?.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("flags an uncommitted line", async () => {
    await writeFile(path.join(repo.root, "a.txt"), "committed\n");
    await runGit(["add", "a.txt"], { cwd: repo.root });
    await runGit(["commit", "-q", "-m", "init"], { cwd: repo.root });
    await writeFile(path.join(repo.root, "a.txt"), "committed\nbrand new\n");

    expect((await blameLine(repo.root, "a.txt", 2))?.uncommitted).toBe(true);
  });

  it("returns null for an untracked file", async () => {
    await writeFile(path.join(repo.root, "ghost.txt"), "x\n");
    expect(await blameLine(repo.root, "ghost.txt", 1)).toBeNull();
  });
});
