import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { runGit } from "../git/exec.js";
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

describe("show — git blame fallback", () => {
  async function commit(rel: string, content: string, msg: string): Promise<void> {
    await write(rel, content);
    await runGit(["add", rel], { cwd: repo.root });
    await runGit(["commit", "-q", "-m", msg], { cwd: repo.root });
  }

  it("falls back to the last-touching commit when no intent covers the line", async () => {
    await commit("b.ts", "line one\nline two\n", "add b.ts");
    const out = await run(["show", "b.ts:1"]);
    expect(out).toContain("No recorded intent for b.ts:1");
    expect(out).toContain("git blame");
    expect(out).toContain("add b.ts");
  });

  it("--json reports the blame source and commit", async () => {
    await commit("b.ts", "x\n", "add b.ts");
    const parsed = JSON.parse(await run(["show", "b.ts:1", "--json"])) as {
      intents: unknown[];
      source: string;
      blame: { summary: string; commit_hash: string } | null;
    };
    expect(parsed.intents).toHaveLength(0);
    expect(parsed.source).toBe("git-blame");
    expect(parsed.blame?.summary).toBe("add b.ts");
  });

  it("reports source none for an untracked file with no intent", async () => {
    await write("loose.ts", "y\n");
    const parsed = JSON.parse(await run(["show", "loose.ts:1", "--json"])) as { source: string };
    expect(parsed.source).toBe("none");
  });

  it("prefers a recorded intent over blame", async () => {
    await commit("c.ts", "alpha\nbeta\ngamma\n", "add c.ts");
    await run(
      ["annotate", "--json"],
      JSON.stringify({ file: "c.ts", line_start: 1, line_end: 2, summary: "Real intent" }),
    );
    const out = await run(["show", "c.ts:1"]);
    expect(out).toContain("Real intent");
    expect(out).not.toContain("git blame");
  });
});

describe("file — current vs superseded", () => {
  /** Seed a live intent and a drifted (superseded) one for the same file. */
  async function seedTwoGenerations(): Promise<void> {
    await write("a.ts", "old logic here\n");
    await run(
      ["annotate", "--json"],
      JSON.stringify({ file: "a.ts", line_start: 1, line_end: 1, summary: "Old approach" }),
    );
    // Overwrite so the first anchor can't relocate (drifts → superseded).
    await write("a.ts", "new shiny logic\n");
    await run(
      ["annotate", "--json"],
      JSON.stringify({ file: "a.ts", line_start: 1, line_end: 1, summary: "New approach" }),
    );
  }

  it("splits the human output under current/superseded headers", async () => {
    await seedTwoGenerations();
    const out = await run(["file", "a.ts"]);
    expect(out).toContain("# current");
    expect(out).toContain("# superseded");
    const supIdx = out.indexOf("# superseded");
    expect(out.slice(0, supIdx)).toContain("New approach");
    expect(out.slice(supIdx)).toContain("Old approach");
  });

  it("flags superseded intents in --json", async () => {
    await seedTwoGenerations();
    const intents = (
      JSON.parse(await run(["file", "a.ts", "--json"])) as {
        intents: Array<{ summary: string; superseded: boolean }>;
      }
    ).intents;
    expect(intents.find((i) => i.summary === "New approach")?.superseded).toBe(false);
    expect(intents.find((i) => i.summary === "Old approach")?.superseded).toBe(true);
  });

  it("stays flat (no headers) when nothing is superseded", async () => {
    await seed("a.ts", "Just one");
    const out = await run(["file", "a.ts"]);
    expect(out).not.toContain("# current");
    expect(out).toContain("Just one");
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
