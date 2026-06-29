import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared compile targets + helpers for the `intent` single-file binary, used by
 * build.mjs (raw binaries) and bundle.mjs (skill folders / release archives).
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = path.join(ROOT, "src", "cli", "main.ts");

/** platform key → bun `--target` triple + executable extension. */
export const TARGETS = {
  "darwin-arm64": { triple: "bun-darwin-arm64", ext: "" },
  "darwin-x64": { triple: "bun-darwin-x64", ext: "" },
  "linux-x64": { triple: "bun-linux-x64", ext: "" },
  "linux-arm64": { triple: "bun-linux-arm64", ext: "" },
  "windows-x64": { triple: "bun-windows-x64", ext: ".exe" },
};

/** Map the host (process.platform/arch) to a TARGETS key. */
export function currentKey() {
  const plat = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const key = `${plat}-${arch}`;
  if (!(key in TARGETS)) {
    process.stderr.write(`unsupported host platform: ${key}\n`);
    process.exit(1);
  }
  return key;
}

/** Compile the CLI to `outfile` for the given target key. Exits on failure. */
export function compileBinary(key, outfile) {
  const target = TARGETS[key];
  if (!target) {
    process.stderr.write(`unknown target '${key}' (have: ${Object.keys(TARGETS).join(", ")})\n`);
    process.exit(1);
  }
  mkdirSync(path.dirname(outfile), { recursive: true });
  process.stdout.write(`• ${key} → ${path.relative(ROOT, outfile)}\n`);
  const res = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", `--target=${target.triple}`, "--minify", "--outfile", outfile],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (res.status !== 0) {
    process.stderr.write(`build failed for ${key}\n`);
    process.exit(res.status ?? 1);
  }
}
