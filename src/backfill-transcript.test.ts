import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeTempRepo, type TempRepo } from "./test-helpers.js";
import { openIntentDb, type IntentDatabase } from "./db/connection.js";
import { getIntent, getIntentLines } from "./db/intents.js";
import { getAllResolvedIntents } from "./query.js";
import type { CaptureContext } from "./capture.js";
import {
  backfillFromEdits,
  backfillFromTranscriptFile,
  resolveCandidates,
} from "./backfill-transcript.js";
import type { TranscriptEdit } from "./transcript.js";

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

function makeEdit(over: Partial<TranscriptEdit> & { newText: string; file: string }): TranscriptEdit {
  return {
    oldText: null,
    reasoning: "Why this exists",
    sessionId: "sess-1",
    gitBranch: "main",
    timestamp: 1_700_000_000,
    tool: "Edit",
    ...over,
  };
}

describe("backfillFromEdits", () => {
  it("creates an anchored intent when the new text is still in the file", async () => {
    await write("a.ts", "line one\nfunction retry() { backoff(); }\nline three\n");
    const edit = makeEdit({
      file: path.join(repo.root, "a.ts"),
      newText: "function retry() { backoff(); }",
      reasoning: "Retry with backoff to dodge 429s",
    });

    const r = await backfillFromEdits(ctx, [edit]);
    expect(r.created).toBe(1);

    const resolved = await getAllResolvedIntents(ctx);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].intent.summary).toBe("Retry with backoff to dodge 429s");
    expect(resolved[0].intent.sessionId).toBe("sess-1");
    expect(resolved[0].intent.detail).toContain("backfilled from session");
    // Located on line 2 of the current file.
    const lines = getIntentLines(db, resolved[0].intent.id);
    expect(lines[0].lineStart).toBe(2);
    expect(lines[0].lineEnd).toBe(2);
    // Original timestamp preserved, not "now".
    expect(getIntent(db, resolved[0].intent.id)?.createdAt).toBe(1_700_000_000);
  });

  it("skips edits whose new text no longer matches the file", async () => {
    await write("a.ts", "totally different content now\n");
    const r = await backfillFromEdits(ctx, [
      makeEdit({ file: path.join(repo.root, "a.ts"), newText: "the old replaced code block" }),
    ]);
    expect(r.created).toBe(0);
    expect(r.skippedNoMatch).toBe(1);
  });

  it("skips trivially short new text (too risky to anchor)", async () => {
    await write("a.ts", "x = 1\n");
    const r = await backfillFromEdits(ctx, [
      makeEdit({ file: path.join(repo.root, "a.ts"), newText: "x = 1" }),
    ]);
    expect(r.created).toBe(0);
    expect(r.skippedTrivial).toBe(1);
  });

  it("skips edits to files outside the repo", async () => {
    const r = await backfillFromEdits(ctx, [
      makeEdit({ file: "/etc/somewhere/else.ts", newText: "some long enough content here" }),
    ]);
    expect(r.created).toBe(0);
    expect(r.skippedOutsideRepo).toBe(1);
  });

  it("is idempotent — a second run only finds duplicates", async () => {
    await write("a.ts", "function retry() { backoff(); }\n");
    const edit = makeEdit({
      file: path.join(repo.root, "a.ts"),
      newText: "function retry() { backoff(); }",
    });

    expect((await backfillFromEdits(ctx, [edit])).created).toBe(1);
    const second = await backfillFromEdits(ctx, [edit]);
    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(1);
    expect((await getAllResolvedIntents(ctx)).length).toBe(1);
  });
});

describe("resolveCandidates (dry-run / LLM hand-off)", () => {
  it("returns matched candidates with resolved line ranges and writes nothing", async () => {
    await write("a.ts", "head\nfunction retry() { backoff(); }\ntail\n");
    const edit = makeEdit({
      file: path.join(repo.root, "a.ts"),
      newText: "function retry() { backoff(); }",
      reasoning: "Retry with backoff",
    });

    const { candidates, result } = await resolveCandidates(ctx, [edit]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      file: "a.ts",
      lineStart: 2,
      lineEnd: 2,
      sessionId: "sess-1",
      createdAt: 1_700_000_000,
      reasoning: "Retry with backoff",
    });
    expect(candidates[0].snippet).toContain("function retry()");
    // result.created stays 0 — nothing persisted.
    expect(result.created).toBe(0);
    expect((await getAllResolvedIntents(ctx)).length).toBe(0);
  });

  it("drops candidates already recorded for that session+file+range", async () => {
    await write("a.ts", "function retry() { backoff(); }\n");
    const edit = makeEdit({
      file: path.join(repo.root, "a.ts"),
      newText: "function retry() { backoff(); }",
    });
    await backfillFromEdits(ctx, [edit]); // record it

    const { candidates, result } = await resolveCandidates(ctx, [edit]);
    expect(candidates).toHaveLength(0);
    expect(result.duplicates).toBe(1);
  });
});

describe("backfillFromTranscriptFile", () => {
  it("reads a .jsonl transcript and backfills matching edits", async () => {
    await write("a.ts", "const answer = 42; // the meaning\n");
    const transcript = path.join(repo.root, "session.jsonl");
    await writeFile(
      transcript,
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-xyz",
        timestamp: "2026-06-13T18:00:00.000Z",
        message: {
          content: [
            { type: "text", text: "Hard-code the meaning of life" },
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: path.join(repo.root, "a.ts"),
                old_string: "const answer = 0;",
                new_string: "const answer = 42; // the meaning",
              },
            },
          ],
        },
      }) + "\n",
    );

    const r = await backfillFromTranscriptFile(ctx, transcript);
    expect(r.created).toBe(1);
    const resolved = await getAllResolvedIntents(ctx);
    expect(resolved[0].intent.summary).toBe("Hard-code the meaning of life");
    expect(resolved[0].intent.sessionId).toBe("sess-xyz");
  });
});
