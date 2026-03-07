/**
 * JSONL message reader with pagination support
 * Reads messages from Claude Code session files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageEntry } from './client/messages';

// Size of chunks to read when scanning for messages
const CHUNK_SIZE = 64 * 1024; // 64KB

// Safety limits to prevent memory exhaustion from bloated sessions (e.g., sessions with many large images)
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB - warn threshold for large files
const MAX_LINE_SIZE = 100 * 1024; // 100KB - truncate lines larger than this (likely contain base64 images)
const LINE_TAIL_SIZE = 1024; // 1KB - also capture tail of long lines (uuid, timestamp are at the end)
const TRUNCATED_LINE_MARKER = '\x00TRUNCATED\x00'; // Marker added to truncated lines
const TRUNCATED_MID_MARKER = '\x00MID\x00'; // Separator between head and tail of truncated lines

interface JournalEntry {
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
        // Skip tool_use, tool_result, image blocks etc.
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
 * Detect Claude Code compaction/summary messages and system notifications
 * Note: Most bash-notification entries are type:"queue-operation" (filtered by type),
 * but some appear as type:"user" with <bash-notification> content
 */
function isSystemMessage(content: string): boolean {
  const systemPrefixes = [
    'This session is being continued from a previous conversation',
    'This conversation is being continued from a previous session',
    '<system-reminder>',
    '<bash-notification>',
    '<task-notification>',
  ];
  for (const prefix of systemPrefixes) {
    if (content.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect non-user content: structured data (JSON objects/arrays), XML-like tags,
 * or other machine-generated content that should not be displayed as user messages.
 * This is a safety net – rather than blocklisting known bad patterns, we reject
 * anything that doesn't look like plain text typed by a human.
 */
function isNonUserContent(content: string): boolean {
  const trimmed = content.trim();
  // JSON objects or arrays (e.g., task spawn notifications, tool results)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return true;
  }
  // XML/HTML-like tags not already caught by isSystemMessage
  if (trimmed.startsWith('<') && trimmed.length > 1 && trimmed[1] !== ' ') {
    return true;
  }
  return false;
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
 * Parse a JSONL line into a MessageEntry if it's a displayable message
 * For truncated lines (marked with TRUNCATED_LINE_MARKER), we extract UUID via regex
 * and return a placeholder message instead of the full content
 */
function parseLineToMessage(line: string, index: number): MessageEntry | null {
  try {
    // Check if this line was truncated by the streaming reader
    const isTruncated = line.endsWith(TRUNCATED_LINE_MARKER);

    let entry: JournalEntry;
    if (isTruncated) {
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
          // Skip system messages and non-user content (JSON, tags, etc.)
          if (isSystemMessage(queueContent) || isNonUserContent(queueContent)) {
            return null;
          }
          return {
            uuid: `queue-${index}`,
            role: 'USER',
            content: queueContent,
            timestamp: timestampMatch ? timestampMatch[1] : '',
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

      // Skip system messages and non-user content (JSON, tags, etc.)
      if (content && (isSystemMessage(content) || isNonUserContent(content))) {
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

    // Handle queue-operation/enqueue entries (user messages sent via CmdCtrl UI)
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && entry.content) {
      // Skip system messages and non-user content (JSON, tags, etc.)
      if (isSystemMessage(entry.content) || isNonUserContent(entry.content)) {
        return null;
      }
      return {
        uuid: `queue-${index}`,
        role: 'USER',
        content: entry.content,
        timestamp: entry.timestamp || '',
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

    // Detect system messages and non-user content (JSON, tags, etc.)
    if (role === 'USER' && (isSystemMessage(text) || isNonUserContent(text))) {
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
 * Truncate a line, keeping both head (for type) and tail (for uuid, timestamp)
 * Format: {head}TRUNCATED_MID_MARKER{tail}TRUNCATED_LINE_MARKER
 */
function truncateLine(line: string): string {
  const head = line.substring(0, MAX_LINE_SIZE);
  const tail = line.substring(Math.max(MAX_LINE_SIZE, line.length - LINE_TAIL_SIZE));
  return head + TRUNCATED_MID_MARKER + tail + TRUNCATED_LINE_MARKER;
}

/**
 * Read the first few lines from a file using forward reading.
 * Uses the same sliding-window approach as readAllLinesSafe to correctly
 * capture head+tail for large lines (e.g. base64 image messages).
 * Called by readLastLines to recover oversized early-file lines that the
 * backward reader cannot reconstruct accurately from contaminated buffer remnants.
 */
function readFirstLines(fd: number, fileSize: number): string[] {
  // Read up to 3× MAX_LINE_SIZE (300KB) — enough to cover a few large lines
  const readBound = Math.min(fileSize, MAX_LINE_SIZE * 3);
  const lines: string[] = [];
  let position = 0;
  let currentLineHead = '';
  let currentLineTail = '';
  let lineOverflowed = false;

  while (position < readBound) {
    const chunkSize = Math.min(CHUNK_SIZE, readBound - position);
    const chunk = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, chunk, 0, chunkSize, position);
    if (bytesRead === 0) break;
    position += bytesRead;

    const text = chunk.slice(0, bytesRead).toString('utf-8');
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '\n') {
        const trimmedHead = currentLineHead.trim();
        if (trimmedHead) {
          if (lineOverflowed) {
            lines.push(trimmedHead + TRUNCATED_MID_MARKER + currentLineTail.trim() + TRUNCATED_LINE_MARKER);
          } else {
            lines.push(trimmedHead);
          }
        }
        currentLineHead = '';
        currentLineTail = '';
        lineOverflowed = false;
      } else {
        if (currentLineHead.length < MAX_LINE_SIZE) {
          currentLineHead += char;
        } else {
          lineOverflowed = true;
          currentLineTail += char;
          if (currentLineTail.length > LINE_TAIL_SIZE) {
            currentLineTail = currentLineTail.slice(-LINE_TAIL_SIZE);
          }
        }
      }
    }
  }

  // Capture any partial line at the readBound boundary
  const trimmedHead = currentLineHead.trim();
  if (trimmedHead) {
    if (lineOverflowed) {
      lines.push(trimmedHead + TRUNCATED_MID_MARKER + currentLineTail.trim() + TRUNCATED_LINE_MARKER);
    } else {
      lines.push(trimmedHead);
    }
  }

  return lines;
}

/**
 * Read the last N lines from a file using backward reading (tail-like)
 * This is much faster than reading the entire file for large files
 */
function readLastLines(filePath: string, maxLines: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  const stats = fs.fstatSync(fd);
  const fileSize = stats.size;

  if (fileSize === 0) {
    fs.closeSync(fd);
    return [];
  }

  const lines: string[] = [];
  let position = fileSize;
  let buffer = '';

  // We need to read more lines than requested because many JSONL entries
  // won't be displayable messages (tool_use, system events, etc.)
  // Multiplier of 10x accounts for ~10% of entries being actual messages
  const targetLines = maxLines * 10;

  while (position > 0 && lines.length < targetLines) {
    // Read in chunks from the end
    const chunkSize = Math.min(CHUNK_SIZE, position);
    position -= chunkSize;

    const chunk = Buffer.alloc(chunkSize);
    fs.readSync(fd, chunk, 0, chunkSize, position);
    buffer = chunk.toString('utf-8') + buffer;

    // Extract complete lines from buffer
    const newlineIndex = buffer.lastIndexOf('\n');
    if (newlineIndex !== -1) {
      // Split into lines, keeping the incomplete first line in buffer
      const completeLines = buffer.substring(0, newlineIndex).split('\n');
      buffer = buffer.substring(newlineIndex + 1);

      // Add lines in reverse order (we're reading backward)
      for (let i = completeLines.length - 1; i >= 0; i--) {
        const line = completeLines[i].trim();
        if (line) {
          // For oversized lines, keep both head and tail
          if (line.length > MAX_LINE_SIZE) {
            lines.unshift(truncateLine(line));
          } else {
            lines.unshift(line);
          }
        }
      }
    }
  }

  // Instead of using the potentially contaminated buffer remnant from backward reading,
  // do a bounded forward read from position 0 to correctly reconstruct any large lines
  // (e.g. base64 image messages) that span multiple chunks at the start of the file.
  const knownUuids = new Set<string>();
  for (const line of lines) {
    // Skip incomplete tail fragments from the backward reader – they start mid-line
    // (e.g. mid-base64) and don't begin with '{', but may still contain a uuid field
    if (!line.startsWith('{')) continue;
    const m = line.match(/"uuid"\s*:\s*"([^"]+)"/);
    if (m) knownUuids.add(m[1]);
  }
  const firstLines = readFirstLines(fd, fileSize);
  for (const line of firstLines) {
    const m = line.match(/"uuid"\s*:\s*"([^"]+)"/);
    if (m && !knownUuids.has(m[1])) {
      lines.unshift(line);
    }
  }

  fs.closeSync(fd);
  return lines;
}

/**
 * Read all lines from a file (streaming approach)
 * For oversized lines, keeps both head (for type) and tail (for uuid, timestamp)
 * Format for truncated: {head}TRUNCATED_MID_MARKER{tail}TRUNCATED_LINE_MARKER
 * Safer than fs.readFileSync for files with potentially huge lines
 */
function readAllLinesSafe(filePath: string): string[] {
  const stats = fs.statSync(filePath);

  // For very large files, warn but still try to process
  if (stats.size > MAX_FILE_SIZE) {
    console.warn(`[MessageReader] File ${filePath} is ${(stats.size / 1024 / 1024).toFixed(1)}MB, exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit. Processing may be slow.`);
  }

  const lines: string[] = [];
  const fd = fs.openSync(filePath, 'r');
  let position = 0;
  let currentLineHead = '';  // First MAX_LINE_SIZE chars
  let currentLineTail = '';  // Last LINE_TAIL_SIZE chars (sliding window)
  let lineOverflowed = false;

  try {
    while (position < stats.size) {
      const chunkSize = Math.min(CHUNK_SIZE, stats.size - position);
      const chunk = Buffer.alloc(chunkSize);
      fs.readSync(fd, chunk, 0, chunkSize, position);
      position += chunkSize;

      const text = chunk.toString('utf-8');

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\n') {
          const trimmedHead = currentLineHead.trim();
          if (trimmedHead) {
            // For truncated lines, include both head and tail with markers
            if (lineOverflowed) {
              lines.push(trimmedHead + TRUNCATED_MID_MARKER + currentLineTail.trim() + TRUNCATED_LINE_MARKER);
            } else {
              lines.push(trimmedHead);
            }
          }
          currentLineHead = '';
          currentLineTail = '';
          lineOverflowed = false;
        } else {
          // Keep building head up to MAX_LINE_SIZE
          if (currentLineHead.length < MAX_LINE_SIZE) {
            currentLineHead += char;
          } else {
            // Once overflowed, start tracking the tail (sliding window)
            lineOverflowed = true;
            currentLineTail += char;
            // Keep only the last LINE_TAIL_SIZE chars
            if (currentLineTail.length > LINE_TAIL_SIZE) {
              currentLineTail = currentLineTail.slice(-LINE_TAIL_SIZE);
            }
          }
        }
      }
    }

    // Handle final line without newline
    const trimmedHead = currentLineHead.trim();
    if (trimmedHead) {
      if (lineOverflowed) {
        lines.push(trimmedHead + TRUNCATED_MID_MARKER + currentLineTail.trim() + TRUNCATED_LINE_MARKER);
      } else {
        lines.push(trimmedHead);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/**
 * Remove queue-sourced USER messages that have a matching type:"user" entry.
 * When a queued message is processed by Claude Code, both a queue-operation/enqueue
 * and a type:"user" entry exist in the JSONL. We prefer the type:"user" entry.
 */
function deduplicateQueueMessages(messages: MessageEntry[]): MessageEntry[] {
  // Collect content from non-queue user messages
  const realUserContent = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'USER' && !msg.uuid.startsWith('queue-')) {
      realUserContent.add(msg.content);
    }
  }

  // Filter out queue messages whose content matches a real user entry
  return messages.filter(msg => {
    if (msg.uuid.startsWith('queue-') && realUserContent.has(msg.content)) {
      return false;
    }
    return true;
  });
}

/**
 * Fill in missing timestamps from neighboring messages.
 * Truncated lines may fail to extract timestamps; use the next message's
 * timestamp as fallback, or the previous message's if there is no next.
 */
function interpolateTimestamps(messages: MessageEntry[]): void {
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
): { messages: MessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const filePath = findSessionFile(sessionId);

  if (!filePath) {
    return { messages: [], hasMore: false };
  }

  // Fast path: no cursor – use backward reader for efficiency on large files
  if (!beforeUuid && !afterUuid) {
    const lines = readLastLines(filePath, limit);
    const messages: MessageEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const msg = parseLineToMessage(lines[i], i);
      if (msg) messages.push(msg);
    }
    const dedupedMessages = deduplicateQueueMessages(messages);
    interpolateTimestamps(dedupedMessages);
    const resultMessages = dedupedMessages.slice(-limit);
    const hasMore = dedupedMessages.length > limit;
    return {
      messages: resultMessages,
      hasMore,
      oldestUuid: resultMessages.length > 0 ? resultMessages[0].uuid : undefined,
      newestUuid: resultMessages.length > 0 ? resultMessages[resultMessages.length - 1].uuid : undefined,
    };
  }

  // Cursor paths – need access to all messages in the file
  const lines = readAllLinesSafe(filePath);

  // Parse all message entries and deduplicate queue messages
  const rawMessages: MessageEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const msg = parseLineToMessage(lines[i], i);
    if (msg) {
      rawMessages.push(msg);
    }
  }

  const allMessages = deduplicateQueueMessages(rawMessages);
  interpolateTimestamps(allMessages);

  // Handle afterUuid - return messages AFTER the given UUID (for incremental updates)
  if (afterUuid) {
    const cursorIndex = allMessages.findIndex(m => m.uuid === afterUuid);
    if (cursorIndex >= 0) {
      // Get messages after the cursor
      const startIndex = cursorIndex + 1;
      const endIndex = Math.min(startIndex + limit, allMessages.length);
      const resultMessages = allMessages.slice(startIndex, endIndex);
      const hasMore = endIndex < allMessages.length;

      return {
        messages: resultMessages,
        hasMore,
        oldestUuid: resultMessages.length > 0 ? resultMessages[0].uuid : undefined,
        newestUuid: resultMessages.length > 0 ? resultMessages[resultMessages.length - 1].uuid : undefined,
      };
    }
    // Stale cursor (likely compacted away) - fall back to returning latest messages
    // This ensures clients get current data even after session compaction
    const endIndex = allMessages.length;
    const beginIndex = Math.max(0, endIndex - limit);
    const resultMessages = allMessages.slice(beginIndex, endIndex);
    const hasMore = beginIndex > 0;

    return {
      messages: resultMessages,
      hasMore,
      oldestUuid: resultMessages.length > 0 ? resultMessages[0].uuid : undefined,
      newestUuid: resultMessages.length > 0 ? resultMessages[resultMessages.length - 1].uuid : undefined,
    };
  }

  // Handle beforeUuid - return messages BEFORE the given UUID (for loading older)
  let startIndex = allMessages.length;
  if (beforeUuid) {
    const cursorIndex = allMessages.findIndex(m => m.uuid === beforeUuid);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex;
    } else {
      // Stale cursor (likely compacted away) - return empty for "load older"
      // User's current view may be outdated; they should refresh to get current messages
      return { messages: [], hasMore: false };
    }
  }

  // Get messages before the cursor (or from end if no cursor)
  const endIndex = startIndex;
  const beginIndex = Math.max(0, endIndex - limit);

  const resultMessages = allMessages.slice(beginIndex, endIndex);
  const hasMore = beginIndex > 0;

  return {
    messages: resultMessages,
    hasMore,
    oldestUuid: resultMessages.length > 0 ? resultMessages[0].uuid : undefined,
    newestUuid: resultMessages.length > 0 ? resultMessages[resultMessages.length - 1].uuid : undefined,
  };
}
