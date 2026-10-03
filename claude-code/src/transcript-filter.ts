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
 * slash command, `!` shell input and their output. The only text rule a human entry gets,
 * and only for text that is nothing but these.
 */
const HUMAN_ENTRY_HARNESS_TAG = /<((?:command|local-command|bash)-[\w-]+)>[\s\S]*?<\/\1>\s*/y;

/**
 * Prose the harness injects into the transcript as a `user` entry without the
 * user having typed it. `isMeta` covers these on any entry that carries the
 * flag; these prefixes are the fallback for entries that don't.
 *
 * Tag wrappers (<system-reminder>, <bash-notification>, <command-name>, ...)
 * are not listed: the leading-`<` rule below already catches every one of them,
 * so a list here would be dead weight that hides how load-bearing that rule is.
 */
const INTERRUPT_MARKER = '[Request interrupted by user';

const HARNESS_TEXT_PREFIXES = [
  'This session is being continued from a previous conversation',
  'This conversation is being continued from a previous session',
  'Base directory for this skill:',
  INTERRUPT_MARKER,
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

/** A user or assistant entry: what the message count counts, wherever it is reported. */
export function isMessageEntry(entry: { type?: unknown }): boolean {
  return entry.type === 'user' || entry.type === 'assistant';
}

/**
 * True for the user entry Claude Code writes when a turn is interrupted: the marker as
 * the whole message, or inside the tool result of the tool that was running.
 */
export function mentionsInterrupt(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user') return false;
  const content = (entry.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === 'string') return content.startsWith(INTERRUPT_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((block: Record<string, unknown>) =>
    (block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(INTERRUPT_MARKER)) ||
    (block.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith(INTERRUPT_MARKER)));
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

/** The `queued_command` attachment fields the sender rule reads. */
export interface QueuedCommandFlags {
  isMeta?: unknown;
  origin?: unknown;
  commandMode?: unknown;
}

/**
 * True when a `queued_command` attachment carries a message a person sent mid-turn.
 *
 * The rule is Claude Code's own: `origin` names the sender, and an attachment without
 * one is the person's when it queued a `prompt` – the SDK, and so the CmdCtrl apps,
 * write no origin. Other senders either name themselves (peer, coordinator, both
 * `isMeta`) or queue under their own commandMode (`task-notification`). The text is
 * never consulted.
 */
export function isHumanQueuedCommand(attachment: QueuedCommandFlags): boolean {
  if (attachment.isMeta === true) return false;
  const origin = attachment.origin as { kind?: unknown } | null | undefined;
  if (origin != null) return origin.kind === 'human';
  return attachment.commandMode === 'prompt';
}

/** A message a person queued mid-turn, as both read paths show it. */
export interface QueuedMessage {
  uuid: string;
  text: string;
}

/**
 * The message a `queued_command` attachment entry carries, or null for any other entry
 * or a sender that is not a person.
 *
 * A message absorbed mid-turn is written only as this attachment, at the point the
 * agent took it in; the queue entries around it never render. Its identity is
 * `source_uuid`, the id Claude Code gives the queued message, which older versions
 * omit – there the entry's own uuid stands in. The prompt is what the person typed,
 * so no text rule applies to it.
 */
export function queuedHumanMessage(entry: Record<string, unknown>): QueuedMessage | null {
  if (!isQueuedCommandEntry(entry)) return null;
  const attachment = entry.attachment as Record<string, unknown>;
  if (isHarnessEntry(entry) || !isHumanQueuedCommand(attachment)) return null;

  const prompt = attachment.prompt;
  const raw = typeof prompt === 'string'
    ? prompt
    : Array.isArray(prompt)
      ? prompt
          .filter((b: Record<string, unknown>) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: Record<string, unknown>) => b.text)
          .join('\n')
      : '';
  const uuid = queuedMessageUuid(attachment.source_uuid, entry.uuid);
  if (!raw.trim() || !uuid) return null;
  return { uuid, text: unwrapPastedContent(raw) };
}

/** True for a `queued_command` attachment entry, whoever sent it. */
function isQueuedCommandEntry(entry: Record<string, unknown>): boolean {
  const attachment = entry.attachment as { type?: unknown } | undefined;
  return entry.type === 'attachment' && attachment?.type === 'queued_command';
}

/** source_uuid when the attachment has one, else the entry's uuid. */
function queuedMessageUuid(sourceUuid: unknown, entryUuid: unknown): string | null {
  if (typeof sourceUuid === 'string' && sourceUuid) return sourceUuid;
  return typeof entryUuid === 'string' && entryUuid ? entryUuid : null;
}

const SLASH_COMMAND_TAG = /<command-(name|message|args)>([\s\S]*?)<\/command-\1>\s*/y;

/** Each tag's name and trimmed body when `content` is one or more `tag`s and nothing else. */
function tagFields(content: string, tag: RegExp): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let end = content.length - content.trimStart().length;
  let matched = false;
  tag.lastIndex = end;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(content))) {
    fields[match[1]] = (match[2] ?? '').trim();
    end = tag.lastIndex;
    matched = true;
  }
  return matched && end === content.length ? fields : null;
}

