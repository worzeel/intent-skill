import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse.js";

const BOOL = new Set(["json", "help"]);

describe("parseArgs", () => {
  it("pulls the command off the front and keeps the rest as positionals", () => {
    const p = parseArgs(["search", "retry", "logic"], BOOL);
    expect(p.command).toBe("search");
    expect(p.positionals).toEqual(["retry", "logic"]);
  });

  it("treats declared boolean flags as bare", () => {
    const p = parseArgs(["file", "src/a.ts", "--json"], BOOL);
    expect(p.command).toBe("file");
    expect(p.positionals).toEqual(["src/a.ts"]);
    expect(p.flags.json).toBe(true);
  });

  it("consumes the next token for value flags", () => {
    const p = parseArgs(["search", "x", "--file", "src/a.ts", "--limit", "5"], BOOL);
    expect(p.flags.file).toBe("src/a.ts");
    expect(p.flags.limit).toBe("5");
  });

  it("supports --flag=value", () => {
    const p = parseArgs(["search", "x", "--limit=5"], BOOL);
    expect(p.flags.limit).toBe("5");
  });

  it("maps --no-flag to false", () => {
    const p = parseArgs(["update", "--no-append"], BOOL);
    expect(p.flags.append).toBe(false);
  });

  it("a value flag with no following value is boolean true", () => {
    const p = parseArgs(["search", "x", "--file"], BOOL);
    expect(p.flags.file).toBe(true);
  });

  it("returns an undefined command for empty argv", () => {
    const p = parseArgs([], BOOL);
    expect(p.command).toBeUndefined();
    expect(p.positionals).toEqual([]);
  });
});
