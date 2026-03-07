/**
 * Context handler for extracting session context for dashboard summaries
 */

import * as fs from 'fs';
import * as path from 'path';
import { findSessionFile } from '../message-reader';
import { SessionStatus, ContextResponseMessage } from '../client/messages';

interface JournalEntry {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string;
  };
  // Tool use entries have different structure
  name?: string;  // tool name for tool_use entries
  input?: unknown;  // tool input
}

interface SessionContext {
  title: string;
  projectPath: string;
  initialPrompt?: string;
  recentMessages: Array<{ role: 'USER' | 'AGENT'; content: string }>;
  lastToolUse?: string;
  messageCount: number;
  startedAt?: string;
  lastActivityAt: string;
  status: SessionStatus;
  statusDetail?: string;
}

/**
 * Extract readable text from message content (handles string or array of content blocks)
 */
function extractReadableText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block && typeof block === 'object') {
        if (block.type === 'text' && typeof block.text === 'string') {
          // Strip thinking tags
          const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
          if (text) {
            textParts.push(text);
          }
        }
      }
    }
    return textParts.join(' ').trim();
  }

  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text: unknown }).text;
    if (typeof text === 'string') {
      return text.trim();
    }
  }

  return '';
}

/**
 * Detect if a message contains a question (agent asking user for input)
 */
function isQuestionToUser(content: string): { isQuestion: boolean; questionText?: string } {
  // Common question patterns
  const questionPatterns = [
    /\?$/m,  // Ends with question mark
    /^(should i|would you|do you|can you|shall i|which|what|how|where|when)/im,
    /please (confirm|specify|provide|let me know|clarify)/i,
    /waiting for (your|user) (input|response|confirmation)/i,
  ];

  for (const pattern of questionPatterns) {
    if (pattern.test(content)) {
      // Extract the first sentence/line that looks like a question
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (/\?$/.test(line.trim())) {
          return { isQuestion: true, questionText: line.trim().slice(0, 100) };
        }
      }
      return { isQuestion: true, questionText: content.slice(0, 100) };
    }
  }

  return { isQuestion: false };
}

/**
 * Extract context from a session JSONL file
 */
