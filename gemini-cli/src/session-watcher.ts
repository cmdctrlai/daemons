/**
 * Gemini CLI Session Watcher
 *
 * Polls Gemini CLI JSON session files for new messages and emits typed events:
 *   - USER_MESSAGE: messages with type "user"
 *   - AGENT_RESPONSE: messages with type "gemini"
 *
 * Uses the same stable UUID scheme as readSessionMessages so IDs are consistent.
 *
 * Gemini sessions are stored as full JSON files (not JSONL) that are rewritten
 * on each update: ~/.gemini/tmp/<project>/chats/session-*.json
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

// Polling interval (500ms)
const POLL_INTERVAL_MS = 500;

// Time to wait after AGENT_RESPONSE before declaring completion
const COMPLETION_DELAY_MS = 5000;

export interface GeminiSessionEvent {
  type: 'AGENT_RESPONSE' | 'USER_MESSAGE';
  sessionId: string;
  uuid: string;
  content: string;
  timestamp: string;
}

export interface GeminiCompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

type EventCallback = (event: GeminiSessionEvent) => void;
type CompletionCallback = (event: GeminiCompletionEvent) => void;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  lastMtime: number;
  processedMessageCount: number;
  messageCount: number;
  lastMessage: string;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string | Array<{ text?: string }>;
}

interface GeminiSession {
  sessionId: string;
  messages: GeminiMessage[];
}

export class GeminiSessionWatcher {
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
      console.log(`[GeminiWatcher] Already watching session ${sessionId}`);
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.warn(`[GeminiWatcher] File not found: ${filePath}`);
      return;
    }

    try {
      const stats = fs.statSync(filePath);
      const messages = this.readMessages(filePath);
      const lastAgent = [...messages].reverse().find(m => m.type !== 'user');

      this.watchedSessions.set(sessionId, {
        sessionId,
        filePath,
        lastMtime: stats.mtimeMs,
        processedMessageCount: messages.length,
        messageCount: messages.length,
        lastMessage: lastAgent ? extractText(lastAgent.content).slice(0, 200) : '',
      });

      console.log(`[GeminiWatcher] Started watching session ${sessionId} (${messages.length} existing messages)`);

      if (!this.pollTimer) {
        this.startPolling();
      }
    } catch (err) {
      console.error(`[GeminiWatcher] Failed to watch ${filePath}:`, err);
    }
  }

  unwatchSession(sessionId: string): void {
    this.cancelCompletionTimer(sessionId);
    if (this.watchedSessions.delete(sessionId)) {
      console.log(`[GeminiWatcher] Stopped watching session ${sessionId}`);
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
    console.log('[GeminiWatcher] Stopped watching all sessions');
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
        console.warn(`[GeminiWatcher] File no longer exists: ${session.filePath}`);
        this.unwatchSession(session.sessionId);
        return;
      }

      const stats = fs.statSync(session.filePath);
      if (stats.mtimeMs === session.lastMtime) {
        return;
      }

      session.lastMtime = stats.mtimeMs;

      const allMessages = this.readMessages(session.filePath);
      const newMessages = allMessages.slice(session.processedMessageCount);

      if (newMessages.length === 0) {
        return;
      }

      let sawAgentResponse = false;
      let sawUserMessage = false;

      for (const msg of newMessages) {
        const content = extractText(msg.content);
        if (!content) continue;

        const uuid = stableUuid(msg.id);
        const event: GeminiSessionEvent = {
          type: msg.type === 'user' ? 'USER_MESSAGE' : 'AGENT_RESPONSE',
          sessionId: session.sessionId,
          uuid,
          content,
          timestamp: msg.timestamp,
        };

        console.log(`[GeminiWatcher] Emitting ${event.type} for ${session.sessionId.slice(-8)}: "${content.slice(0, 60)}..."`);
        this.onEvent(event);

        if (msg.type !== 'user') {
          sawAgentResponse = true;
          session.lastMessage = content.slice(0, 200);
        } else {
          sawUserMessage = true;
        }

        session.messageCount++;
      }

      session.processedMessageCount = allMessages.length;

      if (sawAgentResponse && !sawUserMessage) {
        this.startCompletionTimer(session);
      }
    } catch (err) {
      console.error(`[GeminiWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }

  private readMessages(filePath: string): GeminiMessage[] {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: GeminiSession = JSON.parse(raw);
      return data.messages || [];
    } catch {
      return [];
    }
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

function extractText(content: string | Array<{ text?: string }>): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(b => b.text || '').join(' ').trim();
  }
  return '';
}

/**
 * Generate a stable UUID from a Gemini message ID.
 * Must match the same logic in session-discovery.ts so UUIDs are consistent.
 */
function stableUuid(messageId: string): string {
  const hash = crypto.createHash('sha256').update(messageId).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
