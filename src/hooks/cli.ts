#!/usr/bin/env node
import { runHook } from "./run.js";

/**
 * Legacy entry point for Claude Code hooks (`intent-hook`). The compiled binary
 * exposes the same thing as `intent hook`; both delegate to {@link runHook}.
 *
 * Hooks must never break the session: any failure exits 0 with no output.
 */
runHook().catch((error) => {
  // Never break the session — log to stderr and exit clean.
  console.error("intent-hook:", error instanceof Error ? error.message : error);
  process.exit(0);
});
