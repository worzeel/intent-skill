import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { annotateIntent, updateIntent, type CaptureContext } from "../capture.js";

/**
 * Write-side MCP server: exposes `annotate_intent` and `update_intent`. Thin
 * wiring over the capture service — all logic lives in src/capture.ts.
 */

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createIntentServer(ctx: CaptureContext): McpServer {
  const server = new McpServer({ name: "mcp-intent", version: "0.1.0" });

  server.registerTool(
    "annotate_intent",
    {
      title: "Annotate intent",
      description:
        "Capture why a file change was made, anchored to its git blob hash. " +
        "Call after a significant write/edit. Pass intent_id to attach a multi-file " +
        "task to an existing intent instead of creating a new one.",
      inputSchema: {
        file: z.string().describe("Path relative to the repo root"),
        line_start: z.number().int().describe("First changed line (1-based)"),
        line_end: z.number().int().describe("Last changed line (1-based)"),
        summary: z.string().describe("Short label, e.g. 'Add retry logic to API client'"),
        detail: z
          .string()
          .optional()
          .describe("Why, tradeoffs, constraints considered"),
        task_ref: z.string().optional().describe("Ticket/issue/PR ref, e.g. 'GH-142'"),
        intent_id: z
          .string()
          .optional()
          .describe("Attach to this existing intent instead of creating a new one"),
        session_id: z.string().optional().describe("Claude Code session id"),
      },
    },
    async (args) => {
      try {
        const result = await annotateIntent(ctx, {
          file: args.file,
          lineStart: args.line_start,
          lineEnd: args.line_end,
          summary: args.summary,
          detail: args.detail,
          taskRef: args.task_ref,
          intentId: args.intent_id,
          sessionId: args.session_id,
        });
        return ok({
          intent_id: result.intentId,
          intent_line_id: result.intentLineId,
          blob_hash: result.blobHash,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "update_intent",
    {
      title: "Update intent",
      description:
        "Amend the detail of an existing intent (for multi-edit tasks within a " +
        "session) rather than creating a duplicate.",
      inputSchema: {
        intent_id: z.string().describe("Intent to amend"),
        detail: z.string().describe("Detail text to add or replace"),
        append: z
          .boolean()
          .optional()
          .describe("true (default) appends to existing detail; false replaces it"),
      },
    },
    async (args) => {
      try {
        const intent = updateIntent(ctx, {
          intentId: args.intent_id,
          detail: args.detail,
          append: args.append,
        });
        return ok({ intent_id: intent.id, detail: intent.detail });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
