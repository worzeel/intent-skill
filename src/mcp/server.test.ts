import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeTempRepo, type TempRepo } from "../test-helpers.js";
import { openIntentDb, type IntentDatabase } from "../db/connection.js";
import { getIntent, getIntentLines } from "../db/intents.js";
import { createIntentServer } from "./server.js";

let repo: TempRepo;
let db: IntentDatabase;
let client: Client;

beforeEach(async () => {
  repo = await makeTempRepo();
  db = openIntentDb(":memory:");

  const server = createIntentServer({ db, repoRoot: repo.root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.close();
  await repo.cleanup();
});

/** Parse the JSON payload our tools return in their single text content block. */
function payload(result: CallToolResult): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(block.text);
}

describe("write-side MCP tools", () => {
  it("advertises the write-side and read-side tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_intent",
      "get_file_intent",
      "get_intent",
      "get_session_intent",
      "search_intent",
      "update_intent",
    ]);
  });

  it("annotate_intent captures an intent end-to-end", async () => {
    await writeFile(path.join(repo.root, "api.ts"), "const a = 1;\nconst b = 2;\n");

    const result = (await client.callTool({
      name: "annotate_intent",
      arguments: {
        file: "api.ts",
        line_start: 1,
        line_end: 1,
        summary: "Add constant",
        detail: "needed for config",
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const out = payload(result);
    expect(out.intent_id).toEqual(expect.any(String));

    const intent = getIntent(db, out.intent_id as string);
    expect(intent?.summary).toBe("Add constant");
    expect(getIntentLines(db, out.intent_id as string)).toHaveLength(1);
  });

  it("update_intent amends an intent via the tool surface", async () => {
    await writeFile(path.join(repo.root, "api.ts"), "x\n");
    const created = payload(
      (await client.callTool({
        name: "annotate_intent",
        arguments: { file: "api.ts", line_start: 1, line_end: 1, summary: "x", detail: "first" },
      })) as CallToolResult,
    );

    const updated = payload(
      (await client.callTool({
        name: "update_intent",
        arguments: { intent_id: created.intent_id, detail: "second" },
      })) as CallToolResult,
    );

    expect(updated.detail).toBe("first\n\nsecond");
  });

  it("returns a tool error for an unknown intent", async () => {
    const result = (await client.callTool({
      name: "update_intent",
      arguments: { intent_id: "nope", detail: "x" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const block = result.content[0];
    expect(block && block.type === "text" && block.text).toMatch(/intent not found/);
  });

  it("get_intent and search_intent resolve through the tool surface", async () => {
    await writeFile(path.join(repo.root, "api.ts"), "a\nretry()\nb\n");
    await client.callTool({
      name: "annotate_intent",
      arguments: { file: "api.ts", line_start: 2, line_end: 2, summary: "Add retry logic" },
    });

    const atLine = payload(
      (await client.callTool({
        name: "get_intent",
        arguments: { file: "api.ts", line: 2 },
      })) as CallToolResult,
    );
    expect((atLine.intents as unknown[]).length).toBe(1);

    const search = payload(
      (await client.callTool({
        name: "search_intent",
        arguments: { query: "retry" },
      })) as CallToolResult,
    );
    const hits = search.intents as Array<{ summary: string; lines: unknown[] }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.summary).toBe("Add retry logic");
    expect(hits[0]!.lines).toHaveLength(1);
  });
});
