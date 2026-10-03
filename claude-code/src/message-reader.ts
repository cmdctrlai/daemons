/**
 * JSONL message reader with pagination support
 * Reads messages from Claude Code session files
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageEntry } from '@cmdctrl/daemon-sdk';
import {
  TranscriptEntryFlags,
  isHarnessEntry,
  isHarnessText,
  isHumanEntry,
  slashCommandText,
  typedSlashCommand,
  wrappedSlashCommand,
  queuedHumanMessage,
  unwrapPastedContent,
  localCommandText,
} from './transcript-filter';
import { formatToolUse } from './tool-format';

/** One tappable choice the agent offered. */
export interface MessageQuestionOption {
  label: string;
  description?: string;
}

/**
 * An AskUserQuestion the agent asked, carried alongside the message text so
 * clients can render the choices instead of a bare tool chip.
 */
export interface MessageQuestion {
  question: string;
  header?: string;
  multi_select?: boolean;
  options: MessageQuestionOption[];
}

/** A message plus the structured extras we lift out of the transcript. */
export type ReadMessageEntry = MessageEntry & {
  question?: MessageQuestion;
  /**
   * Also declared on the SDK's MessageEntry. Repeated here so the daemon builds
   * against the published SDK ahead of the release that carries the field.
   */
  verbose?: string[];
};

// Size of chunks to read when scanning for messages
const CHUNK_SIZE = 64 * 1024; // 64KB

const NEWLINE_BYTE = 0x0a;
// How far back an uncursored first page will scan. Transcripts with embedded
// images run to hundreds of MB, and every session open takes this path, so the
// ceiling keeps it cheap; stopping short only leaves has_more true, which is honest.
const MAX_TAIL_SCAN_LINES = 100_000;
const MAX_TAIL_SCAN_BYTES = 32 * 1024 * 1024;
// A cursor page is a deliberate "load older" and may sit deep in the file, so it
// gets a larger budget than a session open. The scan still stops well short of
// the handler's timeout rather than blocking the event loop on a whole file.
const MAX_CURSOR_SCAN_BYTES = 256 * 1024 * 1024;
// The tail message's turn is replayed as verbose lines, so a client arriving
// after the work sees what produced the answer. A typical turn formats to a few
// hundred bytes, and a verbose pane only ever shows its tail, so the newest
// lines are kept and anything beyond them dropped.
const MAX_VERBOSE_LINES = 50;
const MAX_VERBOSE_LINE_CHARS = 200;
interface JournalEntry extends TranscriptEntryFlags {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * The CLI's two ways of reporting answers back to the agent. Which one it uses
 * turns on whether every answer was an exact option label, so both have to be
 * recognised or free text goes unrecorded.
 */
const ANSWER_PREFIXES = [
  'Your questions have been answered:',
  'The user answered:',
];

/**
 * The chosen labels from an AskUserQuestion tool result, or '' for any other
 * result.
 *
 * A tapped answer is consumed by the tool call, so the only record of it is
 * the result the tool writes back. Reading the labels out gives the answer a
 * message of its own; without one the agent's question stays the newest entry
 * and a reload offers the same options again.
 */
function askUserAnswers(content: unknown): string {
  if (typeof content !== 'string') return '';
  const trimmed = content.trimStart();
  if (!ANSWER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return '';

  // The labels are interpolated raw, so an answer may contain quotes of its
  // own. A pair ends only where the next one starts or the sentence does.
  const answers = [...trimmed.matchAll(/"="([\s\S]*?)"(?=,\s*"|\.|$)/g)];
  return answers.map((m) => m[1]).join(', ');
}

/**
 * Extract readable text from message content (handles string or array of content blocks)
 */
function extractReadableText(content: unknown): string {
  // Simple string
  if (typeof content === 'string') {
    return content.trim();
  }

  // Array of content blocks (Claude format)
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block && typeof block === 'object') {
        // Text block: { type: 'text', text: '...' }
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
        // An answered question is the one tool result worth showing: it is the
        // user's own words, and nothing else carries them.
        else if (block.type === 'tool_result') {
          const answers = askUserAnswers(block.content);
          if (answers) textParts.push(answers);
        }
        // Skip tool_use, image blocks etc.
        // Tool calls are shown as verbose output during execution, not as permanent messages
      }
    }
    return textParts.join(' ').trim();
  }

  // Object with text property
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text: unknown }).text;
    if (typeof text === 'string') {
      return text.trim();
    }
  }

  return '';
}

