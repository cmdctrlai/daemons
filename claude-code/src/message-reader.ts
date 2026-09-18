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
  hasHarnessFlagInRawLine,
  isHarnessEntry,
  isHarnessText,
} from './transcript-filter';

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
export type ReadMessageEntry = MessageEntry & { question?: MessageQuestion };

// Size of chunks to read when scanning for messages
const CHUNK_SIZE = 64 * 1024; // 64KB

// Safety limits to prevent memory exhaustion from bloated sessions (e.g., sessions with many large images)
const MAX_LINE_SIZE = 100 * 1024; // 100KB - truncate lines larger than this (likely contain base64 images)
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
// How many USER messages stay eligible for queue de-duplication. Digests, not
// content, so a transcript of pasted logs costs the same as one of one-liners
// and the window stays far longer than any queue entry waits to be processed.
const DEDUPE_HISTORY_ENTRIES = 50_000;
const LINE_TAIL_SIZE = 1024; // 1KB - also capture tail of long lines (uuid, timestamp are at the end)
const TRUNCATED_LINE_MARKER = '\x00TRUNCATED\x00'; // Marker added to truncated lines
const TRUNCATED_MID_MARKER = '\x00MID\x00'; // Separator between head and tail of truncated lines

interface JournalEntry extends TranscriptEntryFlags {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  operation?: string;
  content?: string;
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
 * Parse a JSONL line into a MessageEntry if it's a displayable message
 * For truncated lines (marked with TRUNCATED_LINE_MARKER), we extract UUID via regex
 * and return a placeholder message instead of the full content
 */
function parseLineToMessage(line: string, index: number): ReadMessageEntry | null {
  try {
    // Check if this line was truncated by the streaming reader
    const isTruncated = line.endsWith(TRUNCATED_LINE_MARKER);

    let entry: JournalEntry;
    if (isTruncated) {
      // The flags survive truncation in one half or the other, so match them on
      // the raw line rather than losing them with the unparsed body.
      if (hasHarnessFlagInRawLine(line)) {
        return null;
      }

      // Truncated line format: {head}TRUNCATED_MID_MARKER{tail}TRUNCATED_LINE_MARKER
      // - head contains: type (near start)
      // - tail contains: uuid, timestamp (at end of original line)
      const lineWithoutEndMarker = line.slice(0, -TRUNCATED_LINE_MARKER.length);
      const midIndex = lineWithoutEndMarker.indexOf(TRUNCATED_MID_MARKER);

      let headPart: string;
      let tailPart: string;
      if (midIndex >= 0) {
        headPart = lineWithoutEndMarker.slice(0, midIndex);
        tailPart = lineWithoutEndMarker.slice(midIndex + TRUNCATED_MID_MARKER.length);
      } else {
        // Old format (no mid marker) - only have head
        headPart = lineWithoutEndMarker;
        tailPart = '';
      }

      // Type is in the head
      const typeMatch = headPart.match(/"type"\s*:\s*"([^"]+)"/);
      // UUID is in the tail (or occasionally in head if line wasn't too long)
      const uuidMatch = tailPart.match(/"uuid"\s*:\s*"([^"]+)"/)
                     || headPart.match(/"uuid"\s*:\s*"([^"]+)"/);
      // Timestamp is also in the tail
      const timestampMatch = tailPart.match(/"timestamp"\s*:\s*"([^"]+)"/);

      if (!uuidMatch || !typeMatch) {
        return null;
      }

      const type = typeMatch[1];

      // Handle truncated queue-operation entries (unlikely but safe)
      if (type === 'queue-operation') {
        const opMatch = headPart.match(/"operation"\s*:\s*"enqueue"/);
        const contentMatch = headPart.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (opMatch && contentMatch) {
          const queueContent = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
          if (isHarnessText(queueContent)) {
            return null;
          }
          const ts = timestampMatch ? timestampMatch[1] : '';
          return {
            uuid: ts ? `queue-${ts}` : `queue-${index}`,
            role: 'USER',
            content: queueContent,
            timestamp: ts,
          };
        }
        return null;
      }

      if (type !== 'user' && type !== 'assistant') {
        return null;
      }

      // Try to extract the first text block from the head (user's actual text is near the start)
      // Pattern: {"type":"text","text":"..."} — extract the text value
      const textBlockMatch = headPart.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      let content = textBlockMatch ? textBlockMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';

      if (content && isHarnessText(content)) {
        content = '';
      }

      // Skip truncated user entries with no text (tool_result blocks, not real messages)
      if (!content && type === 'user') {
        return null;
      }

      // Fall back to placeholder for assistant messages with no extractable text
      if (!content) {
        content = '[Message contains large content]';
      }

      return {
        uuid: uuidMatch[1],
        role: type === 'user' ? 'USER' : 'AGENT',
        content,
        timestamp: timestampMatch ? timestampMatch[1] : '',
      };
    }

    entry = JSON.parse(line);

    // Harness-generated entries are never conversation, whatever their type.
    if (isHarnessEntry(entry)) {
      return null;
    }

    // Handle queue-operation/enqueue entries (user messages sent via CmdCtrl UI)
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && entry.content) {
      if (isHarnessText(entry.content)) {
        return null;
      }
      // Use timestamp-based UUID so the ID is stable across both the fast path
      // (readLastLines, scan-relative index) and the cursor path (readAllLinesSafe,
      // absolute line index). Positional `queue-${index}` IDs differ between paths
      // and produce stale cursors that corrupt incremental message fetches.
      const ts = entry.timestamp as string | undefined;
      return {
        uuid: ts ? `queue-${ts}` : `queue-${index}`,
        role: 'USER',
        content: entry.content,
        timestamp: ts || '',
      };
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
    const text = entry.message?.content
      ? extractReadableText(entry.message.content)
      : '';

    // Skip entries with no displayable text
    if (!text) {
      return null;
    }

    // Determine role
    let role: 'USER' | 'AGENT' | 'SYSTEM' = entry.type === 'user' ? 'USER' : 'AGENT';

    if (role === 'USER' && isHarnessText(text)) {
      return null;
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

/** A JSONL line and the byte offset it starts at. The offset is the stable
 *  identity for entries whose JSON carries no uuid, so the same entry keeps the
 *  same generated id on every page that reaches it. */
interface ScannedLine {
  text: string;
  offset: number;
}

/**
 * Streams a JSONL file backwards, newest line first, in bounded memory.
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
  private pendingHead: Buffer = Buffer.alloc(0);
  private pendingTail: Buffer | null = null;
  private pendingLen = 0;
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
    if (part.length === 0) return;

    const combined = Buffer.concat([part, this.pendingHead]);
    const newLen = this.pendingLen + part.length;

    // uuid and timestamp live at the end of the line, which backward reading
    // hands us first. Capture it before an oversized line pushes it out of range.
    if (this.pendingTail === null && newLen > MAX_LINE_SIZE) {
      this.pendingTail = Buffer.from(combined.subarray(Math.max(0, combined.length - LINE_TAIL_SIZE)));
    }

    this.pendingHead = newLen > MAX_LINE_SIZE
      ? Buffer.from(combined.subarray(0, MAX_LINE_SIZE))
      : combined;
    this.pendingLen = newLen;
  }

  /** Close off the assembled line, which starts at `offset`. */
  private finishLine(offset: number): ScannedLine | null {
    if (this.pendingLen === 0) return null;

    const head = this.pendingHead.toString('utf-8').trim();
    const tail = this.pendingTail;
    this.pendingHead = Buffer.alloc(0);
    this.pendingTail = null;
    this.pendingLen = 0;

    if (!head) return null;
    const text = tail === null
      ? head
      : head + TRUNCATED_MID_MARKER + tail.toString('utf-8').trim() + TRUNCATED_LINE_MARKER;
    return { text, offset };
  }
}

/**
 * Digests of real USER entries the scan has passed, so their queued twins can be
 * dropped. Backward reading meets the real entry before the queue entry it
 * supersedes, which is the order this relies on.
 */
class RecentUserContent {
  private readonly seen = new Set<string>();
  private order: string[] = [];
  // Eviction advances a read index and compacts in bulk. Shifting the array per
  // entry is linear in the window, which at this size dominates the whole scan.
  private head = 0;

  add(content: string): void {
    const digest = RecentUserContent.digest(content);
    if (this.seen.has(digest)) return;
    this.seen.add(digest);
    this.order.push(digest);
    if (this.seen.size > DEDUPE_HISTORY_ENTRIES) {
      this.seen.delete(this.order[this.head++]);
      if (this.head >= DEDUPE_HISTORY_ENTRIES) {
        this.order = this.order.slice(this.head);
        this.head = 0;
      }
    }
  }

  has(content: string): boolean {
    return this.seen.has(RecentUserContent.digest(content));
  }

  /** Queue entries carry the text as typed; the real entry's is trimmed. */
  private static digest(content: string): string {
    return crypto.createHash('sha1').update(content.trim()).digest('base64');
  }
}

/**
 * Fill in missing timestamps from neighboring messages.
 * Truncated lines may fail to extract timestamps; use the next message's
 * timestamp as fallback, or the previous message's if there is no next.
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
    const recentUsers = new RecentUserContent();
    const newestFirst: ReadMessageEntry[] = [];
    let lineCount = 0;

    while (lineCount < MAX_TAIL_SCAN_LINES) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        lineCount++;
        const message = parseLineToMessage(line.text, line.offset);
        if (!message) continue;
        if (message.role === 'USER' && !message.uuid.startsWith('queue-')) {
          recentUsers.add(message.content);
        }
        if (message.uuid.startsWith('queue-') && recentUsers.has(message.content)) continue;
        newestFirst.push(message);
      }

      if (newestFirst.length > limit) break;
    }

    const messages = newestFirst.slice().reverse();
    interpolateTimestamps(messages);
    // Older messages exist if the scan found more than fit on this page, or if
    // it gave up before reaching the start of the file.
    return page(messages.slice(-limit), messages.length > limit || !scanner.reachedStart);
  } finally {
    scanner.close();
  }
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
  if (cursorUuid.startsWith('generated-')) {
    return (line, message) =>
      message ? message.uuid === cursorUuid : cursorUuid === `generated-${line.offset}`;
  }
  const escaped = cursorUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"uuid"\\s*:\\s*"${escaped}"`);
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
    const recentUsers = new RecentUserContent();
    const olderNewestFirst: ReadMessageEntry[] = [];
    const isCursor = cursorMatcher(beforeUuid);
    let found = false;

    scan: while (true) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        const message = parseLineToMessage(line.text, line.offset);
        if (message && message.role === 'USER' && !message.uuid.startsWith('queue-')) {
          recentUsers.add(message.content);
        }
        if (!found) {
          found = isCursor(line, message);
          continue;
        }
        if (!message) continue;
        if (message.uuid.startsWith('queue-') && recentUsers.has(message.content)) continue;

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
    const recentUsers = new RecentUserContent();
    const nearestCursor: ReadMessageEntry[] = [];
    const isCursor = cursorMatcher(afterUuid);
    let newerThanCursor = 0;
    let found = false;

    scan: while (true) {
      const batch = scanner.next();
      if (batch.length === 0) break;

      for (const line of batch) {
        const message = parseLineToMessage(line.text, line.offset);
        if (isCursor(line, message)) {
          found = true;
          break scan;
        }
        if (!message) continue;
        if (message.role === 'USER' && !message.uuid.startsWith('queue-')) {
          recentUsers.add(message.content);
        }
        if (message.uuid.startsWith('queue-') && recentUsers.has(message.content)) continue;

        newerThanCursor++;
        nearestCursor.push(message);
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
