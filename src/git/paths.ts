import path from "node:path";
import { realpathSync } from "node:fs";

/**
 * Path canonicalisation for intent's storage key. Every `file_path` is stored
 * and queried as a **repo-relative POSIX path** (forward slashes), so a lookup
 * matches regardless of the OS separator or which subdir the CLI ran from.
 * Windows `path.relative` yields backslashes — without this, a path captured on
 * Windows could only be queried by retyping those exact backslashes.
 */

/** Resolve symlinks if the path exists; otherwise return it unchanged. */
export function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Canonical repo-relative key for a file path: forward-slash separators,
 * relative to `repoRoot`. Relative inputs resolve against `base` — the CLI
 * passes the user's cwd so a path works from any subdir; writers pass the repo
 * root since their paths are already repo-relative. When the path resolves
 * outside the repo it falls back to separator-normalising the raw input, so an
 * out-of-repo path simply won't match rather than throwing.
 */
export function toRepoRelative(
  repoRoot: string,
  input: string,
  base: string = repoRoot,
): string {
  if (input.length === 0) return input;

  // Try lexically first — when root, base and input share a form this is exact
  // and doesn't depend on the file existing on disk.
  let rel = path.relative(repoRoot, path.resolve(base, input));

  // A leading ".." can be a symlink artifact (macOS /var -> /private/var) rather
  // than a genuine escape. Retry with both ends symlink-resolved before trusting
  // it. realpathSync only resolves paths that exist, so this stays best-effort.
  if (rel.startsWith("..")) {
    const abs = path.isAbsolute(input) ? canonical(input) : path.resolve(canonical(base), input);
    rel = path.relative(canonical(repoRoot), abs);
  }

  const key = rel.length === 0 || rel.startsWith("..") ? input : rel;
  return key.split(/[\\/]+/).join("/");
}

/** Trailing file name of a repo-relative POSIX key. */
export function basename(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}