/**
 * Detect agent no-op responses that Claude emits when it has nothing to say.
 * These are boilerplate completions, not meaningful content for the user.
 *
 * The Claude Code CLI internally maintains a set of these strings (leaked as
 * variable WB6 in the source). We match all known variants here.
 */
const NO_OP_RESPONSES = new Set([
  'No response requested.',
  'No response needed.',
  'No response.',
  'No response received',
  'No response from model',
]);

function isNoOpAgentMessage(content: string): boolean {
  const trimmed = content.trim();
  return NO_OP_RESPONSES.has(trimmed);
}

/**
 * Find the JSONL file for a given session ID
 */
export function findSessionFile(sessionId: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  const fileName = `${sessionId}.jsonl`;
  const entries = fs.readdirSync(claudeDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const filePath = path.join(claudeDir, entry.name, fileName);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Pull the first question out of an AskUserQuestion tool input.
 *
 * The tool takes an array, but only the first question is ever surfaced – the
 * agent blocks on it, so a second one could not be answered independently.
 */
function parseAskUserQuestion(input: unknown): MessageQuestion | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }
  const first = questions[0] as Record<string, unknown>;
  const text = typeof first?.question === 'string' ? first.question.trim() : '';
  if (!text) {
    return null;
  }
  const options: MessageQuestionOption[] = [];
  if (Array.isArray(first.options)) {
    for (const option of first.options as Record<string, unknown>[]) {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      if (!label) {
        continue;
      }
      const description =
        typeof option?.description === 'string' ? option.description.trim() : '';
      options.push(description ? { label, description } : { label });
    }
  }
  if (options.length === 0) {
    return null;
  }
  return {
    question: text,
    ...(typeof first.header === 'string' && first.header.trim()
      ? { header: first.header.trim() }
      : {}),
    ...(first.multiSelect === true ? { multi_select: true } : {}),
    options,
  };
}

/**
 * Parse a JSONL line into a MessageEntry if it's a displayable message.
 *
 * `queue-operation` entries never render. A queued message the agent absorbed mid-turn
 * shows from its `queued_command` attachment, one delivered as its own turn from its
 * `user` entry, and a slash command the CLI ran locally from its `local_command` entry;
 * what is left is drafts pulled back to the editor and the harness.
 */
function parseLineToMessage(line: string, index: number): ReadMessageEntry | null {
  try {
    const entry: JournalEntry = JSON.parse(line);

    // Harness-generated entries are never conversation, whatever their type.
    if (isHarnessEntry(entry)) {
      return null;
    }

    if (entry.type === 'attachment') {
      const queued = queuedHumanMessage(entry as unknown as Record<string, unknown>);
      return queued && {
        uuid: queued.uuid,
        role: 'USER',
        content: queued.text,
        timestamp: entry.timestamp || '',
      };
    }

    if (entry.type === 'system') {
      const command = localCommandText(entry as unknown as Record<string, unknown>);
      return command ? {
        uuid: entry.uuid || `generated-${index}`,
        role: 'USER',
        content: command,
        timestamp: entry.timestamp || '',
      } : null;
    }

    // Only process user and assistant messages
    if (entry.type !== 'user' && entry.type !== 'assistant') {
      return null;
    }

    // Check for ExitPlanMode tool_use — plan content is in input.plan, not in text blocks
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as Record<string, unknown>[]) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
          const input = block.input as Record<string, unknown> | undefined;
          const planContent = (input?.plan as string) || '';
          if (planContent) {
            return {
              uuid: entry.uuid || `generated-${index}`,
              role: 'AGENT',
              content: planContent,
              timestamp: entry.timestamp || '',
            };
          }
        }
      }
    }

    // AskUserQuestion carries the question and its choices in input.questions,
    // not in text blocks. Surface them so clients can render tappable options.
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as Record<string, unknown>[]) {
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          const question = parseAskUserQuestion(block.input);
          if (question) {
            return {
              uuid: entry.uuid || `generated-${index}`,
              role: 'AGENT',
              content: question.question,
              timestamp: entry.timestamp || '',
              question,
            };
          }
        }
      }
    }

    // Extract content
    let text = entry.message?.content
      ? extractReadableText(entry.message.content)
      : '';

    // Skip entries with no displayable text
    if (!text) {
      return null;
    }

    // Determine role
    let role: 'USER' | 'AGENT' | 'SYSTEM' = entry.type === 'user' ? 'USER' : 'AGENT';

    if (role === 'USER') {
      const command = slashCommandText(text);
      if (command) {
        text = command;
      } else if (isHarnessText(text, isHumanEntry(entry))) {
        return null;
      } else {
        text = unwrapPastedContent(text);
      }
    }

    // Filter agent no-op responses ("No response requested." etc.)
    if (role === 'AGENT' && isNoOpAgentMessage(text)) {
      return null;
    }

    return {
      uuid: entry.uuid || `generated-${index}`,
      role,
      content: text,
      timestamp: entry.timestamp || '',
    };
  } catch {
    return null;
  }
}