/**
 * The command line a person typed, for text that is only Claude Code's slash-command
 * wrapper (`<command-name>/pjm</command-name><command-args>bug</command-args>` → `/pjm bug`);
 * null for anything else. Typed or queued, this entry is the command's only record.
 */
export function slashCommandText(content: string): string | null {
  const fields = tagFields(content, SLASH_COMMAND_TAG);
  if (!fields?.name?.startsWith('/')) return null;
  return fields.args ? `${fields.name} ${fields.args}` : fields.name;
}

/**
 * The command line of a `system` `local_command` entry that records a slash command sent
 * through the SDK, or null for any other entry. A command the CLI runs locally and does not
 * support there (/status) is written only as this bare text plus its output, with no user
 * entry, so this entry is the command's only record. The terminal writes the wrapped form
 * here instead, and its output entries open with `<local-command-stdout>`; neither is
 * matched.
 */
export function localCommandText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'system' || entry.subtype !== 'local_command' || isHarnessEntry(entry)) return null;
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  return content.startsWith('/') ? content : null;
}

/** The trimmed text of a person's user entry; null for any other entry. */
function userEntryText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user' || isHarnessEntry(entry)) return null;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b: Record<string, unknown>) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: Record<string, unknown>) => b.text)
          .join('\n')
      : '').trim();
}

/** The command a plain-typed slash command entry opens its prompt with (`/compact`); null otherwise. */
export function typedSlashCommand(entry: Record<string, unknown>): string | null {
  const text = userEntryText(entry);
  return text?.startsWith('/') ? text : null;
}

/** The command a `<command-name>` wrapper entry records; null for any other entry. */
export function wrappedSlashCommand(entry: Record<string, unknown>): string | null {
  const text = userEntryText(entry);
  return text ? slashCommandText(text) : null;
}

/**
 * Claude Code records `/compact` typed, then again in its wrapper, under one promptId. The
 * wrapper is the repeat; a plain entry is always shown, since a person may send the same
 * "/…" text twice in one prompt.
 */
export class PromptOpenings {
  private readonly opened = new Map<string, string | null>();

  /** True when `entry` wraps the command its prompt was opened with by typing it. */
  repeats(entry: Record<string, unknown>): boolean {
    const promptId = entry.promptId;
    if (typeof promptId !== 'string' || !promptId) return false;
    if (!this.opened.has(promptId)) {
      this.opened.set(promptId, typedSlashCommand(entry));
      return false;
    }
    const command = wrappedSlashCommand(entry);
    return command !== null && command === this.opened.get(promptId);
  }
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
 * `fromHuman` (isHumanEntry) narrows this to text that is only the command wrappers Claude
 * Code records as the person's own entry; anything else a person sends may open with any
 * character, a tag name included.
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
    return tagFields(trimmed, HUMAN_ENTRY_HARNESS_TAG) !== null;
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
