/**
 * Aider Session Discovery
 *
 * Scans for `.aider.chat.history.md` files in the user's home directory tree
 * (up to 3 levels deep) and parses them into sessions that can be reported to
 * the CmdCtrl server.
 *
 * File format – each session block starts with:
 *   # aider chat started at YYYY-MM-DD HH:MM:SS
 * Followed by preamble `> ` lines, then turns:
 *   #### <user message>
 *   <agent response>
 *   > Tokens: ...  (meta lines – excluded from agent response)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionInfo } from '@cmdctrl/daemon-sdk';

const ACTIVE_THRESHOLD_MS = 30 * 1000;
const MAX_SCAN_DEPTH = 3;

// Directories to skip during scan
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '.npm',
  '.nvm', '.rbenv', '.pyenv', 'vendor', '__pycache__', '.venv',
]);

export interface ParsedMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

// Cache: sessionId → { filePath, startTime, messages, fileMtime }
const sessionCache = new Map<string, {
  filePath: string;
  startTime: string;
  messages: ParsedMessage[];
  fileMtime: number;
}>();

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

/**
 * Generate a session ID from file path and start time.
 */
function sessionIdFor(filePath: string, startTime: string): string {
  return stableUuid(`aider:${filePath}:${startTime}`);
}

/**
 * Parse all sessions from an aider chat history markdown file.
 * Returns array of { startTime, messages } for each session block.
 */
export function parseHistoryFile(filePath: string): Array<{ startTime: string; messages: ParsedMessage[] }> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sessions: Array<{ startTime: string; messages: ParsedMessage[] }> = [];

    // Split on session headers
    const headerRe = /^# aider chat started at (.+)$/m;
    const blocks = content.split(/^# aider chat started at .+$/m);
    const headerMatches = [...content.matchAll(/^# aider chat started at (.+)$/mg)];

    // blocks[0] is text before the first header (empty usually), skip it
    for (let i = 0; i < headerMatches.length; i++) {
      const startTime = headerMatches[i][1].trim();
      const blockText = blocks[i + 1] || '';
      const messages = parseSessionBlock(blockText);
      sessions.push({ startTime, messages });
    }

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Parse a single session block (text after the "# aider chat started at" header).
 * Split on "#### " markers – each is a user turn followed by an agent response.
 */
function parseSessionBlock(blockText: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let idx = 0;

  // Split by #### user message markers
  const turns = blockText.split(/^####\s*/m);
  // turns[0] is preamble (> lines), skip it

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i];
    const lines = turn.split('\n');

    // First line is the user message text
    const userText = lines[0].replace(/\s+$/, '').trim();
    if (!userText) continue;

    messages.push({ id: `user-${idx++}`, role: 'user', content: userText });

    // Remaining lines up to first `> ` line = agent response
    const restLines = lines.slice(1);
    const metaStart = restLines.findIndex(l => l.startsWith('> ') || l === '>');
    const responseLines = metaStart >= 0 ? restLines.slice(0, metaStart) : restLines;
    const agentText = responseLines.join('\n').trim();

    if (agentText) {
      messages.push({ id: `agent-${idx++}`, role: 'agent', content: agentText });
    }
  }

  return messages;
}

/**
 * Generate a title from the first user message.
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
 * Scan a directory for `.aider.chat.history.md` files up to `maxDepth`.
 */
function scanForHistoryFiles(dir: string, depth: number, results: string[]): void {
  if (depth > MAX_SCAN_DEPTH) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.aider.chat.history.md') continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      if (entry.isFile() && entry.name === '.aider.chat.history.md') {
        results.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
        scanForHistoryFiles(path.join(dir, entry.name), depth + 1, results);
      }
    }
  } catch {
    // Permission errors etc – skip
  }
}

/**
 * Discover all aider sessions from chat history files.
 * Excludes sessions whose IDs are in `excludeSessionIds`.
 */
export function discoverSessions(excludeSessionIds: Set<string> = new Set()): SessionInfo[] {
  const home = os.homedir();
  const historyFiles: string[] = [];
  scanForHistoryFiles(home, 0, historyFiles);

  const sessions: SessionInfo[] = [];

  for (const filePath of historyFiles) {
    try {
      const stat = fs.statSync(filePath);
      const fileMtime = stat.mtimeMs;
      const projectPath = path.dirname(filePath);
      const projectName = path.basename(projectPath);

      const parsed = parseHistoryFile(filePath);

      for (const { startTime, messages } of parsed) {
        if (messages.length === 0) continue;

        const sessionId = sessionIdFor(filePath, startTime);
        if (excludeSessionIds.has(sessionId)) continue;

        const firstUser = messages.find(m => m.role === 'user');
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const title = generateTitle(firstUser?.content || '') || sessionId.slice(0, 8);
        const lastMessage = lastUser?.content.slice(0, 100) || '';

        // Use the session start time from the header; fall back to file mtime
        const startMs = new Date(startTime.replace(' ', 'T')).getTime() || fileMtime;
        const lastActivity = new Date(startMs).toISOString();
        const isActive = Date.now() - startMs < ACTIVE_THRESHOLD_MS;

        // Update cache
        sessionCache.set(sessionId, {
          filePath,
          startTime,
          messages,
          fileMtime,
        });

        sessions.push({
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
        });
      }
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );

  return sessions;
}

/**
 * Read messages for a given aider session in the CmdCtrl get_messages format.
 */
export function readSessionMessages(
  sessionId: string,
  limit: number,
  beforeUuid?: string,
  afterUuid?: string
): { messages: Array<{ uuid: string; role: 'USER' | 'AGENT'; content: string; timestamp: string }>; hasMore: boolean; oldestUuid?: string; newestUuid?: string } {
  const cached = sessionCache.get(sessionId);
  if (!cached) {
    // Try re-scanning to populate cache
    discoverSessions();
    const recached = sessionCache.get(sessionId);
    if (!recached) return { messages: [], hasMore: false };
    return readSessionMessages(sessionId, limit, beforeUuid, afterUuid);
  }

  try {
    // Re-read if file changed
    const stat = fs.statSync(cached.filePath);
    let messages = cached.messages;

    if (stat.mtimeMs !== cached.fileMtime) {
      const parsed = parseHistoryFile(cached.filePath);
      const block = parsed.find(s => sessionIdFor(cached.filePath, s.startTime) === sessionId);
      if (!block) return { messages: [], hasMore: false };
      messages = block.messages;
      sessionCache.set(sessionId, { ...cached, messages, fileMtime: stat.mtimeMs });
    }

    const startMs = new Date(cached.startTime.replace(' ', 'T')).getTime() || stat.mtimeMs;
    const total = messages.length;
    let mapped = messages.map((msg, seq) => ({
      uuid: stableUuid(sessionId + ':' + msg.id),
      role: (msg.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
      content: msg.content,
      timestamp: new Date(startMs + seq * 1000).toISOString(),
    }));

    if (beforeUuid) {
      const idx = mapped.findIndex(m => m.uuid === beforeUuid);
      if (idx > 0) mapped = mapped.slice(0, idx);
    }
    if (afterUuid) {
      const idx = mapped.findIndex(m => m.uuid === afterUuid);
      if (idx >= 0) mapped = mapped.slice(idx + 1);
    }

    const hasMore = mapped.length > limit;
    const limited = mapped.slice(-limit);

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
