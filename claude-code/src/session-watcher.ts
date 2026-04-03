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

// Event types emitted by SessionWatcher
export interface SessionEvent {
  type: 'AGENT_RESPONSE' | 'VERBOSE' | 'USER_MESSAGE';
  sessionId: string;
  uuid: string;
  content: string;
  timestamp: string;
  // For USER_MESSAGE events
  isToolResult?: boolean;
}

interface WatchedSession {
  sessionId: string;
  filePath: string;
  lastSize: number;
  processedUuids: Set<string>;
  // UUIDs of user entries that contained tool_result blocks.
  // Assistant entries whose parentUuid is in this set are internal
  // continuation responses (e.g. "No response requested.") and
  // should not be emitted as AGENT_RESPONSE events.
  toolResultUuids: Set<string>;
  lastLineCount: number;
  messageCount: number;
  lastMessage: string;
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

// Polling interval (500ms)
const POLL_INTERVAL_MS = 500;

export class SessionWatcher {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private onEvent: EventCallback;
  private onCompletion: CompletionCallback | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(onEvent: EventCallback, onCompletion?: CompletionCallback) {
    this.onEvent = onEvent;
    this.onCompletion = onCompletion || null;
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

    try {
      const stats = fs.statSync(filePath);
      const { processedUuids, toolResultUuids, lineCount, messageCount, lastMessage } = this.initializeFromFile(filePath);

      this.watchedSessions.set(sessionId, {
        sessionId,
        filePath,
        lastSize: stats.size,
        processedUuids,
        toolResultUuids,
        lastLineCount: lineCount,
        messageCount,
        lastMessage,
      });

      console.log(`[SessionWatcher] Started watching session ${sessionId} (${processedUuids.size} entries, ${messageCount} messages)`);

      // Start polling if not already running
      if (!this.pollTimer) {
        this.startPolling();
      }
    } catch (err) {
      console.error(`[SessionWatcher] Failed to watch ${filePath}:`, err);
    }
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
   * This prevents emitting events for entries that existed before we started watching
   */
  private initializeFromFile(filePath: string): { processedUuids: Set<string>; toolResultUuids: Set<string>; lineCount: number; messageCount: number; lastMessage: string } {
    const processedUuids = new Set<string>();
    const toolResultUuids = new Set<string>();
    let messageCount = 0;
    let lastMessage = '';

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.uuid) {
            processedUuids.add(entry.uuid);
            messageCount++;

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
      }

      return { processedUuids, toolResultUuids, lineCount: lines.length, messageCount, lastMessage };
    } catch {
      return { processedUuids, toolResultUuids, lineCount: 0, messageCount: 0, lastMessage: '' };
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
      if (!fs.existsSync(session.filePath)) {
        console.warn(`[SessionWatcher] File no longer exists: ${session.filePath}`);
        this.unwatchSession(session.sessionId);
        return;
      }

      const stats = fs.statSync(session.filePath);

      // Only process if file size changed
      if (stats.size === session.lastSize) {
        return;
      }

      // Read and process new entries
      const newEntries = this.readNewEntries(session);
      session.lastSize = stats.size;

      // First pass: emit events and track what we saw
      let sawWaitingForInput = false;
      let sawUserMessage = false;
      let sawSystemEntry = false;

      for (const entry of newEntries) {
        const entryType = entry.type as string;

        // Track user entries with tool_result content so we can filter the
        // assistant "No response requested." replies that follow them.
        if (entryType === 'user' && entry.uuid) {
          const entryContent = (entry.message as Record<string, unknown> | undefined)?.content;
          if (Array.isArray(entryContent) && entryContent.some((b: Record<string, unknown>) => b.type === 'tool_result')) {
            session.toolResultUuids.add(entry.uuid as string);
          }
        }

        // Detect system entries – these are written by Claude Code at the end of
        // each turn (never mid-turn), making them a reliable turn-complete signal.
        if (entryType === 'system') {
          sawSystemEntry = true;
        }

        const event = this.entryToEvent(session.sessionId, entry, session.toolResultUuids);
        if (event) {
          console.log(`[SessionWatcher] Emitting ${event.type} for session ${session.sessionId.slice(-8)}: ${event.content.slice(0, 50)}...`);
          this.onEvent(event);

          // Track message count and last message (only agent messages for push notification body)
          session.messageCount++;
          if (event.type === 'AGENT_RESPONSE') {
            session.lastMessage = event.content.slice(0, 200);
          } else if (event.type === 'USER_MESSAGE') {
            sawUserMessage = true;
          }

          // Check for actual tool_use blocks (not thinking, not tool_result)
          // This is the authoritative check for "agent is making a tool call"
          if (this.entryHasToolUse(entry)) {
            // ExitPlanMode and AskUserQuestion mean the agent is BLOCKED waiting for user input,
            // not actively working. Treat these as "waiting for input" rather than "still working".
            if (this.entryHasWaitingToolUse(entry)) {
              sawWaitingForInput = true;
            }
          }
        }
        if (entry.uuid) {
          session.processedUuids.add(entry.uuid as string);
        }
      }

      // Completion detection based on entire batch
      if (sawWaitingForInput) {
        // Agent is blocked on user input (plan approval, question) – fire completion immediately
        console.log(`[SessionWatcher] Session ${session.sessionId.slice(-8)} is waiting for user input, firing completion`);
        this.fireCompletion(session);
      } else if (sawSystemEntry) {
        // System entries mark end-of-turn in Claude Code's JSONL – they are never
        // written mid-turn, making them a reliable completion signal.
        // Always fire even if a user message is in the same batch – the user may
        // have subscribed for push notifications from a different client.
        console.log(`[SessionWatcher] Session ${session.sessionId.slice(-8)} turn complete (system entry), firing completion`);
        this.fireCompletion(session);
      }

    } catch (err) {
      console.error(`[SessionWatcher] Error checking session ${session.sessionId}:`, err);
    }
  }

