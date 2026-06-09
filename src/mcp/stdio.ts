#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getRepoRoot } from "../git/repo.js";
import { openIntentDbForCwd } from "../db/connection.js";
import { createIntentServer } from "./server.js";

/**
 * Stdio entry point. Run from inside a git repo; it opens (creating if needed)
 * `.git/intent.db`, brings the schema up to date, and serves the write-side
 * tools over stdio for a Claude Code MCP client.
 */
async function main(): Promise<void> {
  const cwd = process.cwd();
  const repoRoot = await getRepoRoot(cwd);
  const db = await openIntentDbForCwd(cwd);
  const sessionId = process.env.MCP_INTENT_SESSION_ID ?? null;

  const server = createIntentServer({ db, repoRoot, sessionId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // stdout is the MCP channel — diagnostics must go to stderr.
  console.error("mcp-intent failed to start:", error);
  process.exit(1);
});
