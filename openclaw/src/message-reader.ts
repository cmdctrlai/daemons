/**
 * Read messages from OpenClaw session JSONL transcripts with pagination.
 *
 * JSONL layout (first line = metadata, subsequent lines = events/messages).
 * Each message line is expected to have something like:
 *   { role: "user"|"assistant", content: "...", timestamp: "...", id: "..." }
 * We're flexible about field names since the exact schema isn't pinned.
 */

import * as fs from 'fs';
import type { MessageEntry } from '@cmdctrl/daemon-sdk';
import { findTranscriptFile } from './session-discovery';

const CHUNK_SIZE = 64 * 1024;
const MAX_LINE_SIZE = 100 * 1024;

interface MessagePayload {
  role?: string;
  content?: unknown;
  text?: string;
  timestamp?: string | number;
}

interface RawEntry {
  id?: string;
  uuid?: string;
  role?: string;
  type?: string;
  content?: unknown;
  text?: string;
  message?: MessagePayload;
  timestamp?: string | number;
  createdAt?: string | number;
  // First line has no role – it's session metadata
  sessionId?: string;
  version?: unknown;
}

/**
 * Strip OpenClaw's "Sender (untrusted metadata)" wrapper from user messages.
 * The wrapper format is:
 *   Sender (untrusted metadata):\n```json\n{...}\n```\n\n[timestamp] actual message
 * Returns the actual user text after the [timestamp] prefix.
 */
function stripSenderMetadata(text: string): string {
  if (!text.startsWith('Sender (untrusted metadata):')) return text;
  // Find the [timestamp] line and extract everything after it
  const match = text.match(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]+\]\s*/);
  if (match && match.index !== undefined) {
    return text.slice(match.index + match[0].length).trim();
  }
  return text;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text || '')
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object') {
    const c = content as { text?: string; content?: string };
    return (c.text || c.content || '').toString().trim();
  }
  return '';
}

function toIso(value: string | number | undefined): string {
  if (!value) return '';
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function parseLine(line: string, index: number): MessageEntry | null {
  try {
    const entry = JSON.parse(line) as RawEntry;

    // OpenClaw wraps messages as { type: "message", message: { role, content } }
    // Unwrap the nested message payload when present
    const msg = entry.type === 'message' && entry.message ? entry.message : null;
    const role = msg?.role || entry.role || '';

    let normalizedRole: 'USER' | 'AGENT';
    if (role === 'user') {
      normalizedRole = 'USER';
    } else if (role === 'assistant' || role === 'agent') {
      normalizedRole = 'AGENT';
    } else {
      return null; // Skip session headers, model_change, custom, toolResult, etc.
    }

    const text = msg
      ? extractText(msg.content) || msg.text || ''
      : entry.content !== undefined
        ? extractText(entry.content)
        : entry.text || '';

    if (!text) return null;

    // Strip OpenClaw's sender metadata wrapper from user messages
    const cleanText = normalizedRole === 'USER' ? stripSenderMetadata(text) : text;
    if (!cleanText) return null;

    return {
      uuid: entry.id || entry.uuid || `generated-${index}`,
      role: normalizedRole,
      content: cleanText,
      timestamp: toIso(entry.timestamp) || toIso(entry.createdAt),
    };
  } catch {
    return null;
  }
}

/**
 * Read all lines from a JSONL file, truncating oversized lines defensively.
 */
function readAllLines(filePath: string): string[] {
  const stats = fs.statSync(filePath);
  const lines: string[] = [];
  const fd = fs.openSync(filePath, 'r');
  let position = 0;
  let current = '';
  let overflowed = false;

  try {
    while (position < stats.size) {
      const chunkSize = Math.min(CHUNK_SIZE, stats.size - position);
      const chunk = Buffer.alloc(chunkSize);
      fs.readSync(fd, chunk, 0, chunkSize, position);
      position += chunkSize;

      const text = chunk.toString('utf-8');
      for (const ch of text) {
        if (ch === '\n') {
          const trimmed = current.trim();
          if (trimmed && !overflowed) lines.push(trimmed);
          current = '';
          overflowed = false;
        } else if (current.length < MAX_LINE_SIZE) {
          current += ch;
        } else {
          overflowed = true;
        }
      }
    }
    const trimmed = current.trim();
    if (trimmed && !overflowed) lines.push(trimmed);
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/**
 * Read messages from an OpenClaw session transcript with cursor pagination.
 */
export function readMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string,
): { messages: MessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const filePath = findTranscriptFile(sessionId);
  if (!filePath) return { messages: [], hasMore: false };

  const lines = readAllLines(filePath);
  const all: MessageEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const msg = parseLine(lines[i], i);
    if (msg) all.push(msg);
  }

  if (afterUuid) {
    const idx = all.findIndex((m) => m.uuid === afterUuid);
    const start = idx >= 0 ? idx + 1 : Math.max(0, all.length - limit);
    const end = Math.min(start + limit, all.length);
    const result = all.slice(start, end);
    return {
      messages: result,
      hasMore: end < all.length,
      oldestUuid: result[0]?.uuid,
      newestUuid: result[result.length - 1]?.uuid,
    };
  }

  if (beforeUuid) {
    const idx = all.findIndex((m) => m.uuid === beforeUuid);
    if (idx < 0) return { messages: [], hasMore: false };
    const start = Math.max(0, idx - limit);
    const result = all.slice(start, idx);
    return {
      messages: result,
      hasMore: start > 0,
      oldestUuid: result[0]?.uuid,
      newestUuid: result[result.length - 1]?.uuid,
    };
  }

  const result = all.slice(-limit);
  return {
    messages: result,
    hasMore: all.length > limit,
    oldestUuid: result[0]?.uuid,
    newestUuid: result[result.length - 1]?.uuid,
  };
}
