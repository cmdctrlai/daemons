/**
 * Session watcher for monitoring Cursor session activity
 *
 * Simple polling-based watcher that checks the SQLite database at regular intervals.
 * More reliable than fs.watch across different file systems.
 */

import { CURSOR_GLOBAL_STORAGE } from './config/config';
import { getCursorDB } from './adapter/cursor-db';

export interface SessionActivityEvent {
  session_id: string;
  file_path: string;
  last_message: string;
  message_count: number;
  is_completion: boolean;
  user_message_uuid?: string;  // UUID/ID of the triggering user message (for positioning verbose output)
}

export type SessionActivityCallback = (event: SessionActivityEvent) => void;

interface WatchedSession {
  sessionId: string;
  lastMessageCount: number;
  lastNotifyTime?: number;
  pendingAgentBubbleId?: string;  // Track empty AGENT bubble waiting for content
}

// Polling interval for checking SQLite database
const POLL_INTERVAL_MS = 500;

// Minimum time between notifications for the same session (5 seconds)
const NOTIFY_COOLDOWN_MS = 5000;

/**
 * Watch Cursor's SQLite database for changes using polling.
 * More reliable than fs.watch on macOS.
 */
export class SessionWatcher {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private callback: SessionActivityCallback | null = null;

  /**
   * Start watching the database (starts the polling loop when first session is added)
   */
  start(callback: SessionActivityCallback): void {
    this.callback = callback;
    console.log('[SessionWatcher] Started watching database');
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.watchedSessions.clear();
    this.callback = null;
    console.log('[SessionWatcher] Stopped watching');
  }

  /**
   * Add a session to watch for changes
   */
  watchSession(sessionId: string): void {
    if (this.watchedSessions.has(sessionId)) {
      console.log(`[SessionWatcher] Already watching session ${sessionId}`);
      return;
    }

    const cursorDb = getCursorDB();
    const count = cursorDb.getBubbleCount(sessionId);

    this.watchedSessions.set(sessionId, {
      sessionId,
      lastMessageCount: count,
    });

    console.log(`[SessionWatcher] Now watching session ${sessionId} (${count} messages)`);

    // Start polling if not already running
    if (!this.pollTimer) {
      this.startPolling();
    }
  }

  /**
   * Remove a session from watch list
   */
  unwatchSession(sessionId: string): void {
    if (this.watchedSessions.delete(sessionId)) {
      console.log(`[SessionWatcher] Stopped watching session ${sessionId}`);
    }

    // Stop polling if no sessions left
    if (this.watchedSessions.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Get list of watched session IDs
   */
  getWatchedSessions(): string[] {
    return Array.from(this.watchedSessions.keys());
  }

  /**
   * Start the polling loop
   */
  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollAllSessions();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Poll all watched sessions for changes
   */
  private pollAllSessions(): void {
    if (!this.callback || this.watchedSessions.size === 0) return;

    const cursorDb = getCursorDB();

    for (const [sessionId, session] of this.watchedSessions) {
      this.checkSession(cursorDb, session);
    }
  }

  /**
   * Check a single session for changes
   */
  private checkSession(cursorDb: ReturnType<typeof getCursorDB>, session: WatchedSession): void {
    const currentCount = cursorDb.getBubbleCount(session.sessionId);

    // Check if we're waiting for content on a pending AGENT bubble
    if (session.pendingAgentBubbleId) {
      const latestBubble = cursorDb.getLatestBubble(session.sessionId);
      if (latestBubble && latestBubble.bubbleId === session.pendingAgentBubbleId) {
        const hasContent = !!latestBubble.text?.trim();
        if (hasContent) {
          // Content arrived! Send completion notification
          let userMessageUuid: string | undefined;
          const bubbles = cursorDb.getBubbles(session.sessionId);
          for (let i = bubbles.length - 1; i >= 0; i--) {
            if (bubbles[i].type === 1) {
              userMessageUuid = bubbles[i].bubbleId;
              break;
            }
          }

          const event: SessionActivityEvent = {
            session_id: session.sessionId,
            file_path: CURSOR_GLOBAL_STORAGE,
            last_message: latestBubble.text?.substring(0, 100) || '',
            message_count: currentCount,
            is_completion: true,
            user_message_uuid: userMessageUuid,
          };

          console.log(`[SessionWatcher] Pending AGENT bubble now has content: ${session.sessionId} (bubble: ${latestBubble.bubbleId.substring(0, 8)})`);
          session.lastNotifyTime = Date.now();
          session.pendingAgentBubbleId = undefined;
          this.callback!(event);
          return;
        }
      } else {
        // Different bubble or bubble gone - clear pending
        session.pendingAgentBubbleId = undefined;
      }
    }

    // Only notify if there are new messages
    if (currentCount > session.lastMessageCount) {
      // Get latest bubble for details
      const latestBubble = cursorDb.getLatestBubble(session.sessionId);
      if (!latestBubble) {
        session.lastMessageCount = currentCount;
        return;
      }

      // Determine if this is a completion (assistant message with non-empty content)
      // For Cursor: type 1 = user, type 2 = assistant
      // Cursor creates empty assistant bubbles first, then fills them in
      const hasContent = !!latestBubble.text?.trim();
      const isCompletion = latestBubble.type === 2 && hasContent;
      const isUserMessage = latestBubble.type === 1;

      // If empty AGENT bubble, track it for later but still update count
      if (latestBubble.type === 2 && !hasContent) {
        console.log(`[SessionWatcher] Empty AGENT bubble detected, tracking for content: ${session.sessionId} (bubble: ${latestBubble.bubbleId.substring(0, 8)})`);
        session.pendingAgentBubbleId = latestBubble.bubbleId;
        session.lastMessageCount = currentCount;
        return;
      }

      const now = Date.now();
      const timeSinceLastNotify = session.lastNotifyTime ? now - session.lastNotifyTime : Infinity;

      // Always notify for completions (assistant responses), cooldown only for user messages
      if (isCompletion || (isUserMessage && timeSinceLastNotify >= NOTIFY_COOLDOWN_MS)) {
        // Find the last USER message's bubble ID for positioning verbose output
        let userMessageUuid: string | undefined;
        const bubbles = cursorDb.getBubbles(session.sessionId);
        for (let i = bubbles.length - 1; i >= 0; i--) {
          if (bubbles[i].type === 1) { // type 1 = user
            userMessageUuid = bubbles[i].bubbleId;
            break;
          }
        }

        const event: SessionActivityEvent = {
          session_id: session.sessionId,
          file_path: CURSOR_GLOBAL_STORAGE,
          last_message: latestBubble.text?.substring(0, 100) || '',
          message_count: currentCount,
          is_completion: isCompletion,
          user_message_uuid: userMessageUuid,
        };

        console.log(`[SessionWatcher] Sending activity for session ${session.sessionId} (completion: ${isCompletion}, userUuid: ${userMessageUuid}, msg: "${event.last_message.substring(0, 30)}...")`);
        session.lastNotifyTime = now;
        this.callback!(event);
      }

      session.lastMessageCount = currentCount;
    }
  }

  /**
   * Force a check of all watched sessions (clears cooldowns)
   */
  forceCheck(): void {
    for (const session of this.watchedSessions.values()) {
      session.lastNotifyTime = undefined;
    }
    this.pollAllSessions();
  }
}

// Singleton instance
let sessionWatcherInstance: SessionWatcher | null = null;

export function getSessionWatcher(): SessionWatcher {
  if (!sessionWatcherInstance) {
    sessionWatcherInstance = new SessionWatcher();
  }
  return sessionWatcherInstance;
}