  /**
   * Read only NEW entries appended since lastSize
   * Reads from lastSize offset forward, avoiding full file reads
   */
  private readNewEntries(session: WatchedSession): Array<Record<string, unknown>> {
    const newEntries: Array<Record<string, unknown>> = [];

    try {
      const stats = fs.statSync(session.filePath);
      const newBytes = stats.size - session.lastSize;

      if (newBytes <= 0) {
        return newEntries;
      }

      // Read only the new bytes from the end
      const fd = fs.openSync(session.filePath, 'r');
      const buffer = Buffer.alloc(newBytes);
      fs.readSync(fd, buffer, 0, newBytes, session.lastSize);
      fs.closeSync(fd);

      const content = buffer.toString('utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Skip entries we've already processed (safety check)
          if (entry.uuid && session.processedUuids.has(entry.uuid)) {
            continue;
          }
          // Skip internal entries (no uuid)
          if (!entry.uuid) {
            continue;
          }
          newEntries.push(entry);
        } catch {
          // Skip invalid JSON lines (could be partial line at boundary)
        }
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

    // Handle user entries
    if (entryType === 'user') {
      // Skip non-user entries: compaction summaries, transcript-only content, etc.
      // These are system-generated entries that Claude Code marks with special flags.
      if (entry.isCompactSummary || entry.isVisibleInTranscriptOnly) {
        return null;
      }

      // Check if this is a tool_result (internal, but we emit as VERBOSE)
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

      // Skip non-user content: system messages, JSON data, and XML-like tags.
      const trimmed = textContent.trim();
      if (trimmed.startsWith('<') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return null;
      }

      // Skip known system message prefixes (continuation prompts, etc.)
      const systemPrefixes = [
        'This session is being continued from a previous conversation',
        'This conversation is being continued from a previous session',
      ];
      if (systemPrefixes.some(prefix => trimmed.startsWith(prefix))) {
        return null;
      }

      return {
        type: 'USER_MESSAGE',
        sessionId,
        uuid,
        content: textContent,
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

        // Skip internal continuation noise – short auto-responses after tool results
        // like "No response requested." that Claude emits between tool calls.
        // Only filter these when the parent is a tool_result entry AND the text
        // matches known noise patterns. Real agent responses that happen to follow
        // tool results must NOT be filtered.
        const parentUuid = entry.parentUuid as string | undefined;
        const isToolResultContinuation = parentUuid && toolResultUuids?.has(parentUuid);
        const isNoiseResponse = isToolResultContinuation && (
          textContent === 'No response requested.' ||
          textContent.length <= 5
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

        const formattedTool = this.formatToolUse(toolName, toolInput);

        return {
          type: 'VERBOSE',
          sessionId,
          uuid,
          content: formattedTool,
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

  /**
   * Format a tool_use block for verbose display
   */
  private formatToolUse(name: string, input?: Record<string, unknown>): string {
    switch (name) {
      case 'Read':
        return `📖 Reading ${input?.file_path || 'file'}`;
      case 'Write':
        return `✏️ Writing ${input?.file_path || 'file'}`;
      case 'Edit':
        return `🔧 Editing ${input?.file_path || 'file'}`;
      case 'Bash':
        const cmd = ((input?.command as string) || '').slice(0, 60);
        return `⚡ Running: ${cmd}`;
      case 'Glob':
        return `🔍 Searching: ${input?.pattern || ''}`;
      case 'Grep':
        return `🔎 Grepping: ${input?.pattern || ''}`;
      case 'Task':
        return `📋 Spawning task: ${input?.description || 'subagent'}`;
      case 'TodoWrite':
        return `📝 Updating todos`;
      case 'WebSearch':
        return `🌐 Searching: ${input?.query || ''}`;
      case 'WebFetch':
        return `🌐 Fetching: ${input?.url || ''}`;
      case 'EnterPlanMode':
        return `📋 Entered plan mode`;
      case 'ExitPlanMode':
        return `📋 Plan ready for approval`;
      default:
        return `🔧 ${name}`;
    }
  }

  get watchCount(): number {
    return this.watchedSessions.size;
  }

  /**
   * Check if an entry contains tool_use blocks (agent is making a tool call)
   */
  private entryHasToolUse(entry: Record<string, unknown>): boolean {
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((block: Record<string, unknown>) => block.type === 'tool_use');
  }

  /**
   * Check if an entry contains tool_use blocks that signal "waiting for user input"
   * These tools block the agent until the user responds (plan approval, questions).
   */
  private entryHasWaitingToolUse(entry: Record<string, unknown>): boolean {
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (!Array.isArray(content)) {
      return false;
    }

    const waitingTools = new Set(['ExitPlanMode', 'AskUserQuestion']);
    return content.some(
      (block: Record<string, unknown>) => block.type === 'tool_use' && waitingTools.has(block.name as string)
    );
  }

  /**
   * Fire the completion callback immediately for a session
   */
  private fireCompletion(session: WatchedSession): void {
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
