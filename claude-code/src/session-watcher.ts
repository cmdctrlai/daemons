/**
 * Session file watcher for monitoring JSONL session files
 *
 * Watches JSONL files and emits typed events for each new entry:
 * - AGENT_RESPONSE: assistant entries with text content
 * - VERBOSE: tool_use, thinking, tool_result entries
 * - USER_MESSAGE: user entries (for passive observers)
 *
 * This is the single source of truth for session content events.
 */

import * as fs from 'fs';
import {
  isHarnessEntry,
  isHarnessText,
  isHumanEntry,
  isMessageEntry,
  slashCommandText,
  queuedHumanMessage,
  PromptOpenings,
  unwrapPastedContent,
} from './transcript-filter';
import { formatToolUse, normalizeToolUse } from './tool-format';
import { Turn, TurnEnd, TurnLedger } from './turn-ledger';

// Event types emitted by SessionWatcher
export interface SessionEvent {
  type: 'AGENT_RESPONSE' | 'VERBOSE' | 'USER_MESSAGE';
  sessionId: string;
  uuid: string;
  content: string;
  timestamp: string;
  // For USER_MESSAGE events
  isToolResult?: boolean;
  // Normalized tool descriptor for VERBOSE tool-use events. `tool` is the raw
  // tool name and `argSummary` its key argument (command, pattern, path, …) with
  // no emoji, so the server can narrate the action for voice mode.
  tool?: string;
  argSummary?: string;
}

interface WatchedSession {
  sessionId: string;
  filePath: string;
  // Bytes read so far, always the end of a complete line.
  lastSize: number;
  processedUuids: Set<string>;
  // UUIDs of user entries that contained tool_result blocks.
  // Assistant entries whose parentUuid is in this set are internal
  // continuation responses (e.g. "No response requested.") and
  // should not be emitted as AGENT_RESPONSE events.
  toolResultUuids: Set<string>;
  promptOpenings: PromptOpenings;
  lastLineCount: number;
  // User and assistant entries in the file, the count every report of this session uses.
  messageCount: number;
  lastMessage: string;
  // Every turn in the file, who announces it and whether it has been.
  turns: TurnLedger;
  // Adapter results not yet matched to a turn, because the file has not been read that far.
  pendingAnnouncements: number;
  // What was read, to tell an append from a rewrite.
  read: ReadMark;
  // False until what was already in the file has been read; each poll retries until then.
  started: boolean;
  // When watching began. At start, entries stamped after it are new; the rest are history.
  watchStartedAt: number;
}

interface ReadMark {
  ino: number;
  mtimeMs: number;
  head: Buffer;
  seal: Buffer;
}

type EventCallback = (event: SessionEvent) => void;

// Completion event includes session metadata for push notifications
export interface CompletionEvent {
  sessionId: string;
  filePath: string;
  lastMessage: string;
  messageCount: number;
}

type CompletionCallback = (event: CompletionEvent) => void;

/** Whether this daemon's adapter had a query alive on the session at that moment. */
type AdapterQueryLookup = (sessionId: string, atMs: number) => boolean;

// Polling interval (500ms)
const POLL_INTERVAL_MS = 500;

// Agent no-op responses – boilerplate text Claude emits when it has nothing
// meaningful to say. The CLI internally maintains a set of these (variable WB6
// in the leaked source). We match all known variants.
const NO_OP_RESPONSES = new Set([
  'No response requested.',
  'No response needed.',
  'No response.',
  'No response received',
  'No response from model',
]);

// Bytes compared at the start of the file and just before lastSize. Comparing everything
// read would mean re-reading the whole transcript every poll.
const REWRITE_CHECK_BYTES = 4096;

function readRange(fd: number, start: number, end: number): Buffer {
  const bytes = Buffer.alloc(Math.max(0, end - start));
  const n = fs.readSync(fd, bytes, 0, bytes.length, start);
  return bytes.subarray(0, n);
}

