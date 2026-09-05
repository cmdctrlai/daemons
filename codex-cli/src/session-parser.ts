/**
 * Codex CLI rollout parsing.
 *
 * Codex writes one JSON object per line to
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl:
 *   { timestamp, type, payload }
 *
 * Two message encodings exist in the wild and both have to keep working –
 * rollout files are never rewritten, so old sessions stay in the old shape
 * forever:
 *
 *   <= 0.148  event_msg, payload.type "user_message" | "agent_message",
 *             text at payload.message
 *   >= 0.151  event_msg, payload.type "item_completed", payload.item.type
 *             "UserMessage" | "AgentMessage", text at item.content[].text
 *             (content tag is "text" for user turns and "Text" for agent ones)
 *
 * Discovery and the live watcher both parse these files and must agree on
 * message order and index – the index feeds the stable UUID each side reports
 * to the server, so a divergence duplicates messages. That is why this lives
 * in one place rather than in each caller.
 */

import * as path from 'path';

export interface ParsedMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'agent';
  content: string;
  /** Set when a task_complete event followed this agent message. */
  isComplete?: boolean;
}

export interface ParsedRollout {
  sessionId: string;
  project: string;
  projectName: string;
  /** Codex version that wrote the file, from session_meta. Empty if absent. */
  cliVersion: string;
  startTime: string;
  lastUpdated: string;
  messages: ParsedMessage[];
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

// One warning per file per process – discovery re-reads every file on a timer.
const warnedEmptyRollouts = new Set<string>();

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pull the text out of a 0.151+ item's content array.
 *
 * Codex tags user text "text" and agent text "Text"; response-item style
 * payloads use "input_text"/"output_text". Match on the suffix so a new
 * casing or prefix does not silently drop the message.
 */
function itemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const part = entry as { type?: unknown; text?: unknown };
    if (!str(part.type).toLowerCase().endsWith('text')) continue;
    if (typeof part.text === 'string' && part.text) parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Parse the contents of a rollout file into session metadata and messages.
 *
 * Always returns a result: an unparseable or message-free file yields an empty
 * `messages` array, and a completed turn that produced none logs a warning.
 * Callers decide whether a session with no messages is worth reporting.
 */
export function parseRollout(raw: string, filePath: string): ParsedRollout {
  let sessionId = '';
  let project = '';
  let projectName = '';
  let cliVersion = '';
  let startTime = '';
  let lastUpdated = '';
  let sawCompletedTurn = false;
  const messages: ParsedMessage[] = [];
  let messageIndex = 0;

  const push = (role: 'user' | 'agent', timestamp: string, content: string): void => {
    messages.push({ id: `${role}-${messageIndex++}`, timestamp, role, content });
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    let obj: RolloutLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = str(obj.timestamp);
    if (timestamp) lastUpdated = timestamp;

    const payload = obj.payload || {};

    if (obj.type === 'session_meta') {
      // A rollout can carry more than one header: a thread that forks or spawns
      // from another replays that thread's session_meta after its own. The first
      // header is the one that identifies this file. Note payload.id is the
      // thread and payload.session_id is the conversation it belongs to, so the
      // fallback below is only a last resort.
      if (sessionId) continue;
      sessionId = str(payload.id) || str(payload.session_id);
      project = str(payload.cwd);
      projectName = project ? path.basename(project) : '';
      cliVersion = str(payload.cli_version);
      startTime = str(payload.timestamp) || timestamp;
      continue;
    }

    if (obj.type !== 'event_msg') continue;

    const eventType = str(payload.type);

    if (eventType === 'user_message') {
      push('user', timestamp, str(payload.message));
    } else if (eventType === 'agent_message') {
      push('agent', timestamp, str(payload.message));
    } else if (eventType === 'item_completed') {
      const item = (payload.item || {}) as Record<string, unknown>;
      const itemType = str(item.type);
      // Reasoning, CommandExecution, SubAgentActivity and friends arrive through
      // the same wrapper and are not conversation messages.
      if (itemType === 'UserMessage') {
        push('user', timestamp, itemText(item));
      } else if (itemType === 'AgentMessage') {
        push('agent', timestamp, itemText(item));
      }
    } else if (eventType === 'task_complete') {
      sawCompletedTurn = true;
      const lastAgent = [...messages].reverse().find(m => m.role === 'agent');
      if (lastAgent) lastAgent.isComplete = true;
    }
  }

  // A turn that ran to completion without yielding a single message is the
  // signature of a format change. Waiting for task_complete keeps a rollout
  // that is merely mid-turn from tripping the warning, which matters because
  // the dedupe below would then never let that file warn again.
  if (messages.length === 0 && sawCompletedTurn && !warnedEmptyRollouts.has(filePath)) {
    warnedEmptyRollouts.add(filePath);
    console.warn(
      `[CodexParser] A completed turn yielded no messages: ${filePath} ` +
        `(cli_version ${cliVersion || 'unknown'}). ` +
        `Codex may have changed its message format again.`
    );
  }

  return { sessionId, project, projectName, cliVersion, startTime, lastUpdated, messages };
}

/**
 * Clear the record of which files have already warned. Tests use this; a
 * long-lived daemon does not need it, the set only grows with rollout files.
 */
export function resetRolloutWarnings(): void {
  warnedEmptyRollouts.clear();
}
