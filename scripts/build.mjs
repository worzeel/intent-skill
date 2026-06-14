#!/usr/bin/env bun
import path from "node:path";
import { ROOT, TARGETS, currentKey, compileBinary } from "./targets.mjs";

/**
 * Compile the `intent` CLI into a single self-contained binary via
 * `bun build --compile`. The binary embeds the Bun runtime + bun:sqlite, so it
 * needs no Node, no `--experimental-sqlite`, no PATH shims — just run it.
 *
 *   bun run scripts/build.mjs                  # current platform → bin/intent[.exe]
 *   bun run scripts/build.mjs --all            # every release target → release/
 *   bun run scripts/build.mjs --target=linux-x64
 */

const args = process.argv.slice(2);
const all = args.includes("--all");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

if (all) {
  for (const key of Object.keys(TARGETS)) {
    compileBinary(key, path.join(ROOT, "release", `intent-${key}${TARGETS[key].ext}`));
  }
  process.stdout.write(`\nBuilt ${Object.keys(TARGETS).length} targets → release/\n`);
} else {
  const key = targetArg ?? currentKey();
  compileBinary(key, path.join(ROOT, "bin", `intent${TARGETS[key].ext}`));
  process.stdout.write(`\nBuilt bin/intent${TARGETS[key].ext}\n`);
}
