/**
 * In-Memory Message Store
 *
 * Stores conversation messages for retrieval by CmdCtrl clients.
 * The daemon is the source of truth for message history.
 *
 * For production daemons, you may want to persist messages to disk
 * (JSONL, SQLite, etc.) so history survives daemon restarts.
 */

import { randomUUID } from 'crypto';
import { MessageEntry } from './messages';

const sessions = new Map<string, MessageEntry[]>();

/**
 * Store a message and return its UUID.
 */
export function storeMessage(
  sessionId: string,
  role: 'USER' | 'AGENT' | 'SYSTEM',
  content: string
): string {
  const uuid = randomUUID();
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, []);
  }
  sessions.get(sessionId)!.push({
    uuid,
    role,
    content,
    timestamp: new Date().toISOString(),
  });
  return uuid;
}

/**
 * Retrieve messages for a session with cursor-based pagination.
 */
export function getMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): {
  messages: MessageEntry[];
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
} {
  let messages = sessions.get(sessionId) || [];

  if (beforeUuid) {
    const idx = messages.findIndex(m => m.uuid === beforeUuid);
    if (idx > 0) messages = messages.slice(0, idx);
  }

  if (afterUuid) {
    const idx = messages.findIndex(m => m.uuid === afterUuid);
    if (idx >= 0) messages = messages.slice(idx + 1);
  }

  const hasMore = messages.length > limit;
  const limited = messages.slice(-limit);

  return {
    messages: limited,
    hasMore,
    oldestUuid: limited[0]?.uuid,
    newestUuid: limited[limited.length - 1]?.uuid,
  };
}

/**
 * Delete all messages for a session.
 */
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
