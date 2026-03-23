/**
 * Copilot CLI Session Watcher
 *
 * Polls Copilot CLI events.jsonl session files for new messages and emits typed events:
 *   - USER_MESSAGE: lines with type "user.message"
 *   - AGENT_RESPONSE: lines with type "assistant.message"
 *
 * Uses the same stable UUID scheme as readSessionMessages so IDs are consistent.
 *
 * Copilot sessions are stored as JSONL files appended to:
 *   ~/.copilot/session-state/<uuid>/events.jsonl
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

// Polling interval (500ms)
const POLL_INTERVAL_MS = 500;

// Time to wait after AGENT_RESPONSE before declaring completion
const COMPLETION_DELAY_MS = 5000;

export interface CopilotSessionEvent {
  type: 'AGENT_RESPONSE' | 'USER_MESSAGE';
  sessionId: string;
  uuid: string;
  content: string;
  timestamp: string;
}

export interface CopilotCompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

type EventCallback = (event: CopilotSessionEvent) => void;
type CompletionCallback = (event: CopilotCompletionEvent) => void;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  lastSize: number;
  processedMessageCount: number;
  messageCount: number;
  lastMessage: string;
}

export class CopilotSessionWatcher {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private completionTimers: Map<string, NodeJS.Timeout> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private onEvent: EventCallback;
  private onCompletion: CompletionCallback | null;

  constructor(onEvent: EventCallback, onCompletion?: CompletionCallback) {
    this.onEvent = onEvent;
    this.onCompletion = onCompletion || null;
  }

  watchSession(sessionId: string, filePath: string): void {
    if (this.watchedSessions.has(sessionId)) {
      console.log(`[CopilotWatcher] Already watching session ${sessionId}`);
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.warn(`[CopilotWatcher] File not found: ${filePath}`);
      return;
    }

    try {
      const stats = fs.statSync(filePath);
      const messages = this.parseAllMessages(filePath);
      const lastAgent = [...messages].reverse().find(m => m.role === 'agent');

      this.watchedSessions.set(sessionId, {
        sessionId,
        filePath,
        lastSize: stats.size,
        processedMessageCount: messages.length,
        messageCount: messages.length,
        lastMessage: lastAgent?.content.slice(0, 200) || '',
      });

      console.log(`[CopilotWatcher] Started watching session ${sessionId} (${messages.length} existing messages)`);

      if (!this.pollTimer) {
        this.startPolling();
      }
    } catch (err) {
      console.error(`[CopilotWatcher] Failed to watch ${filePath}:`, err);
    }
  }

  unwatchSession(sessionId: string): void {
    this.cancelCompletionTimer(sessionId);
    if (this.watchedSessions.delete(sessionId)) {
      console.log(`[CopilotWatcher] Stopped watching session ${sessionId}`);
    }
    if (this.watchedSessions.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  unwatchAll(): void {
    for (const timer of this.completionTimers.values()) {
      clearTimeout(timer);
    }
    this.completionTimers.clear();
    this.watchedSessions.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[CopilotWatcher] Stopped watching all sessions');
  }

  get watchCount(): number {
    return this.watchedSessions.size;
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      for (const session of this.watchedSessions.values()) {
        this.checkSession(session);
      }
    }, POLL_INTERVAL_MS);
  }

  private checkSession(session: WatchedSession): void {
    try {
      if (!fs.existsSync(session.filePath)) {
        console.warn(`[CopilotWatcher] File no longer exists: ${session.filePath}`);
        this.unwatchSession(session.sessionId);
        return;
      }

      const stats = fs.statSync(session.filePath);
      if (stats.size === session.lastSize) {
        return;
      }

      session.lastSize = stats.size;

      const allMessages = this.parseAllMessages(session.filePath);
      const newMessages = allMessages.slice(session.processedMessageCount);

      if (newMessages.length === 0) {
        return;
      }

      let sawAgentResponse = false;
      let sawUserMessage = false;

      for (const msg of newMessages) {
        if (!msg.content) continue;

        const uuid = stableUuid(session.sessionId + ':' + msg.id);
        const event: CopilotSessionEvent = {
          type: msg.role === 'user' ? 'USER_MESSAGE' : 'AGENT_RESPONSE',
          sessionId: session.sessionId,
          uuid,
          content: msg.content,
          timestamp: msg.timestamp,
        };

        console.log(`[CopilotWatcher] Emitting ${event.type} for ${session.sessionId.slice(-8)}: "${msg.content.slice(0, 60)}..."`);
        this.onEvent(event);

        if (msg.role === 'agent') {
          sawAgentResponse = true;
          session.lastMessage = msg.content.slice(0, 200);
        } else if (msg.role === 'user') {
          sawUserMessage = true;
        }

        session.messageCount++;
      }

      session.processedMessageCount = allMessages.length;

      if (sawAgentResponse && !sawUserMessage) {
        this.startCompletionTimer(session);
      }
    } catch (err) {
      console.error(`[CopilotWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }

  /**
   * Parse all user/agent messages from the events.jsonl file.
   * Mirrors the logic in session-discovery.ts parseSessionFile.
   */
  private parseAllMessages(filePath: string): Array<{
    id: string;
    timestamp: string;
    role: 'user' | 'agent';
    content: string;
  }> {
    const messages: Array<{ id: string; timestamp: string; role: 'user' | 'agent'; content: string }> = [];

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      let messageIndex = 0;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as {
            type: string;
            data: Record<string, unknown>;
            timestamp: string;
          };

          if (obj.type === 'user.message') {
            const content = (obj.data.content as string) || '';
            if (content) {
              messages.push({
                id: `user-${messageIndex++}`,
                timestamp: obj.timestamp,
                role: 'user',
                content,
              });
            }
          } else if (obj.type === 'assistant.message') {
            const content = (obj.data.content as string) || '';
            if (content) {
              messages.push({
                id: `agent-${messageIndex++}`,
                timestamp: obj.timestamp,
                role: 'agent',
                content,
              });
            }
          }
        } catch {
          // skip invalid lines
        }
      }
    } catch (err) {
      console.error('[CopilotWatcher] Error reading file:', err);
    }

    return messages;
  }

  private startCompletionTimer(session: WatchedSession): void {
    this.cancelCompletionTimer(session.sessionId);
    if (!this.onCompletion) return;

    const timer = setTimeout(() => {
      this.completionTimers.delete(session.sessionId);
      if (this.onCompletion) {
        this.onCompletion({
          sessionId: session.sessionId,
          filePath: session.filePath,
          lastMessage: session.lastMessage,
          messageCount: session.messageCount,
        });
      }
    }, COMPLETION_DELAY_MS);

    this.completionTimers.set(session.sessionId, timer);
  }

  private cancelCompletionTimer(sessionId: string): void {
    const timer = this.completionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.completionTimers.delete(sessionId);
    }
  }
}

/**
 * Generate a stable UUID from an input string.
 * Must match the same logic in session-discovery.ts so UUIDs are consistent.
 */
function stableUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
