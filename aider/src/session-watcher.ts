/**
 * Aider Session Watcher
 *
 * Polls .aider.chat.history.md files for new messages and emits events.
 * Used with the SDK's onWatchSession / onUnwatchSession hooks.
 */

import * as fs from 'fs';
import { parseHistoryFile, stableUuid } from './session-discovery';

const POLL_INTERVAL_MS = 500;
const COMPLETION_DELAY_MS = 1500;

export interface AiderSessionEvent {
  type: 'USER_MESSAGE' | 'AGENT_RESPONSE';
  sessionId: string;
  uuid: string;
  content: string;
}

export interface AiderCompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

type EventCallback = (event: AiderSessionEvent) => void;
type CompletionCallback = (event: AiderCompletionEvent) => void;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  startTime: string;
  lastSize: number;
  processedCount: number;
  messageCount: number;
  lastAgentMessage: string;
}

export class AiderSessionWatcher {
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
      console.warn(`[AiderWatcher] File not found: ${filePath}`);
      return;
    }

    // Find the start time for this session ID by scanning the file
    const startTime = this.findStartTime(sessionId, filePath);
    if (!startTime) {
      console.warn(`[AiderWatcher] Could not find session ${sessionId} in ${filePath}`);
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const allSessions = parseHistoryFile(filePath);
      const session = allSessions.find(s => stableUuid(`aider:${filePath}:${s.startTime}`) === sessionId);
      const existingCount = session?.messages.length ?? 0;
      const lastAgent = session?.messages.slice().reverse().find(m => m.role === 'agent');

      this.watchedSessions.set(sessionId, {
        sessionId,
        filePath,
        startTime,
        lastSize: stat.size,
        processedCount: existingCount,
        messageCount: existingCount,
        lastAgentMessage: lastAgent?.content.slice(0, 200) || '',
      });

      console.log(`[AiderWatcher] Watching session ${sessionId} (${existingCount} existing messages)`);

      if (!this.pollTimer) this.startPolling();
    } catch (err) {
      console.error(`[AiderWatcher] Failed to watch ${filePath}:`, err);
    }
  }

  unwatchSession(sessionId: string): void {
    this.cancelCompletionTimer(sessionId);
    if (this.watchedSessions.delete(sessionId)) {
      console.log(`[AiderWatcher] Stopped watching session ${sessionId}`);
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

  private scheduleCompletion(session: WatchedSession): void {
    this.cancelCompletionTimer(session.sessionId);
    if (!this.onCompletion) return;
    const timer = setTimeout(() => {
      this.completionTimers.delete(session.sessionId);
      this.onCompletion?.({
        sessionId: session.sessionId,
        filePath: session.filePath,
        lastMessage: session.lastAgentMessage,
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

  private findStartTime(sessionId: string, filePath: string): string | null {
    try {
      const sessions = parseHistoryFile(filePath);
      for (const s of sessions) {
        if (stableUuid(`aider:${filePath}:${s.startTime}`) === sessionId) {
          return s.startTime;
        }
      }
    } catch { /* ignore */ }
    return null;
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

      const allSessions = parseHistoryFile(session.filePath);
      const found = allSessions.find(s => s.startTime === session.startTime);
      if (!found) return;

      const newMessages = found.messages.slice(session.processedCount);
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
          session.lastAgentMessage = msg.content.slice(0, 200);
        } else if (msg.role === 'user') {
          sawUser = true;
        }
        session.messageCount++;
      }

      session.processedCount = found.messages.length;
      if (sawAgent && !sawUser) this.scheduleCompletion(session);
    } catch (err) {
      console.error(`[AiderWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }
}
