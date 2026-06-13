/**
 * Claude Code session-transcript parser. Claude Code persists every session as a
 * JSONL transcript under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`,
 * one JSON object per line. Each edit a session made is recorded as a `tool_use`
 * block (Edit/Write/MultiEdit) carrying the file path and the exact new content,
 * and the assistant's reasoning text sits in the surrounding `text` blocks.
 *
 * This module mines that latent provenance into structured `TranscriptEdit`s so
 * the backfill service can re-anchor each edit to the current working tree and
 * record an intent. It is intentionally *defensive*: the transcript schema is
 * internal/undocumented and can shift between Claude Code versions, so anything
 * we don't recognise is skipped rather than fatal.
 */

/** A single file edit recovered from a transcript, with its surrounding reasoning. */
export interface TranscriptEdit {
  /** File path as recorded in the tool call (usually absolute). */
  file: string;
  /** The new content the edit introduced — what we search for in the current file. */
  newText: string;
  /** The replaced content, when the tool records it (Edit/MultiEdit). */
  oldText: string | null;
  /** Assistant reasoning text associated with the edit (the "why"). */
  reasoning: string | null;
  /** Session that made the edit — becomes the intent's session id. */
  sessionId: string | null;
  /** Git branch recorded on the line, if any. */
  gitBranch: string | null;
  /** Unix seconds from the line timestamp, or null if unparseable. */
  timestamp: number | null;
  /** Originating tool (Edit/Write/MultiEdit). */
  tool: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: { content?: ContentBlock[] | string };
}

/**
 * Parse a transcript's raw JSONL into the edits it recorded, in order. Reasoning
 * is the nearest preceding assistant text: text blocks earlier in the same
 * message take priority, falling back to the last text block seen on the wire.
 */
export function parseTranscript(raw: string): TranscriptEdit[] {
  const edits: TranscriptEdit[] = [];
  let carriedText: string | null = null; // last assistant text from a prior line

  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let line: TranscriptLine;
    try {
      line = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue; // skip malformed lines rather than aborting the whole file
    }

    const content = line.message?.content;
    if (!Array.isArray(content)) continue;

    const meta = {
      sessionId: line.sessionId ?? null,
      gitBranch: line.gitBranch ?? null,
      timestamp: toUnixSeconds(line.timestamp),
    };

    // Walk this message's blocks; text seen so far is the reasoning for any
    // subsequent edit in the same message.
    let inMessageText: string | null = null;
    let lastTextInMessage: string | null = null;

    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        inMessageText = inMessageText ? `${inMessageText}\n${block.text}` : block.text;
        lastTextInMessage = inMessageText;
        continue;
      }
      if (block?.type === "tool_use" && typeof block.name === "string" && EDIT_TOOLS.has(block.name)) {
        const reasoning = inMessageText ?? carriedText;
        for (const e of extractEdits(block, reasoning, meta)) edits.push(e);
      }
    }

    if (lastTextInMessage) carriedText = lastTextInMessage;
  }

  return edits;
}

/** Turn one edit-shaped tool_use into one or more TranscriptEdits. */
function extractEdits(
  block: ContentBlock,
  reasoning: string | null,
  meta: { sessionId: string | null; gitBranch: string | null; timestamp: number | null },
): TranscriptEdit[] {
  const input = block.input ?? {};
  const tool = block.name ?? "";
  const file = typeof input.file_path === "string" ? input.file_path : null;
  if (!file) return [];

  const base = { file, reasoning, tool, ...meta };

  // Write: the whole new file content.
  if (tool === "Write") {
    const newText = typeof input.content === "string" ? input.content : null;
    return newText ? [{ ...base, newText, oldText: null }] : [];
  }

  // MultiEdit: a list of {old_string,new_string} pairs.
  if (tool === "MultiEdit") {
    const list = Array.isArray(input.edits) ? input.edits : [];
    return list.flatMap((raw) => {
      const e = raw as Record<string, unknown>;
      const newText = typeof e.new_string === "string" ? e.new_string : null;
      if (!newText) return [];
      return [{ ...base, newText, oldText: typeof e.old_string === "string" ? e.old_string : null }];
    });
  }

  // Edit: a single old/new pair.
  const newText = typeof input.new_string === "string" ? input.new_string : null;
  if (!newText) return [];
  return [{ ...base, newText, oldText: typeof input.old_string === "string" ? input.old_string : null }];
}

/** ISO timestamp → unix seconds, or null when absent/unparseable. */
function toUnixSeconds(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
