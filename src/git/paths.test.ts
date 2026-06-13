import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { basename, toRepoRelative } from "./paths.js";

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeTempRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

describe("toRepoRelative", () => {
  it("forces forward slashes on a backslash path", () => {
    expect(toRepoRelative(repo.root, "src\\git\\blob.ts")).toBe("src/git/blob.ts");
  });

  it("leaves an already-canonical key untouched", () => {
    expect(toRepoRelative(repo.root, "src/git/blob.ts")).toBe("src/git/blob.ts");
  });

  it("makes an absolute in-repo path repo-relative", () => {
    const abs = path.join(repo.root, "a", "b.ts");
    expect(toRepoRelative(repo.root, abs)).toBe("a/b.ts");
  });

  it("resolves a relative path against the given base (cwd)", () => {
    // Typed `b.ts` while sitting in the repo's `a/` subdir.
    expect(toRepoRelative(repo.root, "b.ts", path.join(repo.root, "a"))).toBe("a/b.ts");
  });

  it("does not produce a clean relative key for an out-of-repo path", () => {
    const key = toRepoRelative(repo.root, "/etc/hosts");
    expect(key.startsWith("..") || path.isAbsolute(key)).toBe(true);
  });
});

describe("basename", () => {
  it("returns the trailing file name", () => {
    expect(basename("src/git/blob.ts")).toBe("blob.ts");
    expect(basename("blob.ts")).toBe("blob.ts");
  });
});
