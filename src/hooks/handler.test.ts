import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { openIntentDb, type IntentDatabase } from "../db/connection.js";
import { annotateIntent } from "../capture.js";
import { handleHook, relevantFile, type HookContext } from "./handler.js";

let repo: TempRepo;
let db: IntentDatabase;
let ctx: HookContext;

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

function context(out: Awaited<ReturnType<typeof handleHook>>): string | undefined {
  return out.hookSpecificOutput?.additionalContext;
}

describe("relevantFile", () => {
  it("relativises an absolute path under the repo root", () => {
    expect(relevantFile("/repo", { file_path: "/repo/src/a.ts" })).toBe("src/a.ts");
  });
  it("passes through an already-relative path", () => {
    expect(relevantFile("/repo", { file_path: "src/a.ts" })).toBe("src/a.ts");
  });
  it("rejects paths outside the repo", () => {
    expect(relevantFile("/repo", { file_path: "/etc/passwd" })).toBeNull();
  });
  it("reads notebook_path too, and null when absent", () => {
    expect(relevantFile("/repo", { notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
    expect(relevantFile("/repo", {})).toBeNull();
  });
});

describe("SessionStart", () => {
  it("returns nothing for an empty database", async () => {
    const out = await handleHook(ctx, { hook_event_name: "SessionStart", source: "startup" });
    expect(out).toEqual({});
  });

  it("summarises recorded intents", async () => {
    await write("a.ts", "x\n");
    await annotateIntent(ctx, { file: "a.ts", lineStart: 1, lineEnd: 1, summary: "Add retry logic", taskRef: "GH-1" });

    const out = await handleHook(ctx, { hook_event_name: "SessionStart", source: "startup" });
    const text = context(out);
    expect(text).toContain("1 intent(s) recorded across 1 file(s)");
    expect(text).toContain("Add retry logic (GH-1)");
    expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
  });
});

describe("PreToolUse", () => {
  it("injects provenance for the file about to be edited", async () => {
    await write("api.ts", "retry()\n");
    await annotateIntent(ctx, { file: "api.ts", lineStart: 1, lineEnd: 1, summary: "Add retry", detail: "backoff" });

    const out = await handleHook(ctx, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo.root, "api.ts") },
    });
    const text = context(out);
    expect(text).toContain("Existing intent provenance for api.ts");
    expect(text).toContain("Add retry — backoff");
    expect(text).toContain("[L1]");
  });

  it("is silent for a file with no recorded intent", async () => {
    await write("new.ts", "x\n");
    const out = await handleHook(ctx, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "new.ts" },
    });
    expect(out).toEqual({});
  });

  it("ignores non-edit tools", async () => {
    const out = await handleHook(ctx, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(out).toEqual({});
  });
});

describe("PostToolUse", () => {
  it("nudges to annotate after an edit", async () => {
    const out = await handleHook(ctx, {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/new.ts" },
    });
    expect(context(out)).toContain("intent annotate --json -");
    expect(context(out)).toContain("src/new.ts");
  });
});

it("ignores unknown events", async () => {
  expect(await handleHook(ctx, { hook_event_name: "Stop" })).toEqual({});
});
