/**
 * File-polling watcher for pi and omp session JSONL files.
 *
 * On each poll tick, re-reads the session through the active session source and
 * emits callbacks for entries that landed since the last read. The watcher never
 * parses JSONL itself – see `session-source.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sessionSource, type StoredEntry } from './session-source';
import type { CommandCollapser } from './command-collapse';

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
  /**
   * When the session can move between files (omp continuations): the directory
   * listing and the sizes of the other copies at the last `locate`. Any change
   * to either is what can move the session, so only then is it located again.
   */
  moves?: { names: string; sizes: Map<string, number> };
}

const POLL_INTERVAL_MS = 500;

export class SessionWatcher {
  private watched: Map<string, Watched> = new Map();
  private timer: NodeJS.Timeout | null = null;
  /** Reads are async; a slow tick must not overlap the next one. */
  private ticking = false;

  /**
   * `collapser` keeps an expanded command out of the activity preview, which is
   * drawn from the same user text the transcript shows.
   */
  constructor(private cb: WatcherCallbacks, private collapser?: CommandCollapser) {}

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
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const w of [...this.watched.values()]) {
        await this.pollOne(w);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Keep `w` on the file its session reads from. omp moves a session's next turn
   * to a continuation file when another omp process holds the original open, and
   * can move it back once the original goes on; history and the listing follow
   * that, so the watcher must too. `seen` carries over: copies share entry ids,
   * so only the turns new to this session fire.
   */
  private async follow(w: Watched): Promise<void> {
    const locate = sessionSource().locate;
    if (!locate) return;
    let names: string;
    try {
      names = fs.readdirSync(path.dirname(w.filePath)).filter(f => f.endsWith('.jsonl')).sort().join('\n');
    } catch {
      return;
    }
    const last = w.moves;
    if (last && last.names === names && [...last.sizes].every(([p, size]) => sizeOf(p) === size)) return;

    const found = await locate(w.sessionId, w.filePath).catch(() => undefined);
    if (found && found.path !== w.filePath) {
      w.filePath = found.path;
      w.lastSize = -1; // read the new file even if it happens to be the old one's size
    }
    // Sizes as locate read them: a copy written to since then reads as changed next tick.
    const others = (found?.copies ?? []).filter(c => c.path !== w.filePath);
    w.moves = { names, sizes: new Map(others.map(c => [c.path, c.size])) };
  }

  private async pollOne(w: Watched): Promise<void> {
    await this.follow(w);
    if (this.watched.get(w.sessionId) !== w) return;

    let size: number;
    try {
      size = fs.statSync(w.filePath).size;
    } catch {
      return; // file not there yet
    }
    if (size === w.lastSize && w.primed) return;
    w.lastSize = size;

    let entries: StoredEntry[];
    try {
      entries = await sessionSource().entries(w.filePath);
    } catch (err) {
      // Transient parse error during the agent's append – try again next tick.
      return;
    }
    // Unwatched while the read was in flight.
    if (this.watched.get(w.sessionId) !== w) return;

    // On first read, seed "seen" without firing events (retrospective reads
    // are served by get_messages, not by replaying the whole history here).
    if (!w.primed) {
      for (const e of entries) w.seen.add(e.id);
      w.messageCount = entries.filter(isMessage).length;
      w.lastMessage = extractLastMessageText(entries, this.collapser);
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
      const msg: any = entry.message;

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
        if (text.trim()) w.lastMessage = this.collapser?.collapse(text) || text;
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

/** -1 for a file that is not there, so its appearance reads as a change. */
function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function isMessage(entry: StoredEntry): boolean {
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

function extractLastMessageText(entries: StoredEntry[], collapser?: CommandCollapser): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!isMessage(e)) continue;
    const msg: any = e.message;
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;
    const text = extractText(msg.content);
    if (!text.trim()) continue;
    return (msg.role === 'user' && collapser?.collapse(text)) || text;
  }
  return '';
}