/**
 * The formatted tool calls in one raw JSONL line, oldest call first.
 *
 * Empty for anything that is not an assistant entry running tools, or a line that
 * does not parse.
 */
function toolUseLines(rawLine: string): string[] {
  let entry: JournalEntry;
  try {
    entry = JSON.parse(rawLine);
  } catch {
    return [];
  }

  if (!entry || entry.type !== 'assistant' || isHarnessEntry(entry)) return [];
  if (!Array.isArray(entry.message?.content)) return [];

  const lines: string[] = [];
  for (const block of entry.message.content as Record<string, unknown>[]) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
    lines.push(clip(formatToolUse(block.name, block.input as Record<string, unknown> | undefined)));
  }
  return lines;
}

/** Cut an over-long line to the display cap without splitting a surrogate pair. */
function clip(text: string): string {
  if (text.length <= MAX_VERBOSE_LINE_CHARS) return text;
  const lastCode = text.charCodeAt(MAX_VERBOSE_LINE_CHARS - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? MAX_VERBOSE_LINE_CHARS - 1 : MAX_VERBOSE_LINE_CHARS;
  return text.slice(0, end) + '…';
}

/**
 * The tool activity behind the newest message.
 *
 * Tool calls are dropped from every message, which is right for a transcript –
 * they are shown as verbose output while the turn runs, not kept as chat. But a
 * client re-entering the session afterwards then sees a final answer with no
 * sign of the work that produced it. Backward reading meets the newest message
 * first and its turn immediately after, so the lines are gathered there and
 * nowhere else; history stays exactly as slim as it was.
 *
 * The turn ends where the person last spoke. An agent that narrates as it works
 * writes several messages inside one turn, and cutting at the previous message
 * would hand back the last of them – one chip for an hour of work.
 */
class TailVerbose {
  private done = false;
  private newestFirst: string[] = [];

  /** Every scanned line, before it is known to be a message. An entry that
   *  carries both text and a tool call is a message and part of the turn. */
  consider(rawLine: string): void {
    if (this.done) return;

    const lines = toolUseLines(rawLine);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (this.newestFirst.length >= MAX_VERBOSE_LINES) {
        this.done = true;
        return;
      }
      this.newestFirst.push(lines[i]);
    }
  }

  /** Every message the scan keeps, newest first. */
  sawMessage(role: ReadMessageEntry['role']): void {
    if (role === 'USER') this.done = true;
  }

  /**
   * Hang the turn's lines, oldest first, on the message they produced.
   *
   * Only an agent's answer gets them. A user message is last when they replied
   * mid-turn, and tool chips under their own bubble would credit them with work
   * they did not do.
   */
  attachTo(messages: ReadMessageEntry[]): void {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'AGENT' || this.newestFirst.length === 0) return;
    last.verbose = this.newestFirst.slice().reverse();
  }
}

/** A JSONL line and the byte offset it starts at. The offset is the stable
 *  identity for entries whose JSON carries no uuid, so the same entry keeps the
 *  same generated id on every page that reaches it. */
interface ScannedLine {
  text: string;
  offset: number;
}

/**
 * Streams a JSONL file backwards, newest line first, holding one line at a time.
 *
 * Every read path goes through this one scanner, so a given entry yields the
 * same line and the same generated id whichever page reaches it. The scan stops
 * at a byte budget rather than always running to the start of the file;
 * `reachedStart` is how a caller tells "this is the beginning of the
 * conversation" apart from "my scan ran out", which a line count cannot express.
 */
