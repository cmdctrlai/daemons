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
  origin?: unknown;
  promptSource?: unknown;
}

/**
 * Wrappers Claude Code writes into an entry it records as the person's own: a typed
 * slash command, `!` shell input and their output. The only text rule a human entry gets.
 */
const HUMAN_ENTRY_HARNESS_TAG = /^<(?:command-[\w-]+|local-command-[\w-]+|bash-[\w-]+)>/;

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
  '[Request interrupted by user',
  '[Image: source:',
  '[Image: original',
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
 *
 * An origin naming anything but a person ("task-notification") is the harness
 * speaking, however ordinary its prose.
 */
export function isHarnessEntry(entry: TranscriptEntryFlags): boolean {
  const origin = entry.origin as { kind?: unknown } | null | undefined;
  return (
    entry.isMeta === true ||
    entry.isSidechain === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true ||
    (origin != null && origin.kind !== 'human')
  );
}

/**
 * True when Claude Code recorded the entry as sent by a person.
 *
 * Positive evidence beats guessing from the text: a human message may start with
 * anything, including the `[Image #N]` marker Claude Code writes for a pasted image.
 * Terminal input carries `origin.kind: "human"`; a prompt sent through the SDK (the
 * CmdCtrl apps) carries `promptSource: "sdk"` and no origin, while SDK-delivered task
 * notifications name their own origin. Older versions write neither, which proves nothing.
 */
export function isHumanEntry(entry: TranscriptEntryFlags): boolean {
  const origin = entry.origin as { kind?: unknown } | null | undefined;
  if (origin != null) {
    return origin.kind === 'human';
  }
  return entry.promptSource === 'sdk';
}

/** isHumanEntry for a line too large to parse; both fields sit in the preserved tail. */
export function isHumanRawLine(line: string): boolean {
  if (/"origin"\s*:\s*\{/.test(line)) {
    return /"origin"\s*:\s*\{\s*"kind"\s*:\s*"human"/.test(line);
  }
  return /"promptSource"\s*:\s*"sdk"/.test(line);
}

/**
 * Claude Code rewrites pasted input into `<pasted_content id="...">...</pasted_content id="...">`
 * before writing the entry, so a message the user pasted arrives looking exactly like a
 * harness tag wrapper. Replacing each wrapper with the text inside it is what lets the
 * leading-`<` rule below stay as blunt as it is: by the time that rule sees the string,
 * a paste is ordinary prose again.
 *
 * A message can hold several pastes mixed with typed text, and the closing tag repeats
 * the id rather than being bare, so every wrapper is matched and unwrapped in place.
 */
export function unwrapPastedContent(content: string): string {
  return content
    .replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1')
    .trim();
}

/**
 * True for text that is machine-generated rather than typed by a human.
 *
 * A safety net for entries with no usable flag: structured data, XML-like
 * wrappers, and the known harness preambles. The `<` rule requires a
 * non-space next character so a real message such as "< 5ms is the target"
 * survives – every wrapper the harness emits is a bare tag.
 *
 * `fromHuman` (isHumanEntry) narrows this to the command wrappers Claude Code records
 * as the person's own entry; anything else a person sends may open with any character.
 */
export function isHarnessText(content: string, fromHuman = false): boolean {
  const trimmed = content.trim();

  // A paste wrapper is proof the text came from the person: the harness never wraps its
  // own tags in one. Whatever is inside -- JSON, HTML, a diff -- is theirs, so exempt it
  // before the blunt rules below, which would otherwise read the payload as harness noise.
  if (trimmed.startsWith('<pasted_content')) {
    return false;
  }
  if (fromHuman) {
    return HUMAN_ENTRY_HARNESS_TAG.test(trimmed);
  }
  if (trimmed.startsWith('<') && trimmed.length > 1 && trimmed[1] !== ' ') {
    return true;
  }
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed)) {
    return true;
  }
  return HARNESS_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Structured payloads (task-spawn notices, stringified tool results) parse whole;
// prose that merely opens with a bracket, such as "[Image #3] look at this", does not.
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
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

/** isHarnessEntry's origin rule for a line too large to parse. */
export function hasNonHumanOriginInRawLine(line: string): boolean {
  return /"origin"\s*:\s*\{\s*"kind"\s*:\s*"(?!human")/.test(line);
}
