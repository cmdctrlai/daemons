/**
 * Gemini CLI Session Discovery
 *
 * Scans ~/.gemini/tmp/<project>/chats/session-*.json files to discover
 * existing Gemini CLI sessions and report them to the CmdCtrl server.
 *
 * Gemini stores sessions as:
 *   ~/.gemini/projects.json          - Maps project path → project name
 *   ~/.gemini/tmp/<name>/chats/*.json - Session files per project
 *
 * Each session JSON contains:
 *   sessionId, projectHash, startTime, lastUpdated, messages[]
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

interface GeminiSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string | Array<{ text?: string }>;
}

interface ProjectsMap {
  projects: Record<string, string>; // path → name
}

// Cache: session file path → { session, fileMtime }
const sessionCache = new Map<string, { session: ExternalSession; fileMtime: number }>();

/**
 * Build a map from project hash → project path using ~/.gemini/projects.json
 */
function buildProjectHashMap(): Map<string, { path: string; name: string }> {
  const hashMap = new Map<string, { path: string; name: string }>();
  const projectsFile = path.join(os.homedir(), '.gemini', 'projects.json');

  try {
    if (!fs.existsSync(projectsFile)) return hashMap;
    const data: ProjectsMap = JSON.parse(fs.readFileSync(projectsFile, 'utf-8'));

    for (const [projectPath, projectName] of Object.entries(data.projects)) {
      const hash = crypto.createHash('sha256').update(projectPath).digest('hex');
      hashMap.set(hash, { path: projectPath, name: projectName });
      // Also map by name for directory name lookups
      hashMap.set(projectName, { path: projectPath, name: projectName });
    }
  } catch {
    // Can't read projects.json, proceed without mapping
  }

  return hashMap;
}

/**
 * Extract readable text from a Gemini message's content field.
 */
function extractText(content: string | Array<{ text?: string }>): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(block => block.text || '')
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * Generate a title from message text (first line, truncated).
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
 * Parse a single Gemini session JSON file.
 */
function parseSessionFile(
  filePath: string,
  projectPath: string,
  projectName: string
): ExternalSession | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: GeminiSession = JSON.parse(raw);

    if (!data.sessionId || !data.messages || data.messages.length === 0) {
      return null;
    }

    const lastUpdated = data.lastUpdated || data.startTime;
    const isActive = Date.now() - new Date(lastUpdated).getTime() < ACTIVE_THRESHOLD_MS;

    // Find first user message for title
    let firstUserText = '';
    let lastUserText = '';
    for (const msg of data.messages) {
      if (msg.type === 'user') {
        const text = extractText(msg.content);
        if (text) {
          if (!firstUserText) firstUserText = text;
          lastUserText = text;
        }
      }
    }

    const title = generateTitle(firstUserText) || data.sessionId.slice(0, 8);
    const lastMessage = lastUserText.length > 100
      ? lastUserText.slice(0, 100) + '...'
      : lastUserText;

    return {
      session_id: data.sessionId,
      slug: '',
      title,
      project: projectPath,
      project_name: projectName,
      file_path: filePath,
      last_message: lastMessage,
      last_activity: lastUpdated,
      is_active: isActive,
      message_count: data.messages.length,
    };
  } catch {
    return null;
  }
}

/**
 * Discover all Gemini CLI sessions on this device.
 *
 * Scans ~/.gemini/tmp/<project>/chats/session-*.json and returns
 * session metadata for reporting to the CmdCtrl server.
 */
export function discoverSessions(excludeSessionIDs: Set<string> = new Set()): ExternalSession[] {
  const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');
  const sessions: ExternalSession[] = [];

  if (!fs.existsSync(geminiTmp)) return sessions;

  const projectHashMap = buildProjectHashMap();

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(geminiTmp, { withFileTypes: true });
  } catch {
    return sessions;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;

    const chatsDir = path.join(geminiTmp, dirEntry.name, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    // Resolve project path and name from directory name
    const projectInfo = projectHashMap.get(dirEntry.name);
    const projectPath = projectInfo?.path || dirEntry.name;
    const projectName = projectInfo?.name || dirEntry.name;

    let chatFiles: string[];
    try {
      chatFiles = fs.readdirSync(chatsDir)
        .filter(f => f.startsWith('session-') && f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      const filePath = path.join(chatsDir, chatFile);

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
        const session = parseSessionFile(filePath, projectPath, projectName);
        if (!session) continue;

        // Update cache
        sessionCache.set(filePath, { session, fileMtime });

        if (!excludeSessionIDs.has(session.session_id)) {
          sessions.push(session);
        }
      } catch {
        continue;
      }
    }
  }

  // Sort by last activity (most recent first)
  sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );

  return sessions;
}

/**
 * Find the file path for a Gemini session by its session ID.
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
  const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');
  if (!fs.existsSync(geminiTmp)) return null;

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(geminiTmp, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const chatsDir = path.join(geminiTmp, dirEntry.name, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    let chatFiles: string[];
    try {
      chatFiles = fs.readdirSync(chatsDir)
        .filter(f => f.startsWith('session-') && f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      const filePath = path.join(chatsDir, chatFile);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as { sessionId?: string };
        if (data.sessionId === sessionId) {
          return filePath;
        }
      } catch {
        continue;
      }
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
 * Read messages from a Gemini session file, formatted for the CmdCtrl protocol.
 * Generates stable UUIDs from message IDs so cursor pagination works.
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
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: GeminiSession = JSON.parse(raw);
    if (!data.messages || data.messages.length === 0) {
      return { messages: [], hasMore: false };
    }

    // Convert Gemini messages to CmdCtrl format
    let messages = data.messages.map(msg => ({
      uuid: stableUuid(msg.id),
      role: (msg.type === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
      content: extractText(msg.content),
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
 * Generate a stable UUID from a Gemini message ID.
 * Ensures the same message always gets the same UUID for cursor pagination.
 */
function stableUuid(messageId: string): string {
  const hash = crypto.createHash('sha256').update(messageId).digest('hex');
  // Format as UUID v4-like: xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