class BackwardScanner {
  private readonly fd: number;
  private readonly fileSize: number;
  private position: number;
  // The line being assembled, newest bytes first. Held whole however long, so history
  // classifies every entry on the same text the live path parses.
  private pendingParts: Buffer[] = [];
  private flushedFirstLine = false;

  constructor(filePath: string, private readonly byteBudget: number) {
    this.fd = fs.openSync(filePath, 'r');
    this.fileSize = fs.fstatSync(this.fd).size;
    this.position = this.fileSize;
  }

  /** True once the scan has consumed and emitted the first line of the file. */
  get reachedStart(): boolean {
    return this.position === 0 && this.flushedFirstLine;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  /** The next lines, newest first. An empty array means the scan is over. */
  next(): ScannedLine[] {
    const out: ScannedLine[] = [];

    while (out.length === 0) {
      if (this.position === 0) {
        if (this.flushedFirstLine) break;
        this.flushedFirstLine = true;
        const first = this.finishLine(0);
        if (first) out.push(first);
        break;
      }
      if (this.fileSize - this.position >= this.byteBudget) break;

      const chunkSize = Math.min(CHUNK_SIZE, this.position);
      this.position -= chunkSize;
      const chunk = Buffer.alloc(chunkSize);
      fs.readSync(this.fd, chunk, 0, chunkSize, this.position);

      // Walk the chunk's newlines from the end. The bytes after the last one
      // complete the line whose remainder we already hold; the bytes before the
      // first one open a line that continues into the chunk we have not read yet.
      let end = chunkSize;
      while (end > 0) {
        const newline = chunk.lastIndexOf(NEWLINE_BYTE, end - 1);
        if (newline < 0) break;
        this.prepend(chunk.subarray(newline + 1, end));
        const line = this.finishLine(this.position + newline + 1);
        if (line) out.push(line);
        end = newline;
      }
      if (end > 0) this.prepend(chunk.subarray(0, end));
    }

    return out;
  }

  /** Attach bytes that sit in front of the line being assembled. */
  private prepend(part: Buffer): void {
    if (part.length > 0) this.pendingParts.push(part);
  }

  /** Close off the assembled line, which starts at `offset`. */
  private finishLine(offset: number): ScannedLine | null {
    if (this.pendingParts.length === 0) return null;
    const text = Buffer.concat(this.pendingParts.reverse()).toString('utf-8').trim();
    this.pendingParts = [];
    return text ? { text, offset } : null;
  }
}

const SOURCE_UUID_KEY = Buffer.from('"source_uuid":"');
const PROMPT_ID_KEY = Buffer.from('"promptId":"');
const SOURCE_INDEX_CHUNK = 1024 * 1024;
const SOURCE_INDEX_FILES = 32;
// Blocks hashed across what was indexed, first and last included, to tell an append
// from a rewrite. Hashing it all would cost a full re-read per check (157ms on a 416MB
// transcript, against 33µs for the samples), the same as re-indexing.
const SOURCE_INDEX_SAMPLES = 16;
const SOURCE_INDEX_SAMPLE_BYTES = 4096;

interface SourceIndex {
  ino: number;
  size: number;
  mtimeMs: number;
  resumeAt: number;
  lineStart: number;
  samples: string;
  firstSource: Map<string, number>;
  firstPrompt: Map<string, number>;
}

// Most recently used last.
const sourceIndexes = new Map<string, SourceIndex>();

/** How many transcripts hold a source_uuid index; bounded by SOURCE_INDEX_FILES. */
export function sourceIndexedFiles(): number {
  return sourceIndexes.size;
}

function readAt(fd: number, start: number, end: number): Buffer {
  const bytes = Buffer.alloc(Math.max(0, end - start));
  const n = bytes.length > 0 ? fs.readSync(fd, bytes, 0, bytes.length, start) : 0;
  return bytes.subarray(0, n);
}

function sampleDigest(fd: number, end: number): string {
  const hash = crypto.createHash('sha1');
  const span = Math.min(SOURCE_INDEX_SAMPLE_BYTES, end);
  for (let i = 0; i < SOURCE_INDEX_SAMPLES; i++) {
    const at = Math.floor(((end - span) * i) / (SOURCE_INDEX_SAMPLES - 1));
    hash.update(readAt(fd, at, at + span));
  }
  return hash.digest('hex');
}

/**
 * False when the file was replaced, shrank, was written without growing, or changed in a
 * sampled block. The samples cover an indexed prefix up to 64KB whole; past that, an
 * in-place edit between samples followed by an append goes unseen.
 */
function indexStillHolds(fd: number, stat: fs.Stats, index: SourceIndex): boolean {
  return (
    index.ino === stat.ino &&
    index.resumeAt <= stat.size &&
    !(stat.size === index.size && stat.mtimeMs !== index.mtimeMs) &&
    sampleDigest(fd, index.resumeAt) === index.samples
  );
}

/**
 * The offset of the line holding each source_uuid's first copy, and each promptId's. The index
 * is kept per file and extended over whatever was appended since; a rewritten file is indexed
 * afresh.
 */
function firstOffsets(filePath: string): SourceIndex {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    let index = sourceIndexes.get(filePath);
    sourceIndexes.delete(filePath);
    if (!index || !indexStillHolds(fd, stat, index)) {
      index = { ino: stat.ino, size: 0, mtimeMs: 0, resumeAt: 0, lineStart: 0, samples: '', firstSource: new Map(), firstPrompt: new Map() };
    }
    sourceIndexes.set(filePath, index);
    if (sourceIndexes.size > SOURCE_INDEX_FILES) sourceIndexes.delete(sourceIndexes.keys().next().value as string);

    // Reads overlap by a key and an id, so a copy split between two reads is still found.
    const overlap = SOURCE_UUID_KEY.length + 64;
    const keys: Array<[Buffer, Map<string, number>]> = [[SOURCE_UUID_KEY, index.firstSource], [PROMPT_ID_KEY, index.firstPrompt]];
    const chunk = Buffer.alloc(Math.min(SOURCE_INDEX_CHUNK, Math.max(0, size - index.resumeAt)));
    while (chunk.length > 0) {
      const start = index.resumeAt;
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - start), start);
      if (n <= 0) break;
      const buf = chunk.subarray(0, n);
      for (const [key, first] of keys) {
        for (let i = buf.indexOf(key); i >= 0; i = buf.indexOf(key, i + 1)) {
          const idStart = i + key.length;
          const idEnd = buf.indexOf(0x22, idStart);
          if (idEnd < 0) break;
          const id = buf.toString('utf-8', idStart, idEnd);
          const newline = buf.lastIndexOf(NEWLINE_BYTE, i);
          if (!first.has(id)) first.set(id, newline >= 0 ? start + newline + 1 : index.lineStart);
        }
      }
      const end = start + n;
      const next = end >= size ? Math.max(start, end - overlap) : end - overlap;
      if (next > start) {
        const newline = buf.lastIndexOf(NEWLINE_BYTE, next - start - 1);
        if (newline >= 0) index.lineStart = start + newline + 1;
      }
      index.resumeAt = next;
      if (end >= size) break;
    }
    index.size = size;
    index.mtimeMs = stat.mtimeMs;
    index.samples = sampleDigest(fd, index.resumeAt);
    return index;
  } finally {
    fs.closeSync(fd);
  }
}

