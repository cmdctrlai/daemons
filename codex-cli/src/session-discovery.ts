/**
 * Codex CLI Session Discovery
 *
 * Scans ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files to discover
 * existing Codex CLI sessions and report them to the CmdCtrl server.
 *
 * Codex stores sessions as JSONL files where each line is a JSON object:
 *   { timestamp, type, payload }
 *
 * Key line types:
 *   session_meta  - payload.id (session ID), payload.cwd (project path)
 *   event_msg     - payload.type: "user_message" | "agent_message" | "task_complete" | ...
 *   response_item - payload.role: "user" | "assistant" | "developer"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const ACTIVE_THRESHOLD_MS = 30 * 1000; // 30 seconds

export interface ExternalSession {
  session_id: string;
  slug: string;
  title: string;
  project: string;
  project_name: string;
  file_path: string;
  last_message: string;
  last_activity: string;
  is_active: boolean;
  message_count: number;
}

interface ParsedMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'agent';
  content: string;
}

interface ParsedSession {
  sessionId: string;
  project: string;
  projectName: string;
  startTime: string;
  lastUpdated: string;
  messages: ParsedMessage[];
}

// Cache: session file path → { session, fileMtime }
const sessionCache = new Map<string, { session: ExternalSession; fileMtime: number }>();

// Parsed message cache: file path → { messages, fileMtime }
const messageCache = new Map<string, { parsed: ParsedSession; fileMtime: number }>();

/**
 * Parse a Codex CLI JSONL session file into structured data.
 */
function parseSessionFile(filePath: string): ParsedSession | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    if (lines.length === 0) return null;

    let sessionId = '';
    let project = '';
    let projectName = '';
    let startTime = '';
    let lastUpdated = '';
    const messages: ParsedMessage[] = [];
    let messageIndex = 0;

    for (const line of lines) {
      let obj: { timestamp: string; type: string; payload: Record<string, unknown> };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      lastUpdated = obj.timestamp || lastUpdated;

      if (obj.type === 'session_meta') {
        sessionId = (obj.payload.id as string) || '';
        project = (obj.payload.cwd as string) || '';
        startTime = (obj.payload.timestamp as string) || obj.timestamp;
        // Derive project name from the last directory component
        if (project) {
          projectName = path.basename(project);
        }
      } else if (obj.type === 'event_msg') {
        const eventType = obj.payload.type as string;
        if (eventType === 'user_message') {
          messages.push({
            id: `user-${messageIndex++}`,
            timestamp: obj.timestamp,
            role: 'user',
            content: (obj.payload.message as string) || '',
          });
        } else if (eventType === 'agent_message') {
          messages.push({
            id: `agent-${messageIndex++}`,
            timestamp: obj.timestamp,
            role: 'agent',
            content: (obj.payload.message as string) || '',
          });
        }
      }
    }

    if (!sessionId || messages.length === 0) return null;

    return { sessionId, project, projectName, startTime, lastUpdated, messages };
  } catch {
    return null;
  }
}

/**
 * Generate a title from the first user message (first line, truncated).
 */
function generateTitle(text: string): string {
  if (!text) return '';
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 50) return firstLine;
  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 30) return truncated.slice(0, lastSpace) + '...';
  return truncated + '...';
}

/**
 * Discover all Codex CLI sessions on this device.
 *
 * Scans ~/.codex/sessions/ recursively for rollout-*.jsonl files and returns
 * session metadata for reporting to the CmdCtrl server.
 */
