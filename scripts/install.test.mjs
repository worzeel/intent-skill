import { describe, expect, it } from "bun:test";
import { mergeHooks, shimContent, shimCmd, shimPs1, hookCommand } from "./install.mjs";

const CMD = "/home/u/.local/bin/intent-hook";
const NODE_CMD = hookCommand("/home/u/.claude/skills/intent/dist/hooks/cli.js");

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

  it("self-heals a legacy shim command to the node-based command", () => {
    const old = mergeHooks({}, CMD); // old shim-path command
    const updated = mergeHooks(old, NODE_CMD);
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      expect(commandsFor(updated, event)).toEqual([NODE_CMD]);
    }
  });

  it("is idempotent for the node-based command", () => {
    const once = mergeHooks({}, NODE_CMD);
    const twice = mergeHooks(once, NODE_CMD);
    expect(twice.hooks.PostToolUse).toHaveLength(1);
    expect(commandsFor(twice, "PostToolUse")).toEqual([NODE_CMD]);
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

describe("shimCmd", () => {
  it("is a CRLF batch shim that forwards all args via %*", () => {
    const cmd = shimCmd("C:\\skills\\intent\\dist\\cli\\main.js");
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain('"C:\\skills\\intent\\dist\\cli\\main.js"');
    expect(cmd.trimEnd().endsWith("%*")).toBe(true);
    expect(cmd).toContain("\r\n");
  });
});

describe("shimPs1", () => {
  it("forwards args via @args and quotes the target", () => {
    const ps1 = shimPs1("C:\\skills\\intent\\dist\\cli\\main.js");
    expect(ps1).toContain("--experimental-sqlite --no-warnings");
    expect(ps1.trimEnd().endsWith("@args")).toBe(true);
  });
});

describe("hookCommand", () => {
  it("is a direct node invocation with the entry quoted", () => {
    const cmd = hookCommand("/a b/dist/hooks/cli.js");
    expect(cmd.startsWith("node --experimental-sqlite --no-warnings ")).toBe(true);
    expect(cmd).toContain('"/a b/dist/hooks/cli.js"');
    expect(cmd).not.toContain("#!/bin/sh");
  });
});
