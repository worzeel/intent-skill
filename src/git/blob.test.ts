import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { runGit } from "./exec.js";
import {
  blobExists,
  getBlob,
  hashContent,
  hashFile,
  locateFragment,
  resolveAnchor,
} from "./blob.js";

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeTempRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

describe("hashFile / hashContent", () => {
  it("matches git's own blob hash for a working file", async () => {
    await writeFile(path.join(repo.root, "a.txt"), "hello world\n");
    const ours = await hashFile(repo.root, "a.txt");
    const gits = (await runGit(["hash-object", "a.txt"], { cwd: repo.root })).trim();
    expect(ours).toBe(gits);
  });

  it("hashes in-memory content identically to the same file on disk", async () => {
    const content = "line one\nline two\n";
    await writeFile(path.join(repo.root, "b.txt"), content);
    const fromFile = await hashFile(repo.root, "b.txt");
    const fromContent = await hashContent(repo.root, content);
    expect(fromContent).toBe(fromFile);
  });

  it("writes the blob to the object store when write:true", async () => {
    const hash = await hashContent(repo.root, "persist me\n", { write: true });
    expect(await blobExists(repo.root, hash)).toBe(true);
    expect(await getBlob(repo.root, hash)).toBe("persist me\n");
  });

  it("does not persist the blob without write:true", async () => {
    const hash = await hashContent(repo.root, "ephemeral\n");
    expect(await blobExists(repo.root, hash)).toBe(false);
  });
});

describe("locateFragment", () => {
  it("finds a single-line fragment", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(locateFragment(content, "beta")).toEqual({ start: 2, end: 2 });
  });

  it("finds a multi-line fragment spanning the right range", () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    expect(locateFragment(content, "beta\ngamma")).toEqual({ start: 2, end: 3 });
  });

  it("returns null when the fragment is absent", () => {
    expect(locateFragment("alpha\nbeta\n", "zeta")).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("reports exact when the working file is unchanged", async () => {
    await writeFile(path.join(repo.root, "f.txt"), "one\ntwo\nthree\n");
    const blobHash = await hashFile(repo.root, "f.txt", { write: true });

    const resolved = await resolveAnchor(repo.root, {
      filePath: "f.txt",
      blobHash,
      lineStart: 2,
      lineEnd: 2,
      fragment: "two",
    });

    expect(resolved.status).toBe("exact");
    expect(resolved.currentBlobHash).toBe(blobHash);
    expect(resolved).toMatchObject({ lineStart: 2, lineEnd: 2 });
  });

  it("relocates via fragment after the file drifts", async () => {
    const file = path.join(repo.root, "f.txt");
    await writeFile(file, "two\nthree\n");
    const blobHash = await hashFile(repo.root, "f.txt", { write: true });

    // Prepend lines so the anchored content moves down.
    await writeFile(file, "zero\none\ntwo\nthree\n");

    const resolved = await resolveAnchor(repo.root, {
      filePath: "f.txt",
      blobHash,
      lineStart: 1,
      lineEnd: 1,
      fragment: "two",
    });

    expect(resolved.status).toBe("fragment");
    expect(resolved.lineStart).toBe(3);
    expect(resolved.currentBlobHash).not.toBe(blobHash);
  });

  it("reports drifted when the fragment can no longer be found", async () => {
    const file = path.join(repo.root, "f.txt");
    await writeFile(file, "needle\n");
    const blobHash = await hashFile(repo.root, "f.txt", { write: true });
    await writeFile(file, "completely different\n");

    const resolved = await resolveAnchor(repo.root, {
      filePath: "f.txt",
      blobHash,
      lineStart: 1,
      lineEnd: 1,
      fragment: "needle",
    });

    expect(resolved.status).toBe("drifted");
  });

  it("reports missing when the file is gone", async () => {
    const file = path.join(repo.root, "f.txt");
    await writeFile(file, "bye\n");
    const blobHash = await hashFile(repo.root, "f.txt", { write: true });
    await rm(file);

    const resolved = await resolveAnchor(repo.root, {
      filePath: "f.txt",
      blobHash,
      fragment: "bye",
    });

    expect(resolved.status).toBe("missing");
    expect(resolved.currentBlobHash).toBeNull();
  });
});
