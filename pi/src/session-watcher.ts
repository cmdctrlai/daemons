/**
 * File-polling watcher for pi session JSONL files.
 *
 * On each poll tick, re-opens the session via `SessionManager.open(path)` and
 * emits callbacks for entries that landed since the last read. The watcher
 * never parses JSONL itself – pi's SessionManager is the parser.
 */

import * as fs from 'fs';
import type {
  SessionEntry,
  SessionMessageEntry,
} from '@mariozechner/pi-coding-agent';
import { piSdk } from './pi-sdk';

export interface AgentResponseEvent {
  sessionId: string;
  uuid: string;
  content: string;
  timestamp: string;
}

export interface VerboseEvent {
  sessionId: string;
  uuid: string;
  /** "tool_call" | "thinking" | "tool_result" */
  kind: string;
  /** Human-readable summary for the verbose log. */
  summary: string;
  timestamp: string;
}

export interface CompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

export interface WatcherCallbacks {
  onAgentResponse: (ev: AgentResponseEvent) => void;
  onVerbose?: (ev: VerboseEvent) => void;
  onCompletion?: (ev: CompletionEvent) => void;
}

interface Watched {
  sessionId: string;
  filePath: string;
  seen: Set<string>;
  lastSize: number;
  lastMessage: string;
  messageCount: number;
  primed: boolean;
}

const POLL_INTERVAL_MS = 500;

export class SessionWatcher {
  private watched: Map<string, Watched> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(private cb: WatcherCallbacks) {}

  watchSession(sessionId: string, filePath: string): void {
    if (this.watched.has(sessionId)) return;
    if (!fs.existsSync(filePath)) {
      // Session file may not exist yet for a brand-new task – still track it,
      // the poller will pick it up on first append.
    }
    this.watched.set(sessionId, {
      sessionId,
      filePath,
      seen: new Set(),
      lastSize: 0,
      lastMessage: '',
      messageCount: 0,
      primed: false,
    });
    if (!this.timer) this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  unwatchSession(sessionId: string): void {
    this.watched.delete(sessionId);
    if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watched.clear();
  }

  private async tick(): Promise<void> {
    const { SessionManager } = await piSdk();
    for (const w of this.watched.values()) {
      this.pollOne(w, SessionManager);
    }
  }

  private pollOne(w: Watched, SessionManager: typeof import('@mariozechner/pi-coding-agent').SessionManager): void {
    let size: number;
    try {
      size = fs.statSync(w.filePath).size;
    } catch {
      return; // file not there yet
    }
    if (size === w.lastSize && w.primed) return;
    w.lastSize = size;

    let entries: SessionEntry[];
    try {
      const mgr = SessionManager.open(w.filePath);
      entries = mgr.getEntries();
    } catch (err) {
      // Transient parse error during pi's append – try again next tick.
      return;
    }

    // On first read, seed "seen" without firing events (retrospective reads
    // are served by get_messages, not by replaying the whole history here).
    if (!w.primed) {
      for (const e of entries) w.seen.add(e.id);
      w.messageCount = entries.filter(isMessage).length;
      w.lastMessage = extractLastMessageText(entries);
      w.primed = true;
      return;
    }

    let sawAssistantText = false;
    let lastUserMessageUuid: string | undefined;
    for (const entry of entries) {
      if (w.seen.has(entry.id)) continue;
      w.seen.add(entry.id);

      if (!isMessage(entry)) continue;
      w.messageCount++;
      const msg: any = (entry as SessionMessageEntry).message;

      if (msg?.role === 'assistant') {
        const text = extractText(msg.content);
        if (text.trim()) {
          sawAssistantText = true;
          w.lastMessage = text;
          this.cb.onAgentResponse({
            sessionId: w.sessionId,
            uuid: entry.id,
            content: text,
            timestamp: entry.timestamp,
          });
        } else if (this.cb.onVerbose) {
          const tool = firstToolCallName(msg.content);
          if (tool) {
            this.cb.onVerbose({
              sessionId: w.sessionId,
              uuid: entry.id,
              kind: 'tool_call',
              summary: tool,
              timestamp: entry.timestamp,
            });
          }
        }
      } else if (msg?.role === 'user') {
        lastUserMessageUuid = entry.id;
        const text = extractText(msg.content);
        if (text.trim()) w.lastMessage = text;
      }
    }

    // Fire completion after any batch that ended with visible assistant text –
    // roughly "a turn completed". Good enough to trigger mobile push + activity.
    if (sawAssistantText && this.cb.onCompletion) {
      this.cb.onCompletion({
        sessionId: w.sessionId,
        filePath: w.filePath,
        lastMessage: w.lastMessage,
        messageCount: w.messageCount,
      });
    }
    void lastUserMessageUuid; // currently unused; reserved for user_message_uuid wiring
  }
}

function isMessage(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message';
}

function extractText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

function firstToolCallName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content as any[]) {
    if (block?.type === 'toolCall' && typeof block.name === 'string') {
      return block.name;
    }
  }
  return undefined;
}

function extractLastMessageText(entries: SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!isMessage(e)) continue;
    const msg: any = (e as SessionMessageEntry).message;
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;
    const text = extractText(msg.content);
    if (text.trim()) return text;
  }
  return '';
}