function readMark(fd: number, stats: fs.Stats, readTo: number): ReadMark {
  return {
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    head: readRange(fd, 0, Math.min(readTo, REWRITE_CHECK_BYTES)),
    seal: readRange(fd, Math.max(0, readTo - REWRITE_CHECK_BYTES), readTo),
  };
}

// Read size for walking a transcript line by line; no line is decoded with its neighbours.
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Hands each complete line in [start, end) to `onLine` with the offset just past it, and
 * returns the offset past the last one. A line still being written is left for the next
 * read. A line too long to decode is skipped; it could never be read. With `throwIfShort`, a
 * file that ends before `end` (truncated while read) throws instead of reading short.
 */
function eachLine(fd: number, start: number, end: number, onLine: (line: string, next: number) => void, throwIfShort = false): number {
  let done = start;
  let parts: Buffer[] = [];
  for (let pos = start; pos < end;) {
    const chunk = readRange(fd, pos, Math.min(end, pos + READ_CHUNK_BYTES));
    if (chunk.length === 0) {
      if (throwIfShort) throw new Error(`File ended at ${pos} of ${end} bytes while it was read`);
      break;
    }
    let from = 0;
    for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, from)) {
      parts.push(chunk.subarray(from, newline));
      const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      from = newline + 1;
      done = pos + from;
      let line: string;
      try {
        line = bytes.toString('utf-8');
      } catch (err) {
        console.error(`[SessionWatcher] Skipping a ${bytes.length}-byte line:`, err);
        continue;
      }
      onLine(line, done);
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
    pos += chunk.length;
  }
  return done;
}

/**
 * True when the file was replaced, shrank, was written without growing, or changed in its
 * first or last 4KB read. An in-place edit between those followed by an append goes unseen.
 */
function wasRewritten(fd: number, stats: fs.Stats, readTo: number, mark: ReadMark): boolean {
  if (stats.ino !== mark.ino || stats.size < readTo) return true;
  // Written to without growing past what was read.
  if (stats.size === readTo && stats.mtimeMs !== mark.mtimeMs) return true;
  return !readRange(fd, 0, mark.head.length).equals(mark.head) ||
    !readRange(fd, readTo - mark.seal.length, readTo).equals(mark.seal);
}

/**
 * Every completed turn is announced exactly once, by this watcher. A turn the adapter
 * prompted is announced when the adapter's `result` arrives (announceTurn), whether or
 * not the transcript ever shows an end marker; every other turn, from the terminal or
 * from another SDK host, is announced off its end marker in the transcript.
 */
export class SessionWatcher {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private onEvent: EventCallback;
  private onCompletion: CompletionCallback | null = null;
  private adapterHadQuery: AdapterQueryLookup;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(onEvent: EventCallback, onCompletion?: CompletionCallback, adapterHadQuery: AdapterQueryLookup = () => false) {
    this.onEvent = onEvent;
    this.onCompletion = onCompletion || null;
    this.adapterHadQuery = adapterHadQuery;
  }

  /**
   * Start watching a session file for changes
   */
  watchSession(sessionId: string, filePath: string): void {
    if (this.watchedSessions.has(sessionId)) {
      console.log(`[SessionWatcher] Already watching session ${sessionId}`);
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.warn(`[SessionWatcher] File not found: ${filePath}`);
      return;
    }

    this.watchedSessions.set(sessionId, {
      sessionId,
      filePath,
      lastSize: 0,
      processedUuids: new Set(),
      toolResultUuids: new Set(),
      promptOpenings: new PromptOpenings(),
      lastLineCount: 0,
      messageCount: 0,
      lastMessage: '',
      turns: new TurnLedger((atMs) => this.adapterHadQuery(sessionId, atMs)),
      pendingAnnouncements: 0,
      read: { ino: 0, mtimeMs: 0, head: Buffer.alloc(0), seal: Buffer.alloc(0) },
      started: false,
      watchStartedAt: Date.now(),
    });
    this.startSession(this.watchedSessions.get(sessionId)!);

    // Start polling if not already running
    if (!this.pollTimer && this.watchedSessions.size > 0) {
      this.startPolling();
    }
  }

