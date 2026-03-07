/**
 * In-memory message store for Codex CLI sessions.
 *
 * Codex CLI manages its own session files internally, but for CmdCtrl's
 * get_messages protocol we need to track messages ourselves.
 */

import { randomUUID } from 'crypto';
import { MessageEntry } from './client/messages';

export class MessageStore {
  private sessions: Map<string, MessageEntry[]> = new Map();

  storeMessage(sessionId: string, role: 'USER' | 'AGENT' | 'SYSTEM', content: string): string {
    const uuid = randomUUID();
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    this.sessions.get(sessionId)!.push({
      uuid,
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    return uuid;
  }

  getMessages(
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
    let messages = this.sessions.get(sessionId) || [];

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
}
