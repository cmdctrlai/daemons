/**
 * Cursor CLI Session Discovery
 *
 * Scans ~/.cursor/projects/<encoded-path>/agent-transcripts/<session-id>.jsonl
 * to discover existing cursor-agent sessions.
 *
 * File format – each line is a JSON object:
 *   { role: "user" | "assistant", message: { content: [{ type: "text", text: "..." }] } }
 *
 * User messages have text wrapped in <user_query>...</user_query> tags.
 * Session ID = filename (UUID, without .jsonl).
 * Project path = decoded from the project directory name (hyphens → slashes).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const ACTIVE_THRESHOLD_MS = 30 * 1000;

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

export interface ParsedMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

// Cache: file path → { session, fileMtime }
const sessionCache = new Map<string, { session: ExternalSession; fileMtime: number }>();

// Cache: file path → { messages, fileMtime }
const messageCache = new Map<string, { messages: ParsedMessage[]; fileMtime: number }>();

/**
 * Strip <user_query>...</user_query> wrapper added by cursor-agent.
 */
function stripUserQueryTags(text: string): string {
  return text.replace(/^\s*<user_query>\s*/i, '').replace(/\s*<\/user_query>\s*$/i, '').trim();
}

/**
 * Extract plain text from a cursor-agent message content array.
 */
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('')
    .trim();
}

/**
 * Parse all messages from a cursor-agent transcript JSONL file.
 */
export function parseTranscriptFile(filePath: string): ParsedMessage[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const messages: ParsedMessage[] = [];
    let idx = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as {
          role: string;
          message: { content: Array<{ type: string; text?: string }> };
        };

        if (!obj.role || !obj.message?.content) continue;

        let text = extractText(obj.message.content);
        if (!text) continue;

        if (obj.role === 'user') {
          text = stripUserQueryTags(text);
          if (!text) continue;
          messages.push({ id: `user-${idx++}`, role: 'user', content: text });
        } else if (obj.role === 'assistant') {
          // cursor-agent appends thinking after the first blank line – keep only the answer
          const answerEnd = text.indexOf('\n\n');
          if (answerEnd !== -1) text = text.slice(0, answerEnd).trim();
          if (!text) continue;
          messages.push({ id: `agent-${idx++}`, role: 'agent', content: text });
        }
      } catch {
        // skip invalid lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Attempt to decode a cursor project directory name back to a filesystem path.
 * The encoding replaces '/' with '-' and drops the leading '/'.
 * e.g. "Users-mrwoof-src-testing" → "/Users/mrwoof/src/testing"
 *
 * We try all possible slash placements and return the first existing path.
 * Falls back to returning the encoded name if nothing exists.
 */
function decodeProjectPath(encoded: string): string {
  // Simple heuristic: replace all hyphens with slashes and prepend /
  const candidate = '/' + encoded.replace(/-/g, '/');
  if (fs.existsSync(candidate)) return candidate;

  // Walk all subdirs of ~/ looking for the encoded name match
  // (handles paths with hyphens in component names by trying common prefixes)
  const home = os.homedir();
  const homeEncoded = home.replace(/^\//, '').replace(/\//g, '-');
  if (encoded.startsWith(homeEncoded + '-')) {
    const rest = encoded.slice(homeEncoded.length + 1);
    const restPath = rest.replace(/-/g, '/');
    const tryPath = path.join(home, restPath);
    if (fs.existsSync(tryPath)) return tryPath;
  }

  return candidate;
}

/**
 * Generate title from first user message.
 */
function generateTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 50) return firstLine;
  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 30) return truncated.slice(0, lastSpace) + '...';
  return truncated + '...';
}

/**
 * Discover all cursor-agent sessions on this device.
 * Scans ~/.cursor/projects/<project>/agent-transcripts/<session>.jsonl
 */
export function discoverSessions(excludeSessionIDs: Set<string> = new Set()): ExternalSession[] {
  const projectsDir = path.join(os.homedir(), '.cursor', 'projects');
  const sessions: ExternalSession[] = [];

  if (!fs.existsSync(projectsDir)) return sessions;

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const transcriptsDir = path.join(projectsDir, projectDir, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    const projectPath = decodeProjectPath(projectDir);
    const projectName = path.basename(projectPath);

    let transcriptFiles: string[];
    try {
      transcriptFiles = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of transcriptFiles) {
      const sessionId = file.replace('.jsonl', '');
      if (excludeSessionIDs.has(sessionId)) continue;

      const filePath = path.join(transcriptsDir, file);

      try {
        const stat = fs.statSync(filePath);
        const fileMtime = stat.mtimeMs;

        const cached = sessionCache.get(filePath);
        if (cached && cached.fileMtime === fileMtime) {
          const session = { ...cached.session };
          session.is_active = Date.now() - new Date(session.last_activity).getTime() < ACTIVE_THRESHOLD_MS;
          sessions.push(session);
          continue;
        }

        const messages = parseTranscriptFile(filePath);
        if (messages.length === 0) continue;

        const firstUser = messages.find(m => m.role === 'user');
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const title = generateTitle(firstUser?.content || '') || sessionId.slice(0, 8);
        const lastMessage = lastUser?.content.slice(0, 100) || '';
        const lastActivity = new Date(stat.mtimeMs).toISOString();
        const isActive = Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS;

        const session: ExternalSession = {
          session_id: sessionId,
          slug: '',
          title,
          project: projectPath,
          project_name: projectName,
          file_path: filePath,
          last_message: lastMessage,
          last_activity: lastActivity,
          is_active: isActive,
          message_count: messages.length,
        };

        sessionCache.set(filePath, { session, fileMtime });
        sessions.push(session);
      } catch {
        continue;
      }
    }
  }

  sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );

  return sessions;
}

/**
 * Find the file path for a given session ID.
 */
export function findSessionFile(sessionId: string): string | null {
  for (const [filePath, cached] of sessionCache.entries()) {
    if (cached.session.session_id === sessionId) return filePath;
  }

  const projectsDir = path.join(os.homedir(), '.cursor', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, projectDir, 'agent-transcripts', `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Read messages from a cursor-agent session for the CmdCtrl get_messages protocol.
 */
export function readSessionMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): { messages: Array<{ uuid: string; role: 'USER' | 'AGENT'; content: string; timestamp: string }>; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return { messages: [], hasMore: false };

  try {
    const stat = fs.statSync(filePath);
    const fileMtime = stat.mtimeMs;

    let parsed: ParsedMessage[];
    const cached = messageCache.get(filePath);
    if (cached && cached.fileMtime === fileMtime) {
      parsed = cached.messages;
    } else {
      parsed = parseTranscriptFile(filePath);
      messageCache.set(filePath, { messages: parsed, fileMtime });
    }

    // Assign sequential timestamps 1s apart, ending at file mtime, to preserve order
    const total = parsed.filter(m => m.content.length > 0).length;
    let seq = 0;
    let messages = parsed.map(msg => ({
      uuid: stableUuid(sessionId + ':' + msg.id),
      role: (msg.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
      content: msg.content,
      timestamp: new Date(stat.mtimeMs - (total - seq++) * 1000).toISOString(),
    })).filter(m => m.content.length > 0);

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
export function stableUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