const QUEUED_COMMAND_HEAD = /^\{[^{]*"attachment"\s*:\s*\{\s*"type"\s*:\s*"queued_command"/;

/** The whole line starting at `offset`. */
function lineAt(filePath: string, offset: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const parts: Buffer[] = [];
    for (let at = offset; ; at += CHUNK_SIZE) {
      const chunk = readAt(fd, at, at + CHUNK_SIZE);
      const newline = chunk.indexOf(NEWLINE_BYTE);
      parts.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline >= 0 || chunk.length < CHUNK_SIZE) break;
    }
    return Buffer.concat(parts).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/** True for a slash command wrapper repeating the command its prompt was opened with by typing it. */
function repeatsPromptCommand(filePath: string, line: ScannedLine): boolean {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line.text);
  } catch {
    return false;
  }
  const command = wrappedSlashCommand(entry);
  if (command === null || typeof entry.promptId !== 'string') return false;
  const first = firstOffsets(filePath).firstPrompt.get(entry.promptId);
  if (first === undefined || first >= line.offset) return false;
  try {
    return typedSlashCommand(JSON.parse(lineAt(filePath, first))) === command;
  } catch {
    return false;
  }
}

/**
 * The message a scanned line shows, or null for a repeat: Claude Code shows a queued message
 * once per source_uuid, the first copy written, and a slash command once per prompt.
 */
function shownMessage(filePath: string, line: ScannedLine, message: ReadMessageEntry | null): ReadMessageEntry | null {
  if (!message) return null;
  if (QUEUED_COMMAND_HEAD.test(line.text)) {
    const source = line.text.match(/"source_uuid"\s*:\s*"([^"]+)"/)?.[1];
    if (source !== message.uuid) return message;
    const first = firstOffsets(filePath).firstSource.get(source);
    return first !== undefined && first < line.offset ? null : message;
  }
  const maybeCommand = message.role === 'USER' && message.content.startsWith('/');
  return maybeCommand && repeatsPromptCommand(filePath, line) ? null : message;
}