export function extractSessionContext(
  sessionId: string,
  options: {
    includeInitialPrompt?: boolean;
    recentMessagesCount?: number;
    includeLastToolUse?: boolean;
  } = {}
): SessionContext | null {
  const {
    includeInitialPrompt = true,
    recentMessagesCount = 10,
    includeLastToolUse = true,
  } = options;

  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    return null;
  }

  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let title = '';
    let projectPath = '';
    let initialPrompt: string | undefined;
    let lastToolUse: string | undefined;
    let startedAt: string | undefined;
    let lastActivityAt = stat.mtime.toISOString();
    let status: SessionStatus = 'working';
    let statusDetail: string | undefined;

    const allMessages: Array<{ role: 'USER' | 'AGENT'; content: string; timestamp?: string }> = [];
    let messageCount = 0;
    let lastEntry: JournalEntry | null = null;
    let lastAssistantContent = '';

    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line);
        lastEntry = entry;

        // Extract metadata
        if (entry.cwd && !projectPath) {
          projectPath = entry.cwd;
        }

        if (entry.timestamp && !startedAt) {
          startedAt = entry.timestamp;
        }

        if (entry.timestamp) {
          lastActivityAt = entry.timestamp;
        }

        // Count and extract messages
        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++;

          const text = extractReadableText(entry.message?.content);
          if (text) {
            const role: 'USER' | 'AGENT' = entry.type === 'user' ? 'USER' : 'AGENT';
            allMessages.push({ role, content: text, timestamp: entry.timestamp });

            // Track first user message for initial prompt
            if (entry.type === 'user' && !initialPrompt && includeInitialPrompt) {
              initialPrompt = text;
              // Generate title from first user message
              const firstLine = text.split('\n')[0].trim();
              title = firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine;
            }

            // Track last assistant content for status detection
            if (entry.type === 'assistant') {
              lastAssistantContent = text;
            }
          }
        }

        // Track tool use
        if (entry.type === 'tool_use' && includeLastToolUse && entry.name) {
          // Format: "Read file: src/main.ts" or "Edit: src/main.ts"
          let toolDesc = entry.name;
          if (entry.input && typeof entry.input === 'object') {
            const input = entry.input as Record<string, unknown>;
            if (input.file_path) {
              toolDesc = `${entry.name}: ${input.file_path}`;
            } else if (input.path) {
              toolDesc = `${entry.name}: ${input.path}`;
            } else if (input.command) {
              const cmd = String(input.command).slice(0, 50);
              toolDesc = `${entry.name}: ${cmd}`;
            }
          }
          lastToolUse = toolDesc;
        }

        // Also check for tool_use blocks within assistant messages
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content as Array<{ type: string; name?: string; input?: unknown }>) {
            if (block.type === 'tool_use' && block.name && includeLastToolUse) {
              let toolDesc = block.name;
              if (block.input && typeof block.input === 'object') {
                const input = block.input as Record<string, unknown>;
                if (input.file_path) {
                  toolDesc = `${block.name}: ${input.file_path}`;
                } else if (input.path) {
                  toolDesc = `${block.name}: ${input.path}`;
                } else if (input.command) {
                  const cmd = String(input.command).slice(0, 50);
                  toolDesc = `${block.name}: ${cmd}`;
                }
              }
              lastToolUse = toolDesc;
            }
          }
        }

      } catch {
        // Skip invalid JSON lines
        continue;
      }
    }

    // Determine status based on last entry
    if (lastEntry) {
      // Check if there's an error event
      if (lastEntry.type === 'error') {
        status = 'errored';
        statusDetail = extractReadableText(lastEntry.message?.content) || 'Error occurred';
      }
      // Check if last assistant entry contains ExitPlanMode (plan waiting for approval)
      else if (lastEntry.type === 'assistant' && Array.isArray(lastEntry.message?.content) &&
        (lastEntry.message.content as Array<{ type: string; name?: string }>).some(
          b => b.type === 'tool_use' && b.name === 'ExitPlanMode'
        )) {
        status = 'waiting_for_input';
        statusDetail = 'Plan ready for approval';
      }
      // Check if last message is from assistant with a question
      else if (lastEntry.type === 'assistant' && lastAssistantContent) {
        const { isQuestion, questionText } = isQuestionToUser(lastAssistantContent);
        if (isQuestion) {
          status = 'waiting_for_input';
          statusDetail = questionText ? `Asked: ${questionText}` : 'Waiting for user input';
        } else {
          // Assistant responded without asking - could be completed or still working
          const stopReason = lastEntry.message?.stop_reason;
          if (stopReason === 'end_turn' || stopReason === null) {
            // Check if it's a completion or still working based on tool use
            const hasToolUse = Array.isArray(lastEntry.message?.content) &&
              (lastEntry.message.content as Array<{ type: string }>).some(b => b.type === 'tool_use');
            if (!hasToolUse && lastAssistantContent.length > 20) {
              status = 'completed';
              statusDetail = lastAssistantContent.slice(0, 100);
            }
          }
        }
      }
      // Check for stale sessions (no activity in 30+ minutes)
      const timeSinceActivity = Date.now() - stat.mtime.getTime();
      if (timeSinceActivity > 30 * 60 * 1000 && status === 'working') {
        status = 'stale';
      }
    }

    // Get recent messages
    const recentMessages = allMessages.slice(-recentMessagesCount).map(m => ({
      role: m.role,
      content: m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content,
    }));

    return {
      title: title || sessionId.slice(0, 8),
      projectPath: projectPath || path.dirname(filePath),
      initialPrompt: includeInitialPrompt ? initialPrompt : undefined,
      recentMessages,
      lastToolUse: includeLastToolUse ? lastToolUse : undefined,
      messageCount,
      startedAt,
      lastActivityAt,
      status,
      statusDetail,
    };

  } catch (err) {
    console.error(`[ContextHandler] Failed to extract context for session ${sessionId}:`, err);
    return null;
  }
}

/**
 * Build a context response message
 */
export function buildContextResponse(
  requestId: string,
  sessionId: string,
  options: {
    includeInitialPrompt?: boolean;
    recentMessagesCount?: number;
    includeLastToolUse?: boolean;
  } = {}
): ContextResponseMessage {
  const context = extractSessionContext(sessionId, options);

  if (!context) {
    return {
      type: 'context_response',
      request_id: requestId,
      session_id: sessionId,
      context: {
        title: '',
        project_path: '',
        message_count: 0,
        last_activity_at: new Date().toISOString(),
        status: 'stale',
      },
      error: `Session ${sessionId} not found`,
    };
  }

  return {
    type: 'context_response',
    request_id: requestId,
    session_id: sessionId,
    context: {
      title: context.title,
      project_path: context.projectPath,
      initial_prompt: context.initialPrompt,
      recent_messages: context.recentMessages,
      last_tool_use: context.lastToolUse,
      message_count: context.messageCount,
      started_at: context.startedAt,
      last_activity_at: context.lastActivityAt,
      status: context.status,
      status_detail: context.statusDetail,
    },
  };
}
