import { describe, expect, it } from "vitest";
import { mergeHooks, shimContent } from "./install.mjs";

const CMD = "/home/u/.local/bin/intent-hook";

function commandsFor(settings, event) {
  return (settings.hooks[event] ?? []).flatMap((e) =>
    (e.hooks ?? []).map((h) => h.command),
  );
}

describe("mergeHooks", () => {
  it("adds all three hook events pointing at the shim", () => {
    const out = mergeHooks({}, CMD);
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      expect(commandsFor(out, event)).toEqual([CMD]);
    }
  });

  it("sets the edit matcher on Pre/PostToolUse but not SessionStart", () => {
    const out = mergeHooks({}, CMD);
    expect(out.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(out.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined();
  });

  it("is idempotent — re-running doesn't duplicate our entries", () => {
    const once = mergeHooks({}, CMD);
    const twice = mergeHooks(once, CMD);
    expect(twice.hooks.PostToolUse).toHaveLength(1);
    expect(commandsFor(twice, "SessionStart")).toEqual([CMD]);
  });

  it("self-heals when the shim path changes", () => {
    const old = mergeHooks({}, "/old/path/intent-hook");
    const updated = mergeHooks(old, CMD);
    expect(commandsFor(updated, "PreToolUse")).toEqual([CMD]);
  });

  it("preserves foreign hooks and other settings keys", () => {
    const existing = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      },
    };
    const out = mergeHooks(existing, CMD);

    expect(out.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(out.hooks.Stop).toEqual(existing.hooks.Stop);
    // Foreign PostToolUse entry kept, ours appended.
    expect(commandsFor(out, "PostToolUse")).toEqual(["some-other-tool", CMD]);
  });

  it("does not mutate the input settings object", () => {
    const input = { hooks: { PostToolUse: [] } };
    mergeHooks(input, CMD);
    expect(input.hooks.PostToolUse).toEqual([]);
  });
});

describe("shimContent", () => {
  it("execs node with the experimental flag and quotes the target", () => {
    const shim = shimContent("/a b/dist/cli/main.js");
    expect(shim).toContain("#!/bin/sh");
    expect(shim).toContain("--experimental-sqlite --no-warnings");
    expect(shim).toContain('"/a b/dist/cli/main.js"');
    expect(shim.trimEnd().endsWith('"$@"')).toBe(true);
  });
});