  /**
   * Announces the turn the adapter just got a result for. Reads what the file holds now,
   * so the announcement carries the turn's last message, and announces the newest
   * adapter-owned turn still unannounced; a result for a turn the file does not show yet
   * waits for it. False when the session is not watched.
   */
  announceTurn(sessionId: string): boolean {
    const session = this.watchedSessions.get(sessionId);
    if (!session) return false;
    session.pendingAnnouncements++;
    this.checkSession(session);
    this.announcePending(session);
    return true;
  }

  private announcePending(session: WatchedSession): void {
    if (!session.started) return;
    for (let turn = session.turns.unannouncedAdapterTurn(); session.pendingAnnouncements > 0 && turn; turn = session.turns.unannouncedAdapterTurn()) {
      session.pendingAnnouncements--;
      this.fireCompletion(session, turn, 'adapter result');
    }
    if (session.pendingAnnouncements > 0) {
      console.log(`[SessionWatcher] Session ${session.sessionId.slice(-8)} has ${session.pendingAnnouncements} adapter result(s) waiting for its transcript`);
    }
  }

  /**
   * Takes what the file held before watching began as handled and handles what came after.
   * On any failure the session stays unstarted and the next poll starts it again from scratch.
   */
  private startSession(session: WatchedSession): void {
    let late: Array<Record<string, unknown>>;
    try {
      const init = this.initializeFromFile(session, session.watchStartedAt);
      const { size, read, processedUuids, toolResultUuids, promptOpenings, lineCount, messageCount, lastMessage, turns } = init;
      late = init.late;
      Object.assign(session, {
        turns,
        lastSize: size,
        processedUuids,
        toolResultUuids,
        promptOpenings,
        lastLineCount: lineCount,
        messageCount,
        lastMessage,
        read,
        started: true,
      });
      console.log(`[SessionWatcher] Started watching session ${session.sessionId} (${processedUuids.size} entries, ${messageCount} messages)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[SessionWatcher] File no longer exists: ${session.filePath}`);
        this.unwatchSession(session.sessionId);
        return;
      }
      console.error(`[SessionWatcher] Failed to start watching ${session.filePath}, retrying next poll:`, err);
      return;
    }
    this.handleEntries(session, late);
    this.endBatch(session);
    this.announcePending(session);
  }

  /**
   * Stop watching a session file
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
   * Stop watching all sessions
   */
  unwatchAll(): void {
    this.watchedSessions.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[SessionWatcher] Stopped watching all sessions');
  }

  /**
   * Initialize processed UUIDs from existing file content
   * This prevents emitting events for entries that existed before we started watching.
   * Entries stamped after `since` are returned as `late`, for the caller to handle as new;
   * one without a parseable timestamp is history. A turn that ended in history was
   * announced before the watch, unless it is the adapter's and its result is still to come.
   */
  private initializeFromFile(session: WatchedSession, since: number): { size: number; read: ReadMark; processedUuids: Set<string>; toolResultUuids: Set<string>; promptOpenings: PromptOpenings; lineCount: number; messageCount: number; lastMessage: string; turns: TurnLedger; late: Array<Record<string, unknown>> } {
    const late: Array<Record<string, unknown>> = [];
    const processedUuids = new Set<string>();
    const toolResultUuids = new Set<string>();
    const promptOpenings = new PromptOpenings();
    const turns = new TurnLedger((atMs) => this.adapterHadQuery(session.sessionId, atMs));
    let messageCount = 0;
    let lastMessage = '';

    let lineCount = 0;
    const consider = (line: string) => {
      if (!line.trim()) return;
      lineCount++;
      try {
        const entry = JSON.parse(line);
        if (entry.uuid && Date.parse(entry.timestamp) > since) {
          late.push(entry);
          return;
        }
        promptOpenings.repeats(entry);
        if (entry.uuid) {
          processedUuids.add(entry.uuid);
          const queued = queuedHumanMessage(entry);
          if (queued) processedUuids.add(queued.uuid);
          if (isMessageEntry(entry)) messageCount++;
          const end = turns.observe(entry);
          if (end && end.turn.owner === 'watcher') end.turn.announced = true;

          // Track user entries whose content contains tool_result blocks.
          // Assistant entries with parentUuid pointing to one of these are
          // internal continuation responses and should be filtered out.
          if (entry.type === 'user') {
            const entryContent = (entry.message as Record<string, unknown> | undefined)?.content;
            if (Array.isArray(entryContent) && entryContent.some((b: Record<string, unknown>) => b.type === 'tool_result')) {
              toolResultUuids.add(entry.uuid);
            }
          }

          // Track last message content for session_activity
          const entryMessage = entry.message as Record<string, unknown> | undefined;
          const msgContent = entryMessage?.content;
          if (typeof msgContent === 'string') {
            lastMessage = msgContent.slice(0, 200);
          } else if (Array.isArray(msgContent)) {
            const textBlocks = msgContent.filter((b: Record<string, unknown>) => b.type === 'text');
            if (textBlocks.length > 0) {
              lastMessage = (textBlocks[0].text as string || '').slice(0, 200);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    };

    // One handle and one fstat, so the mark describes the file that was read.
    const fd = fs.openSync(session.filePath, 'r');
    try {
      const stats = fs.fstatSync(fd);
      const size = eachLine(fd, 0, stats.size, consider, true);
      // History is over: its watcher-owned turns ended, announced or not, before the watch.
      for (const end of turns.settle()) if (end.turn.owner === 'watcher') end.turn.announced = true;
      return { size, read: readMark(fd, stats, size), processedUuids, toolResultUuids, promptOpenings, lineCount, messageCount, lastMessage, turns, late };
    } finally {
      fs.closeSync(fd);
    }
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
    for (const [, session] of this.watchedSessions) {
      this.checkSession(session);
    }
  }

  /**
   * Check a single session for changes
   */
  private checkSession(session: WatchedSession): void {
    try {
      // Any failure to start, a stat included, is retried; startSession unwatches only a missing file.
      if (!session.started) {
        this.startSession(session);
        return;
      }

      if (!fs.existsSync(session.filePath)) {
        console.warn(`[SessionWatcher] File no longer exists: ${session.filePath}`);
        this.unwatchSession(session.sessionId);
        return;
      }

      const stats = fs.statSync(session.filePath);

      if (stats.size === session.lastSize && stats.mtimeMs === session.read.mtimeMs && stats.ino === session.read.ino) {
        this.endBatch(session);
        return;
      }

      this.handleEntries(session, this.readNewEntries(session));
      this.endBatch(session);
      this.announcePending(session);
    } catch (err) {
      console.error(`[SessionWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }

  /**
   * Emits what is new among `newEntries` and announces each turn that ends in them, at
   * the point it ends, unless the turn is the adapter's: that one is announced when its
   * result arrives, and its end marker only records it as ended.
   */
  private handleEntries(session: WatchedSession, newEntries: Array<Record<string, unknown>>): void {
    for (const entry of newEntries) {
      // One entry that cannot be handled is skipped; the rest of what was read still is.
      try {
        const entryType = entry.type as string;
        if (isMessageEntry(entry)) session.messageCount++;

        // Track user entries with tool_result content so we can filter the
        // assistant "No response requested." replies that follow them.
        if (entryType === 'user' && entry.uuid) {
          const entryContent = (entry.message as Record<string, unknown> | undefined)?.content;
          if (Array.isArray(entryContent) && entryContent.some((b: Record<string, unknown>) => b.type === 'tool_result')) {
            session.toolResultUuids.add(entry.uuid as string);
          }
        }

        const event = this.entryToEvent(session.sessionId, entry, session.toolResultUuids);
        // A queued message goes by its source_uuid and a slash command by its prompt, each
        // shown once like Claude Code shows it.
        const repeatsCommand = session.promptOpenings.repeats(entry);
        const alreadyShown = event !== null && (repeatsCommand || (event.uuid !== entry.uuid && session.processedUuids.has(event.uuid)));
        if (event && !alreadyShown) {
          console.log(`[SessionWatcher] Emitting ${event.type} for session ${session.sessionId.slice(-8)}: ${event.content.slice(0, 50)}...`);
          this.onEvent(event);

          // Only agent messages, for the push notification body.
          if (event.type === 'AGENT_RESPONSE') {
            session.lastMessage = event.content.slice(0, 200);
          }
        }
        if (entry.uuid) {
          session.processedUuids.add(entry.uuid as string);
        }
        if (event) {
          session.processedUuids.add(event.uuid);
        }

        // After the entry's own message is in lastMessage, so an announcement carries it.
        const end = session.turns.observe(entry);
        if (end) this.announceEnd(session, end);
      } catch (err) {
        console.error(`[SessionWatcher] Skipping entry ${entry.uuid} in session ${session.sessionId.slice(-8)}:`, err);
        if (entry.uuid) session.processedUuids.add(entry.uuid as string);
      }
    }
  }

  /** A poll is over: turns whose stop reason was seen with nothing following it have ended. */
  private endBatch(session: WatchedSession): void {
    for (const end of session.turns.endBatch()) this.announceEnd(session, end);
  }

  /** Announces a turn its transcript shows ending, if it is the watcher's to announce. */
  private announceEnd(session: WatchedSession, { turn, reason }: TurnEnd): void {
    if (turn.owner !== 'watcher' || turn.announced) return;
    // A turn with no assistant entry (an interrupt before any output, a local command) is
    // nothing to notify about.
    if (!turn.sawAssistant) return;
    this.fireCompletion(session, turn, reason);
  }

  /**
   * Entries not yet seen: those appended since lastSize, or on a rewrite, every entry in
   * the file whose uuid was never emitted.
   */
  private readNewEntries(session: WatchedSession): Array<Record<string, unknown>> {
    const newEntries: Array<Record<string, unknown>> = [];

    try {
      const fd = fs.openSync(session.filePath, 'r');
      try {
        const stats = fs.fstatSync(fd);
        if (wasRewritten(fd, stats, session.lastSize, session.read)) {
          console.log(`[SessionWatcher] Session ${session.sessionId.slice(-8)} was rewritten, re-reading it`);
          session.lastSize = 0;
        }
        // A line counts as read once it is in newEntries, so a failed read loses nothing.
        try {
          // A skipped line gets no onLine; the returned offset passes over it.
          session.lastSize = eachLine(fd, session.lastSize, stats.size, (line, next) => {
            try {
              const entry = line.trim() ? JSON.parse(line) : null;
              // Internal entries have no uuid; a seen one was already handled.
              if (entry?.uuid && !session.processedUuids.has(entry.uuid)) {
                newEntries.push(entry);
              }
            } catch {
              // Skip invalid JSON lines
            }
            session.lastSize = next;
          });
        } finally {
          session.read = readMark(fd, stats, session.lastSize);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.error(`[SessionWatcher] Error reading file:`, err);
    }

    return newEntries;
  }

  /**
   * Convert a JSONL entry to a SessionEvent
   */
  private entryToEvent(sessionId: string, entry: Record<string, unknown>, toolResultUuids?: Set<string>): SessionEvent | null {
    const entryType = entry.type as string;
    const uuid = entry.uuid as string;
    const timestamp = (entry.timestamp as string) || new Date().toISOString();
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Harness-generated entries are never conversation, whatever their type.
    if (isHarnessEntry(entry)) {
      return null;
    }

    // A message the person queued and the agent absorbed mid-turn
    if (entryType === 'attachment') {
      const queued = queuedHumanMessage(entry);
      return queued && { type: 'USER_MESSAGE', sessionId, uuid: queued.uuid, content: queued.text, timestamp };
    }

    // Handle user entries
    if (entryType === 'user') {
      // Entries with sourceToolAssistantUUID or toolUseResult are tool-result
      // wrappers, not real user messages. The JSONL stores tool results as
      // type:"user" entries (required by the Claude API format), but they should
      // be treated as internal machinery, not displayed as user chat bubbles.
      if (entry.sourceToolAssistantUUID || entry.toolUseResult) {
        // Still emit as VERBOSE if there's displayable content
        if (Array.isArray(content)) {
          const toolResultBlock = content.find(
            (block: Record<string, unknown>) => block.type === 'tool_result'
          ) as Record<string, unknown> | undefined;
          if (toolResultBlock) {
            const rawContent = toolResultBlock.content;
            const resultContent = typeof rawContent === 'string'
              ? rawContent
              : (Array.isArray(rawContent) ? JSON.stringify(rawContent) : String(rawContent || ''));
            if (resultContent.trim()) {
              return {
                type: 'VERBOSE',
                sessionId,
                uuid,
                content: resultContent.length > 200 ? resultContent.slice(0, 200) + '...' : resultContent,
                timestamp,
                isToolResult: true,
              };
            }
          }
        }
        return null;
      }

      // Check if this is a tool_result (internal, but we emit as VERBOSE)
      // Fallback for entries without sourceToolAssistantUUID marker
      if (Array.isArray(content)) {
        const hasToolResult = content.some(
          (block: Record<string, unknown>) => block.type === 'tool_result'
        );
        if (hasToolResult) {
          // Extract tool result content
          const toolResultBlock = content.find(
            (block: Record<string, unknown>) => block.type === 'tool_result'
          ) as Record<string, unknown>;

          // Content can be a string, array (for images), or other types
          const rawContent = toolResultBlock?.content;
          const resultContent = typeof rawContent === 'string'
            ? rawContent
            : (Array.isArray(rawContent) ? JSON.stringify(rawContent) : String(rawContent || ''));

          // Skip empty tool results - no value in showing "(empty output)"
          if (!resultContent.trim()) {
            return null;
          }

          return {
            type: 'VERBOSE',
            sessionId,
            uuid,
            content: resultContent.length > 200 ? resultContent.slice(0, 200) + '...' : resultContent,
            timestamp,
            isToolResult: true,
          };
        }
      }

      // Regular user message
      const textContent = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block: Record<string, unknown>) => block.type === 'text')
              .map((block: Record<string, unknown>) => block.text)
              .join('\n')
          : '';

      if (!textContent) {
        return null;
      }

      // Filter the raw text: the paste wrapper is what marks its payload as the user's,
      // so it has to still be there when isHarnessText decides.
      // Fallback for entries carrying no harness flag and no human origin: structured
      // data, XML-like wrappers and known harness preambles.
      const command = slashCommandText(textContent);
      if (!command && isHarnessText(textContent, isHumanEntry(entry))) {
        return null;
      }
      const userText = command ?? unwrapPastedContent(textContent);

      return {
        type: 'USER_MESSAGE',
        sessionId,
        uuid,
        content: userText,
        timestamp,
      };
    }

    // Handle assistant entries
    if (entryType === 'assistant') {
      if (!Array.isArray(content)) {
        console.log(`[SessionWatcher] Assistant entry ${uuid?.slice(-8)} has non-array content:`, typeof content);
        return null;
      }

      // Log what block types are present for debugging
      const blockTypes = content.map((b: Record<string, unknown>) => b.type);
      console.log(`[SessionWatcher] Assistant entry ${uuid?.slice(-8)} has blocks:`, blockTypes);

      // Check for text content (AGENT_RESPONSE)
      const textBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === 'text'
      );
      if (textBlocks.length > 0) {
        const textContent = textBlocks
          .map((block: Record<string, unknown>) => block.text as string)
          .join('\n')
          .trim();

        // Skip very short responses that are likely cursor indicators (e.g., "\", "|")
        // Also skip if content is ONLY whitespace or special characters
        const isLikelyCursor = textContent.length <= 2 && /^[\s\\|/_-]*$/.test(textContent);

        // Skip agent no-op responses – boilerplate text Claude emits when it has
        // nothing meaningful to say, typically after tool results. The CLI
        // internally maintains a set of these strings; we match all known variants.
        // Filter these unconditionally (they are never meaningful user-facing content)
        // AND also catch very short continuations after tool results as a fallback.
        const parentUuid = entry.parentUuid as string | undefined;
        const isToolResultContinuation = parentUuid && toolResultUuids?.has(parentUuid);
        const isNoiseResponse = NO_OP_RESPONSES.has(textContent) || (
          isToolResultContinuation && textContent.length <= 5
        );
        if (isNoiseResponse) {
          console.log(`[SessionWatcher] Skipping noise continuation for ${uuid?.slice(-8)}: "${textContent}"`);
          return null;
        }

        if (textContent && !isLikelyCursor) {
          console.log(`[SessionWatcher] Emitting AGENT_RESPONSE for ${uuid?.slice(-8)}: "${textContent.slice(0, 50)}..."`);
          return {
            type: 'AGENT_RESPONSE',
            sessionId,
            uuid,
            content: textContent,
            timestamp,
          };
        } else if (isLikelyCursor) {
          console.log(`[SessionWatcher] Skipping cursor-like content for ${uuid?.slice(-8)}: "${textContent}"`);
        } else {
          console.log(`[SessionWatcher] Text blocks found but textContent is empty for ${uuid?.slice(-8)}`);
        }
      }

      // Check for tool_use (VERBOSE) — with special handling for plan mode tools
      const toolUseBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === 'tool_use'
      );
      if (toolUseBlocks.length > 0) {
        const toolBlock = toolUseBlocks[0] as Record<string, unknown>;
        const toolName = toolBlock.name as string;
        const toolInput = toolBlock.input as Record<string, unknown> | undefined;

        // ExitPlanMode: emit the plan content as AGENT_RESPONSE so it shows as a chat message
        if (toolName === 'ExitPlanMode' && toolInput) {
          const planContent = toolInput.plan as string || toolInput.content as string || '';
          if (planContent) {
            return {
              type: 'AGENT_RESPONSE',
              sessionId,
              uuid,
              content: planContent,
              timestamp,
            };
          }
        }

        const formattedTool = formatToolUse(toolName, toolInput);
        const descriptor = normalizeToolUse(toolName, toolInput);

        return {
          type: 'VERBOSE',
          sessionId,
          uuid,
          content: formattedTool,
          tool: descriptor.tool,
          argSummary: descriptor.argSummary,
          timestamp,
        };
      }

      // Check for thinking (VERBOSE)
      const thinkingBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === 'thinking'
      );
      if (thinkingBlocks.length > 0) {
        const thinkingContent = thinkingBlocks
          .map((block: Record<string, unknown>) => block.thinking as string)
          .join('\n');
        const truncated = thinkingContent.length > 200
          ? thinkingContent.slice(0, 200) + '...'
          : thinkingContent;

        return {
          type: 'VERBOSE',
          sessionId,
          uuid,
          content: `🤔 ${truncated}`,
          timestamp,
        };
      }

      console.log(`[SessionWatcher] Assistant entry ${uuid?.slice(-8)} had no recognized content blocks`);
    }

    return null;
  }

  get watchCount(): number {
    return this.watchedSessions.size;
  }

  /** Announces a turn once, with the session as it stands. */
  private fireCompletion(session: WatchedSession, turn: Turn, reason: string): void {
    turn.announced = true;
    console.log(`[SessionWatcher] Session ${session.sessionId.slice(-8)} turn ${turn.root.slice(-8)} complete (${reason}), firing completion`);
    if (this.onCompletion) {
      this.onCompletion({
        sessionId: session.sessionId,
        filePath: session.filePath,
        lastMessage: session.lastMessage,
        messageCount: session.messageCount,
      });
    }
  }
}