/**
 * Fill in missing timestamps from neighboring messages.
 * An entry written without one takes the next message's timestamp, or the
 * previous message's if there is no next.
 */
function interpolateTimestamps(messages: ReadMessageEntry[]): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].timestamp) continue;

    // Try next message first
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].timestamp) {
        messages[i].timestamp = messages[j].timestamp;
        break;
      }
    }
    if (messages[i].timestamp) continue;

    // Fall back to previous message
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].timestamp) {
        messages[i].timestamp = messages[j].timestamp;
        break;
      }
    }
  }
}

/** Shape every read path returns. */
function page(
  messages: ReadMessageEntry[],
  hasMore: boolean
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  return {
    messages,
    hasMore,
    oldestUuid: messages.length > 0 ? messages[0].uuid : undefined,
    newestUuid: messages.length > 0 ? messages[messages.length - 1].uuid : undefined,
  };
}

/**
 * Read messages from a session JSONL file
 *
 * @param sessionId - The session ID to read
 * @param limit - Maximum number of messages to return
 * @param beforeUuid - Optional UUID cursor - returns messages before this one (for loading older)
 * @param afterUuid - Optional UUID cursor - returns messages after this one (for loading newer)
 * @returns Messages array, has_more flag, oldest/newest UUIDs
 */
export function readMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const filePath = findSessionFile(sessionId);

  if (!filePath) {
    return { messages: [], hasMore: false };
  }

  return readMessagesFromFile(filePath, limit, beforeUuid, afterUuid);
}

/**
 * Read and paginate messages from a JSONL file path.
 *
 * Split out from readMessages (which resolves the session ID to a path) so the
 * cursor/pagination logic can be unit-tested against fixture files.
 */
export function readMessagesFromFile(
  filePath: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  if (afterUuid) return readAfterCursor(filePath, limit, afterUuid);
  if (beforeUuid) return readBeforeCursor(filePath, limit, beforeUuid);
  return readLatest(filePath, limit);
}

/**
 * The newest `limit` messages.
 *
 * Only a fraction of JSONL entries are displayable messages, and that fraction
 * swings from a few percent in a tool-heavy session to most of the file. So the
 * scan runs until it has more messages than the page needs or the file runs out,
 * rather than betting the page on a fixed-size window - counting inside a window
 * reports "no older messages" on any transcript sparser than the guess.
 */