export function discoverSessions(excludeSessionIDs: Set<string> = new Set()): ExternalSession[] {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const sessions: ExternalSession[] = [];

  if (!fs.existsSync(sessionsDir)) return sessions;

  // Walk the YYYY/MM/DD directory structure
  const sessionFiles = findSessionFiles(sessionsDir);

  for (const filePath of sessionFiles) {
    try {
      const stat = fs.statSync(filePath);
      const fileMtime = stat.mtimeMs;

      // Check cache
      const cached = sessionCache.get(filePath);
      if (cached && cached.fileMtime === fileMtime) {
        const session = { ...cached.session };
        session.is_active = Date.now() - new Date(session.last_activity).getTime() < ACTIVE_THRESHOLD_MS;
        if (!excludeSessionIDs.has(session.session_id)) {
          sessions.push(session);
        }
        continue;
      }

      // Parse the file
      const parsed = parseSessionFile(filePath);
      if (!parsed) continue;

      const firstUserMsg = parsed.messages.find(m => m.role === 'user');
      const lastUserMsg = [...parsed.messages].reverse().find(m => m.role === 'user');

      const title = generateTitle(firstUserMsg?.content || '') || parsed.sessionId.slice(0, 8);
      const lastMessage = lastUserMsg
        ? (lastUserMsg.content.length > 100 ? lastUserMsg.content.slice(0, 100) + '...' : lastUserMsg.content)
        : '';

      const isActive = Date.now() - new Date(parsed.lastUpdated).getTime() < ACTIVE_THRESHOLD_MS;

      const session: ExternalSession = {
        session_id: parsed.sessionId,
        slug: '',
        title,
        project: parsed.project,
        project_name: parsed.projectName,
        file_path: filePath,
        last_message: lastMessage,
        last_activity: parsed.lastUpdated,
        is_active: isActive,
        message_count: parsed.messages.length,
      };

      // Update cache
      sessionCache.set(filePath, { session, fileMtime });

      if (!excludeSessionIDs.has(session.session_id)) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }

  // Sort by last activity (most recent first)
  sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );

  return sessions;
}

/**
 * Recursively find all rollout-*.jsonl files under the sessions directory.
 */
function findSessionFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Find the file path for a Codex CLI session by its session ID.
 * Checks the session cache first, then scans the filesystem.
 */
export function findSessionFile(sessionId: string): string | null {
  // Check cache first
  for (const [filePath, cached] of sessionCache.entries()) {
    if (cached.session.session_id === sessionId) {
      return filePath;
    }
  }

  // Scan filesystem
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  // Session ID appears in the filename: rollout-...-<session_id>.jsonl
  const sessionFiles = findSessionFiles(sessionsDir);
  for (const filePath of sessionFiles) {
    if (filePath.includes(sessionId)) {
      return filePath;
    }
    // Fall back to parsing the file
    try {
      const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
      const obj = JSON.parse(firstLine);
      if (obj.type === 'session_meta' && obj.payload?.id === sessionId) {
        return filePath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

interface ReadMessagesResult {
  messages: Array<{ uuid: string; role: 'USER' | 'AGENT'; content: string; timestamp: string }>;
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
}

/**
 * Read messages from a Codex CLI session file, formatted for the CmdCtrl protocol.
 * Generates stable UUIDs from message indices so cursor pagination works.
 */
export function readSessionMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): ReadMessagesResult {
  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    return { messages: [], hasMore: false };
  }

  try {
    const stat = fs.statSync(filePath);
    const fileMtime = stat.mtimeMs;

    // Check parsed message cache
    let parsed: ParsedSession | null = null;
    const cached = messageCache.get(filePath);
    if (cached && cached.fileMtime === fileMtime) {
      parsed = cached.parsed;
    } else {
      parsed = parseSessionFile(filePath);
      if (parsed) {
        messageCache.set(filePath, { parsed, fileMtime });
      }
    }

    if (!parsed || parsed.messages.length === 0) {
      return { messages: [], hasMore: false };
    }

    // Convert to CmdCtrl format
    let messages = parsed.messages.map(msg => ({
      uuid: stableUuid(sessionId + ':' + msg.id),
      role: (msg.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
      content: msg.content,
      timestamp: msg.timestamp,
    })).filter(m => m.content.length > 0);

    // Apply cursor pagination
    if (beforeUuid) {
      const idx = messages.findIndex(m => m.uuid === beforeUuid);
      if (idx > 0) messages = messages.slice(0, idx);
    }
    if (afterUuid) {
      const idx = messages.findIndex(m => m.uuid === afterUuid);
      if (idx >= 0) messages = messages.slice(idx + 1);
    }

    const hasMore = messages.length > limit;
    const limited = messages.slice(-limit);

    return {
      messages: limited,
      hasMore,
      oldestUuid: limited[0]?.uuid,
      newestUuid: limited[limited.length - 1]?.uuid,
    };
  } catch {
    return { messages: [], hasMore: false };
  }
}

/**
 * Generate a stable UUID from an input string.
 */
function stableUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
