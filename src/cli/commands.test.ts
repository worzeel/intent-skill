import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { openIntentDb, type IntentDatabase } from "../db/connection.js";
import type { CaptureContext } from "../capture.js";
import { parseArgs } from "./parse.js";
import { runCommand, UsageError } from "./commands.js";

const BOOL = new Set(["json", "help"]);

let repo: TempRepo;
let db: IntentDatabase;
let ctx: CaptureContext;

beforeEach(async () => {
  repo = await makeTempRepo();
  db = openIntentDb(":memory:");
  ctx = { db, repoRoot: repo.root, sessionId: "sess-1" };
});

afterEach(async () => {
  db.close();
  await repo.cleanup();
});

function write(rel: string, content: string): Promise<void> {
  return writeFile(path.join(repo.root, rel), content);
}

/** Run a CLI invocation; `stdin` feeds write commands their JSON payload. */
function run(argv: string[], stdin = ""): Promise<string> {
  return runCommand(ctx, parseArgs(argv, BOOL), { readStdin: async () => stdin });
}

/** Capture a fresh intent and return its id (via the annotate command). */
async function seed(file: string, summary: string, detail?: string): Promise<string> {
  await write(file, "alpha\nbeta\ngamma\n");
  const out = await run(
    ["annotate", "--json"],
    JSON.stringify({ file, line_start: 1, line_end: 2, summary, detail }),
  );
  return (JSON.parse(out) as { intent_id: string }).intent_id;
}

describe("annotate", () => {
  it("captures from a stdin JSON payload and reports the new id", async () => {
    await write("a.ts", "one\ntwo\n");
    const out = await run(
      ["annotate", "--json"],
      JSON.stringify({ file: "a.ts", line_start: 1, line_end: 2, summary: "Add thing" }),
    );
    const parsed = JSON.parse(out) as { intent_id: string; blob_hash: string };
    expect(parsed.intent_id).toMatch(/[0-9a-f-]{36}/);
    expect(parsed.blob_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects a payload missing required fields", async () => {
    await write("a.ts", "one\n");
    await expect(run(["annotate"], JSON.stringify({ file: "a.ts" }))).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("rejects non-JSON stdin", async () => {
    await expect(run(["annotate"], "not json")).rejects.toBeInstanceOf(UsageError);
  });

  it("tags the intent with the context session id", async () => {
    const id = await seed("a.ts", "Add thing");
    const out = await run(["session", "sess-1", "--json"]);
    const ids = (JSON.parse(out) as { intents: Array<{ intent_id: string }> }).intents.map(
      (i) => i.intent_id,
    );
    expect(ids).toContain(id);
  });
});

describe("update", () => {
  it("appends detail to an existing intent", async () => {
    const id = await seed("a.ts", "Add thing", "first");
    await run(["update"], JSON.stringify({ intent_id: id, detail: "second" }));
    const out = await run(["session", "sess-1", "--json"]);
    const intent = (JSON.parse(out) as { intents: Array<{ intent_id: string; detail: string }> }).intents.find(
      (i) => i.intent_id === id,
    );
    expect(intent?.detail).toBe("first\n\nsecond");
  });
});

describe("read commands", () => {
  it("show returns the intent covering a line", async () => {
    await seed("a.ts", "Add thing");
    const out = await run(["show", "a.ts:1", "--json"]);
    const intents = (JSON.parse(out) as { intents: unknown[] }).intents;
    expect(intents).toHaveLength(1);
  });

  it("file lists all intent for a path (alias log too)", async () => {
    await seed("a.ts", "Add thing");
    const viaFile = await run(["file", "a.ts", "--json"]);
    const viaLog = await run(["log", "a.ts", "--json"]);
    expect(viaFile).toBe(viaLog);
    expect((JSON.parse(viaFile) as { intents: unknown[] }).intents).toHaveLength(1);
  });

  it("search matches on summary text", async () => {
    await seed("a.ts", "Add retry logic to client");
    const out = await run(["search", "retry", "--json"]);
    expect((JSON.parse(out) as { intents: unknown[] }).intents).toHaveLength(1);
  });

  it("stats summarises the repo", async () => {
    await seed("a.ts", "Add thing");
    const out = await run(["stats", "--json"]);
    expect(JSON.parse(out)).toEqual({ intents: 1, lines: 1, files: 1 });
  });

  it("human output is the default and reads cleanly", async () => {
    await seed("a.ts", "Add retry logic", "because the API flakes");
    const out = await run(["file", "a.ts"]);
    expect(out).toContain("Add retry logic");
    expect(out).toContain("why: because the API flakes");
    expect(out).toContain("a.ts");
  });
});

describe("export", () => {
  it("emits one ndjson line per intent", async () => {
    await seed("a.ts", "First");
    await seed("b.ts", "Second");
    const out = await run(["export"]);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("usage", () => {
  it("unknown command throws UsageError", async () => {
    await expect(run(["frobnicate"])).rejects.toBeInstanceOf(UsageError);
  });

  it("show without a target throws UsageError", async () => {
    await expect(run(["show"])).rejects.toBeInstanceOf(UsageError);
  });

  it("bad show target throws UsageError", async () => {
    await expect(run(["show", "a.ts"])).rejects.toBeInstanceOf(UsageError);
  });

  it("help returns usage text", async () => {
    const out = await run(["help"]);
    expect(out).toContain("intent show <file>:<line>");
  });
});
