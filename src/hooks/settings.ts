/**
 * Pure helpers for merging intent's Claude Code hooks into a `settings.json`
 * object. No filesystem here — {@link mergeHooks} takes the parsed settings and
 * returns a new object, so it's trivially testable. The `intent install` command
 * owns the read/write.
 */

/** The three hook events we wire, with their tool matcher (null = all tools). */
export const EVENTS: Record<string, string | null> = {
  SessionStart: null,
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit",
};

/** The hook command: the binary itself, invoked with the `hook` subcommand. */
export function hookCommand(binPath: string): string {
  return `"${binPath}" hook`;
}

/**
 * True if a hooks entry is one we previously injected. Matches the current
 * binary form (`"…/intent" hook`) plus the legacy Node forms (`…/intent-hook`,
 * `node … hooks/cli.js`) so re-running self-heals an old install.
 */
export function isIntentEntry(entry: unknown): boolean {
  return (
    entry != null &&
    typeof entry === "object" &&
    Array.isArray((entry as { hooks?: unknown }).hooks) &&
    (entry as { hooks: unknown[] }).hooks.some(
      (h) =>
        h != null &&
        typeof (h as { command?: unknown }).command === "string" &&
        /intent-hook|hooks[\\/]+cli\.js|intent(\.exe)?"?\s+hook\b/i.test(
          (h as { command: string }).command,
        ),
    )
  );
}

type Settings = Record<string, unknown> & {
  hooks?: Record<string, unknown[]>;
};

/**
 * Return a new settings object with our 3 hooks merged in. Drops any prior
 * intent entries first (idempotent + self-heals if the binary path changed), and
 * never touches foreign hooks or other settings keys.
 */
export function mergeHooks(settings: Settings, command: string): Settings {
  const next: Settings = { ...settings };
  const hooks: Record<string, unknown[]> = { ...(next.hooks ?? {}) };

  for (const [event, matcher] of Object.entries(EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = existing.filter((entry) => !isIntentEntry(entry));
    const entry = matcher
      ? { matcher, hooks: [{ type: "command", command }] }
      : { hooks: [{ type: "command", command }] };
    hooks[event] = [...cleaned, entry];
  }

  next.hooks = hooks;
  return next;
}
