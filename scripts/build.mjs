#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile the `intent` CLI into a single self-contained binary via
 * `bun build --compile`. The binary embeds the Bun runtime + bun:sqlite, so it
 * needs no Node, no `--experimental-sqlite`, no PATH shims — just run it.
 *
 *   bun run scripts/build.mjs                  # current platform → bin/intent[.exe]
 *   bun run scripts/build.mjs --all            # every release target → release/
 *   bun run scripts/build.mjs --target=linux-x64
 *
 * Release asset names match the platform key (intent-<key>[.exe]) so the
 * installer / download step can pick by process.platform + process.arch.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "cli", "main.ts");

/** key → bun --target triple + executable extension. */
const TARGETS = {
  "darwin-arm64": { triple: "bun-darwin-arm64", ext: "" },
  "darwin-x64": { triple: "bun-darwin-x64", ext: "" },
  "linux-x64": { triple: "bun-linux-x64", ext: "" },
  "linux-arm64": { triple: "bun-linux-arm64", ext: "" },
  "windows-x64": { triple: "bun-windows-x64", ext: ".exe" },
};

/** Map the host (process.platform/arch) to a TARGETS key. */
function currentKey() {
  const plat = process.platform === "win32" ? "windows" : process.platform; // darwin | linux | windows
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const key = `${plat}-${arch}`;
  if (!(key in TARGETS)) {
    process.stderr.write(`build: unsupported host platform ${key}\n`);
    process.exit(1);
  }
  return key;
}

function compile(key, outfile) {
  const { triple } = TARGETS[key];
  mkdirSync(path.dirname(outfile), { recursive: true });
  process.stdout.write(`• ${key} → ${path.relative(root, outfile)}\n`);
  const res = spawnSync(
    "bun",
    ["build", entry, "--compile", `--target=${triple}`, "--minify", "--outfile", outfile],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (res.status !== 0) {
    process.stderr.write(`build: failed for ${key}\n`);
    process.exit(res.status ?? 1);
  }
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

if (all) {
  const releaseDir = path.join(root, "release");
  for (const key of Object.keys(TARGETS)) {
    compile(key, path.join(releaseDir, `intent-${key}${TARGETS[key].ext}`));
  }
  process.stdout.write(`\nBuilt ${Object.keys(TARGETS).length} targets → release/\n`);
} else {
  const key = targetArg ?? currentKey();
  if (!(key in TARGETS)) {
    process.stderr.write(`build: unknown target '${key}' (have: ${Object.keys(TARGETS).join(", ")})\n`);
    process.exit(1);
  }
  compile(key, path.join(root, "bin", `intent${TARGETS[key].ext}`));
  process.stdout.write(`\nBuilt bin/intent${TARGETS[key].ext}\n`);
}
