import * as fs from 'fs';
import * as path from 'path';
import { ensureSessionsDir, getSessionsDir } from '../config/config';
import { MessageEntry } from '../client/messages';
import { generateUuid } from './generator';

/**
 * JSONL entry format (matches Claude CLI format)
 */
interface JsonlEntry {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  timestamp: string;
  message: {
    content: Array<{ type: 'text'; text: string }> | string;
  };
}

/**
 * Get the file path for a session
 */
export function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

/**
 * Initialize a session file with user message
 */
export function initSessionFile(sessionId: string, userMessage: string): string {
  ensureSessionsDir();

  const filePath = getSessionFilePath(sessionId);
  const uuid = generateUuid();

  const entry: JsonlEntry = {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'text', text: userMessage }]
    }
  };

  fs.writeFileSync(filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });

  return uuid;
}

/**
 * Append an assistant message to the session file
 */
export function appendAssistantMessage(sessionId: string, content: string): string {
  const filePath = getSessionFilePath(sessionId);
  const uuid = generateUuid();

  const entry: JsonlEntry = {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'text', text: content }]
    }
  };

  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');

  return uuid;
}

/**
 * Append a user message to the session file
 */
export function appendUserMessage(sessionId: string, content: string): string {
  const filePath = getSessionFilePath(sessionId);
  const uuid = generateUuid();

  const entry: JsonlEntry = {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'text', text: content }]
    }
  };

  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');

  return uuid;
}

/**
 * Read messages from a session file
 */
export function readSessionMessages(
  sessionId: string,
  limit: number = 50,
  beforeUuid?: string,
  afterUuid?: string
): { messages: MessageEntry[]; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const filePath = getSessionFilePath(sessionId);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${sessionId}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  const allMessages: MessageEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonlEntry;

      // Skip system messages
      if (entry.type === 'system') continue;

      // Extract text content
      let textContent = '';
      if (typeof entry.message.content === 'string') {
        textContent = entry.message.content;
      } else if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'text') {
            textContent += block.text;
          }
        }
      }

      allMessages.push({
        uuid: entry.uuid,
        role: entry.type === 'user' ? 'USER' : 'AGENT',
        content: textContent,
        timestamp: entry.timestamp
      });
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Apply cursor-based pagination
  let startIndex = 0;
  let endIndex = allMessages.length;

  if (beforeUuid) {
    // Find index of beforeUuid and take messages before it
    const idx = allMessages.findIndex(m => m.uuid === beforeUuid);
    if (idx !== -1) {
      endIndex = idx;
    }
  }

  if (afterUuid) {
    // Find index of afterUuid and take messages after it
    const idx = allMessages.findIndex(m => m.uuid === afterUuid);
    if (idx !== -1) {
      startIndex = idx + 1;
    }
  }

  // Get the slice
  let messages = allMessages.slice(startIndex, endIndex);

  // Apply limit (take from the end for backwards pagination)
  const hasMore = messages.length > limit;
  if (beforeUuid && hasMore) {
    // For backwards pagination, take last N
    messages = messages.slice(-limit);
  } else if (hasMore) {
    // For forwards/initial, take first N
    messages = messages.slice(0, limit);
  }

  return {
    messages,
    hasMore,
    oldestUuid: messages.length > 0 ? messages[0].uuid : undefined,
    newestUuid: messages.length > 0 ? messages[messages.length - 1].uuid : undefined
  };
}

/**
 * Get the last message from a session file
 * Also returns the last user message UUID for verbose output positioning
 */
export function getLastMessage(sessionId: string): { content: string; isCompletion: boolean; messageCount: number; userMessageUuid?: string } | null {
  const filePath = getSessionFilePath(sessionId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  let lastEntry: JsonlEntry | null = null;
  let lastUserUuid: string | undefined;
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonlEntry;
      if (entry.type !== 'system') {
        messageCount++;
        lastEntry = entry;
        // Track the last user message UUID
        if (entry.type === 'user') {
          lastUserUuid = entry.uuid;
        }
      }
    } catch {
      continue;
    }
  }

  if (!lastEntry) return null;

  let textContent = '';
  if (typeof lastEntry.message.content === 'string') {
    textContent = lastEntry.message.content;
  } else if (Array.isArray(lastEntry.message.content)) {
    for (const block of lastEntry.message.content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }
  }

  return {
    content: textContent,
    isCompletion: lastEntry.type === 'assistant',
    messageCount,
    userMessageUuid: lastUserUuid
  };
}

/**
 * Check if session file exists
 */
export function sessionExists(sessionId: string): boolean {
  return fs.existsSync(getSessionFilePath(sessionId));
}
