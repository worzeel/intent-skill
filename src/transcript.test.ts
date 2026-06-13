import { describe, expect, it } from "vitest";
import { parseTranscript } from "./transcript.js";

/** Build one assistant transcript line with the given content blocks. */
function line(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    gitBranch: "main",
    timestamp: "2026-06-13T18:00:00.000Z",
    message: { content },
    ...extra,
  });
}

const text = (t: string) => ({ type: "text", text: t });
const edit = (file: string, oldS: string, newS: string) => ({
  type: "tool_use",
  name: "Edit",
  input: { file_path: file, old_string: oldS, new_string: newS },
});

describe("parseTranscript", () => {
  it("extracts an Edit with reasoning from text in the same message", () => {
    const raw = line([text("Add retry with backoff"), edit("/r/a.ts", "old", "new code")]);
    const [e] = parseTranscript(raw);
    expect(e.file).toBe("/r/a.ts");
    expect(e.newText).toBe("new code");
    expect(e.oldText).toBe("old");
    expect(e.reasoning).toBe("Add retry with backoff");
    expect(e.sessionId).toBe("sess-1");
    expect(e.gitBranch).toBe("main");
    expect(e.timestamp).toBe(Math.floor(Date.parse("2026-06-13T18:00:00.000Z") / 1000));
  });

  it("carries reasoning from a previous text-only line", () => {
    const raw = [
      line([text("Because the provider rate-limits bursts")]),
      line([edit("/r/a.ts", "o", "n")]),
    ].join("\n");
    const [e] = parseTranscript(raw);
    expect(e.reasoning).toBe("Because the provider rate-limits bursts");
  });

  it("handles Write as whole-file new content", () => {
    const raw = line([
      text("New module"),
      { type: "tool_use", name: "Write", input: { file_path: "/r/m.ts", content: "export const x = 1;" } },
    ]);
    const [e] = parseTranscript(raw);
    expect(e.tool).toBe("Write");
    expect(e.newText).toBe("export const x = 1;");
    expect(e.oldText).toBeNull();
  });

  it("expands MultiEdit into one edit per pair", () => {
    const raw = line([
      { type: "tool_use", name: "MultiEdit", input: { file_path: "/r/a.ts", edits: [
        { old_string: "a", new_string: "AAA" },
        { old_string: "b", new_string: "BBB" },
      ] } },
    ]);
    const edits = parseTranscript(raw);
    expect(edits.map((e) => e.newText)).toEqual(["AAA", "BBB"]);
  });

  it("skips malformed lines and non-edit tools without throwing", () => {
    const raw = [
      "{ not json",
      line([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
      line([edit("/r/a.ts", "o", "n")]),
      "",
    ].join("\n");
    const edits = parseTranscript(raw);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe("/r/a.ts");
  });
});
