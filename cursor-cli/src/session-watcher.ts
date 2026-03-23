/**
 * Cursor CLI Session Watcher
 *
 * Polls cursor-agent JSONL transcript files for new messages and emits events.
 * Used with the SDK's onWatchSession / onUnwatchSession hooks.
 */

import * as fs from 'fs';
import { parseTranscriptFile, stableUuid } from './session-discovery';

const POLL_INTERVAL_MS = 500;
const COMPLETION_DELAY_MS = 5000;

export interface CursorSessionEvent {
  type: 'USER_MESSAGE' | 'AGENT_RESPONSE';
  sessionId: string;
  uuid: string;
  content: string;
}

export interface CursorCompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

type EventCallback = (event: CursorSessionEvent) => void;
type CompletionCallback = (event: CursorCompletionEvent) => void;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  lastSize: number;
  processedCount: number;
  messageCount: number;
  lastMessage: string;
}

export class CursorSessionWatcher {
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
    if (this.watchedSessions.has(sessionId)) return;

    if (!fs.existsSync(filePath)) {
      console.warn(`[CursorWatcher] File not found: ${filePath}`);
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const messages = parseTranscriptFile(filePath);
      const lastAgent = [...messages].reverse().find(m => m.role === 'agent');

      this.watchedSessions.set(sessionId, {
        sessionId,
        filePath,
        lastSize: stat.size,
        processedCount: messages.length,
        messageCount: messages.length,
        lastMessage: lastAgent?.content.slice(0, 200) || '',
      });

      console.log(`[CursorWatcher] Started watching session ${sessionId} (${messages.length} existing messages)`);

      if (!this.pollTimer) this.startPolling();
    } catch (err) {
      console.error(`[CursorWatcher] Failed to watch ${filePath}:`, err);
    }
  }

  unwatchSession(sessionId: string): void {
    this.cancelCompletionTimer(sessionId);
    if (this.watchedSessions.delete(sessionId)) {
      console.log(`[CursorWatcher] Stopped watching session ${sessionId}`);
    }
    if (this.watchedSessions.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  unwatchAll(): void {
    for (const timer of this.completionTimers.values()) clearTimeout(timer);
    this.completionTimers.clear();
    this.watchedSessions.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
        this.unwatchSession(session.sessionId);
        return;
      }

      const stat = fs.statSync(session.filePath);
      if (stat.size === session.lastSize) return;

      session.lastSize = stat.size;

      const allMessages = parseTranscriptFile(session.filePath);
      const newMessages = allMessages.slice(session.processedCount);
      if (newMessages.length === 0) return;

      let sawAgent = false;
      let sawUser = false;

      for (const msg of newMessages) {
        const uuid = stableUuid(session.sessionId + ':' + msg.id);
        this.onEvent({
          type: msg.role === 'user' ? 'USER_MESSAGE' : 'AGENT_RESPONSE',
          sessionId: session.sessionId,
          uuid,
          content: msg.content,
        });

        if (msg.role === 'agent') {
          sawAgent = true;
          session.lastMessage = msg.content.slice(0, 200);
        } else if (msg.role === 'user') {
          sawUser = true;
        }

        session.messageCount++;
      }

      session.processedCount = allMessages.length;

      if (sawAgent && !sawUser) this.startCompletionTimer(session);
    } catch (err) {
      console.error(`[CursorWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }

  private startCompletionTimer(session: WatchedSession): void {
    this.cancelCompletionTimer(session.sessionId);
    if (!this.onCompletion) return;

    const timer = setTimeout(() => {
      this.completionTimers.delete(session.sessionId);
      this.onCompletion?.({
        sessionId: session.sessionId,
        filePath: session.filePath,
        lastMessage: session.lastMessage,
        messageCount: session.messageCount,
      });
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
