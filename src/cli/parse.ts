/**
 * Tiny hand-rolled argument parser for the `intent` CLI. No dependency — the
 * command set is small. Supports:
 *   - positionals (first one is the command)
 *   - `--flag value` and `--flag=value`
 *   - bare boolean flags, declared up front (e.g. `--json`)
 *   - `--no-flag` to set a boolean false (e.g. `--no-append`)
 */

export interface ParsedArgs {
  /** First positional — the subcommand. */
  command: string | undefined;
  /** Remaining positionals, command stripped. */
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(
  argv: readonly string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);

    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    if (body.startsWith("no-")) {
      flags[body.slice(3)] = false;
      continue;
    }

    if (booleanFlags.has(body)) {
      flags[body] = true;
      continue;
    }

    // Value flag: consume the next token unless it's another flag.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    flags,
  };
}
