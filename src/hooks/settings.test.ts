import { describe, expect, it } from "bun:test";
import { mergeHooks, hookCommand, isIntentEntry } from "./settings.js";

const BIN = "/home/u/.claude/skills/intent/intent";
const CMD = hookCommand(BIN); // `"…/intent" hook`
const LEGACY = "node --experimental-sqlite --no-warnings /old/skills/intent/dist/hooks/cli.js";

function commandsFor(settings: { hooks: Record<string, any[]> }, event: string): string[] {
  return (settings.hooks[event] ?? []).flatMap((e) =>
    (e.hooks ?? []).map((h: { command: string }) => h.command),
  );
}

describe("hookCommand", () => {
  it("invokes the binary's own `hook` subcommand, path quoted", () => {
    expect(hookCommand("/a b/intent")).toBe('"/a b/intent" hook');
  });
});

describe("isIntentEntry", () => {
  it("matches the binary form", () => {
    expect(isIntentEntry({ hooks: [{ type: "command", command: CMD }] })).toBe(true);
  });
  it("matches legacy node/shim forms (self-heal)", () => {
    expect(isIntentEntry({ hooks: [{ type: "command", command: LEGACY }] })).toBe(true);
    expect(isIntentEntry({ hooks: [{ type: "command", command: "/x/intent-hook" }] })).toBe(true);
  });
  it("ignores foreign entries", () => {
    expect(isIntentEntry({ hooks: [{ type: "command", command: "some-other-tool" }] })).toBe(false);
    expect(isIntentEntry(null)).toBe(false);
    expect(isIntentEntry({})).toBe(false);
  });
});

describe("mergeHooks", () => {
  it("adds all three hook events pointing at the binary", () => {
    const out = mergeHooks({}, CMD);
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      expect(commandsFor(out, event)).toEqual([CMD]);
    }
  });

  it("sets the edit matcher on Pre/PostToolUse but not SessionStart", () => {
    const out = mergeHooks({}, CMD) as any;
    expect(out.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(out.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined();
  });

  it("is idempotent — re-running doesn't duplicate our entries", () => {
    const once = mergeHooks({}, CMD);
    const twice = mergeHooks(once, CMD) as any;
    expect(twice.hooks.PostToolUse).toHaveLength(1);
    expect(commandsFor(twice, "SessionStart")).toEqual([CMD]);
  });

  it("self-heals when the binary path changes", () => {
    const old = mergeHooks({}, hookCommand("/old/path/intent"));
    const updated = mergeHooks(old, CMD);
    expect(commandsFor(updated, "PreToolUse")).toEqual([CMD]);
  });

  it("self-heals a legacy node command to the binary command", () => {
    const old = mergeHooks({}, LEGACY);
    const updated = mergeHooks(old, CMD);
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      expect(commandsFor(updated, event)).toEqual([CMD]);
    }
  });

  it("preserves foreign hooks and other settings keys", () => {
    const existing = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      },
    };
    const out = mergeHooks(existing, CMD) as any;

    expect(out.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(out.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(commandsFor(out, "PostToolUse")).toEqual(["some-other-tool", CMD]);
  });

  it("does not mutate the input settings object", () => {
    const input = { hooks: { PostToolUse: [] as any[] } };
    mergeHooks(input, CMD);
    expect(input.hooks.PostToolUse).toEqual([]);
  });
});