function readLatest(
  filePath: string,
  limit: number
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const scanner = new BackwardScanner(filePath, MAX_TAIL_SCAN_BYTES);
  try {
    const newestFirst: ReadMessageEntry[] = [];
    const tailVerbose = new TailVerbose();
    let lineCount = 0;

    while (lineCount < MAX_TAIL_SCAN_LINES) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        lineCount++;
        const message = shownMessage(filePath, line, parseLineToMessage(line.text, line.offset));
        tailVerbose.consider(line.text);
        if (!message) continue;
        newestFirst.push(message);
        tailVerbose.sawMessage(message.role);
      }

      if (newestFirst.length > limit) break;
    }

    const messages = newestFirst.slice().reverse();
    interpolateTimestamps(messages);
    const pageMessages = messages.slice(-limit);
    tailVerbose.attachTo(pageMessages);
    // Older messages exist if the scan found more than fit on this page, or if
    // it gave up before reaching the start of the file.
    return page(pageMessages, messages.length > limit || !scanner.reachedStart);
  } finally {
    scanner.close();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this raw line carry the cursor? Filtered and unrenderable entries never
 * become messages, but a client can still be holding one as its oldest or
 * newest uuid. Matching the raw line keeps such a cursor resolvable, instead of
 * reading as a conversation with nothing before it.
 */
function cursorMatcher(
  cursorUuid: string
): (line: ScannedLine, message: ReadMessageEntry | null) => boolean {
  // A `queue-<timestamp>` id names the enqueue entry written at that time.
  const enqueuedAt = /^queue-(.+)$/.exec(cursorUuid)?.[1];
  if (enqueuedAt) {
    const enqueue = new RegExp(
      `^\\{\\s*"type"\\s*:\\s*"queue-operation"\\s*,\\s*"operation"\\s*:\\s*"enqueue"\\s*,\\s*"timestamp"\\s*:\\s*"${escapeRegExp(enqueuedAt)}"`
    );
    return (line) => enqueue.test(line.text);
  }
  if (cursorUuid.startsWith('generated-')) {
    return (line, message) =>
      message ? message.uuid === cursorUuid : cursorUuid === `generated-${line.offset}`;
  }
  const pattern = new RegExp(`"uuid"\\s*:\\s*"${escapeRegExp(cursorUuid)}"`);
  return (line, message) => (message ? message.uuid === cursorUuid : pattern.test(line.text));
}

/**
 * The `limit` messages immediately before a cursor - the "load older" page.
 *
 * Stops once the page is full instead of reading the file, so the cost tracks
 * how far back the cursor sits rather than how large the transcript is.
 */
function readBeforeCursor(
  filePath: string,
  limit: number,
  beforeUuid: string
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const scanner = new BackwardScanner(filePath, MAX_CURSOR_SCAN_BYTES);
  try {
    const olderNewestFirst: ReadMessageEntry[] = [];
    const isCursor = cursorMatcher(beforeUuid);
    let found = false;

    scan: while (true) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        const message = shownMessage(filePath, line, parseLineToMessage(line.text, line.offset));
        if (!found) {
          found = isCursor(line, message);
          continue;
        }
        if (!message) continue;

        olderNewestFirst.push(message);
        // One past the page tells us whether anything older remains.
        if (olderNewestFirst.length > limit) break scan;
      }
    }
    // A cursor the scan never met was most likely compacted away. Only claim the
    // conversation has nothing older when the whole file was searched - a scan
    // that stopped at its budget knows nothing about what lies beyond it, and
    // "no more" there draws the beginning-of-conversation marker mid-session.
    if (!found) return { messages: [], hasMore: !scanner.reachedStart };

    const older = olderNewestFirst.slice().reverse();
    interpolateTimestamps(older);
    return page(older.slice(-limit), olderNewestFirst.length > limit || !scanner.reachedStart);
  } finally {
    scanner.close();
  }
}

/**
 * The `limit` messages immediately after a cursor - the incremental fetch.
 *
 * Holds only the messages nearest the cursor as it scans, so a cursor left far
 * behind costs time but not memory.
 */
function readAfterCursor(
  filePath: string,
  limit: number,
  afterUuid: string
): { messages: ReadMessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const scanner = new BackwardScanner(filePath, MAX_CURSOR_SCAN_BYTES);
  try {
    const nearestCursor: ReadMessageEntry[] = [];
    const isCursor = cursorMatcher(afterUuid);
    let newerThanCursor = 0;
    let found = false;

    scan: while (true) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        const message = shownMessage(filePath, line, parseLineToMessage(line.text, line.offset));
        if (isCursor(line, message)) {
          found = true;
          break scan;
        }
        if (!message) continue;

        nearestCursor.push(message);
        newerThanCursor++;
        if (nearestCursor.length > limit) nearestCursor.shift();
      }
    }
    // Stale cursor - "after this" is unanswerable once the entry is gone, and
    // returning the file tail made clients append messages they already had.
    if (!found) return { messages: [], hasMore: false };

    const messages = nearestCursor.slice().reverse();
    interpolateTimestamps(messages);
    return page(messages, newerThanCursor > limit);
  } finally {
    scanner.close();
  }
}
