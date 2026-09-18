/**
 * Shared rules for deciding which JSONL transcript entries are real conversation
 * and which are harness machinery.
 *
 * The live broadcast path (session-watcher) and the history read path
 * (message-reader) must agree: a message the user sees stream in has to still be
 * there after a refresh, and one that is filtered live must not reappear. Both
 * import from here so there is one list to change.
 */

/** The subset of transcript-entry fields these rules look at. */
export interface TranscriptEntryFlags {
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
}

/**
 * Prose the harness injects into the transcript as a `user` entry without the
 * user having typed it. `isMeta` covers these on any entry that carries the
 * flag; these prefixes are the fallback for entries that don't.
 *
 * Tag wrappers (<system-reminder>, <bash-notification>, <command-name>, ...)
 * are not listed: the leading-`<` rule below already catches every one of them,
 * so a list here would be dead weight that hides how load-bearing that rule is.
 */
const HARNESS_TEXT_PREFIXES = [
  'This session is being continued from a previous conversation',
  'This conversation is being continued from a previous session',
  'Base directory for this skill:',
];

/**
 * True for an entry the harness generated rather than the user or the agent.
 *
 * `isMeta` is the authoritative signal: Claude Code sets it on everything it
 * injects on the user's behalf – pasted-image placeholders, skill preambles,
 * continuation prompts, `/rename` notices, and messages relayed in from another
 * Claude session. Matching the flag rather than the text is what keeps a relayed
 * message ("Another Claude session sent a message: …") out of the chat, since
 * its text begins with an ordinary capital letter and defeats any prefix list.
 *
 * `isSidechain` marks subagent turns. Current Claude Code writes those to
 * separate `<session>/subagents/agent-*.jsonl` files, so they no longer appear
 * in a main transcript at all, but older transcripts inlined them and they are
 * agent-internal either way.
 */
export function isHarnessEntry(entry: TranscriptEntryFlags): boolean {
  return (
    entry.isMeta === true ||
    entry.isSidechain === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true
  );
}

/**
 * True for text that is machine-generated rather than typed by a human.
 *
 * A safety net for entries with no usable flag: structured data, XML-like
 * wrappers, and the known harness preambles. The `<` rule requires a
 * non-space next character so a real message such as "< 5ms is the target"
 * survives – every wrapper the harness emits is a bare tag.
 */
export function isHarnessText(content: string): boolean {
  const trimmed = content.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return true;
  }
  if (trimmed.startsWith('<') && trimmed.length > 1 && trimmed[1] !== ' ') {
    return true;
  }
  return HARNESS_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Field-level scan for a line too large to parse as JSON.
 *
 * message-reader truncates oversized lines (base64 images) and recovers fields
 * by regex, so the flags have to be matched the same way. `isMeta` sits after
 * the message body and `isSidechain` before it, so both halves are searched.
 */
export function hasHarnessFlagInRawLine(line: string): boolean {
  return /"(?:isMeta|isSidechain|isCompactSummary|isVisibleInTranscriptOnly)"\s*:\s*true/.test(
    line
  );
}
