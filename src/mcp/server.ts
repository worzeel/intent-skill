import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { annotateIntent, updateIntent, type CaptureContext } from "../capture.js";
import {
  getFileIntent,
  getIntentAtLine,
  getSessionIntent,
  searchIntent,
  type ResolvedIntent,
} from "../query.js";

/**
 * MCP server: write-side (`annotate_intent`, `update_intent`) and read-side
 * (`get_intent`, `search_intent`, `get_file_intent`, `get_session_intent`).
 * Thin wiring over the capture and query services — all logic lives there.
 */

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Shape resolved intents into a stable, snake_case JSON result for clients. */
function serialize(resolved: ResolvedIntent[]): unknown {
  return {
    intents: resolved.map((r) => ({
      intent_id: r.intent.id,
      summary: r.intent.summary,
      detail: r.intent.detail,
      task_ref: r.intent.taskRef,
      session_id: r.intent.sessionId,
      created_at: r.intent.createdAt,
      lines: r.lines.map((l) => ({
        file: l.line.filePath,
        blob_hash: l.line.blobHash,
        commit_hash: l.line.commitHash,
        status: l.status,
        line_start: l.currentLineStart,
        line_end: l.currentLineEnd,
        original_line_start: l.line.lineStart,
        original_line_end: l.line.lineEnd,
      })),
    })),
  };
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

  server.registerTool(
    "get_intent",
    {
      title: "Get intent at line",
      description:
        "All intents whose anchored code currently covers the given line in a " +
        "file. Current position is re-resolved from the git blob hash at query time.",
      inputSchema: {
        file: z.string().describe("Path relative to the repo root"),
        line: z.number().int().describe("Line number (1-based, current state)"),
      },
    },
    async (args) => {
      try {
        return ok(serialize(await getIntentAtLine(ctx, args.file, args.line)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "search_intent",
    {
      title: "Search intent",
      description:
        "Full-text search across intent summaries and details. Optionally scope " +
        "to a single file. Returns matches with current resolved file/line positions.",
      inputSchema: {
        query: z.string().describe("Free-text search query"),
        file: z.string().optional().describe("Restrict to intents touching this file"),
        limit: z.number().int().positive().optional().describe("Max results (default 20)"),
      },
    },
    async (args) => {
      try {
        const results = await searchIntent(ctx, args.query, {
          file: args.file,
          limit: args.limit,
        });
        return ok(serialize(results));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_file_intent",
    {
      title: "Get file intent",
      description:
        "All intents for an entire file, ordered by current line position — a " +
        "full provenance view before changing the file.",
      inputSchema: {
        file: z.string().describe("Path relative to the repo root"),
      },
    },
    async (args) => {
      try {
        return ok(serialize(await getFileIntent(ctx, args.file)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_session_intent",
    {
      title: "Get session intent",
      description: "All intents captured in a given Claude Code session.",
      inputSchema: {
        session_id: z.string().describe("Claude Code session id"),
      },
    },
    async (args) => {
      try {
        return ok(serialize(await getSessionIntent(ctx, args.session_id)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
