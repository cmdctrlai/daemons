import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const ACTIVE_THRESHOLD_MS = 30 * 1000; // 30 seconds
const TAIL_BYTES = 65536; // 64KB - only used as fallback

// Cache for sessions parsed from disk (not in index)
// Maps session_id -> { session, fileMtime }
const parsedSessionCache = new Map<string, { session: ExternalSession; fileMtime: number }>();
let lastDiscoveryTime = 0;

export interface ExternalSession {
  session_id: string;
  slug: string;
  title: string; // Generated from first user message or slug
  project: string;
  project_name: string;
  file_path: string;
  last_message: string;
  last_activity: string; // ISO timestamp
  is_active: boolean;
  message_count: number;
}

export interface ExternalSessionsByProject {
  project: string;
  project_name: string;
  sessions: ExternalSession[];
}

export interface SessionEntry {
  type: string;
  sessionId?: string;
  slug?: string;
  cwd?: string;
  timestamp?: string; // ISO timestamp of the entry
  message?: {
    role?: string;
    content?: string | any;
  };
}

/**
 * Claude Code's sessions-index.json format
 */
interface SessionsIndex {
  version: number;
  entries: SessionIndexEntry[];
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  customTitle?: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;  // Actual last message timestamp (not file mtime!)
  gitBranch?: string;
  projectPath: string;
  isSidechain: boolean;
}

/**
 * Generate a title from message content (first line, truncated)
 */
function generateTitle(message: string): string {
  if (!message) return '';
  const firstLine = message.split('\n')[0].trim();
  if (firstLine.length === 0) return '';
  if (firstLine.length <= 50) return firstLine;

  // Truncate at word boundary
  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 30) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

/**
 * Extract readable text from message content (handles string or array of content blocks)
 */
function extractReadableText(content: unknown): string {
  // Simple string
  if (typeof content === 'string') {
    return content.trim();
  }

  // Array of content blocks (Claude format)
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block && typeof block === 'object') {
        // Text block: { type: 'text', text: '...' }
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
        // Skip tool_use, tool_result, image blocks etc.
      }
    }
    return textParts.join(' ').trim();
  }

  // Object with text property
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text: unknown }).text;
    if (typeof text === 'string') {
      return text.trim();
    }
  }

  return '';
}

/**
 * Decode a project directory name to a path
 * e.g., "-Users-mrwoof-src-cmdctrl" -> "/Users/mrwoof/src/cmdctrl"
 *
 * The encoding is ambiguous: hyphens in directory names look the same as path separators.
 * e.g., "-Users-mrwoof-src-cmdctrl-admin-interface" could be:
 *   /Users/mrwoof/src/cmdctrl-admin-interface (correct - worktree)
 *   /Users/mrwoof/src/cmdctrl/admin/interface (wrong - doesn't exist)
 *
 * We solve this by trying all possible decodings and returning the one that:
 * 1. Actually exists on the filesystem
 * 2. Has the most path components (to prefer /a/b-c over /a/b/c when both exist)
 *
 * If no valid path is found, fall back to replacing all hyphens with slashes.
 */
function decodeProjectPath(dirName: string): string {
  if (!dirName || dirName.length === 0) return '';

  // Remove leading dash and split by dashes
  const parts = dirName.slice(1).split('-');
  if (parts.length === 0) return '/';

  // Generate all possible path interpretations using recursion
  const candidates: string[] = [];

  function generatePaths(index: number, currentPath: string): void {
    if (index >= parts.length) {
      candidates.push(currentPath);
      return;
    }

    // Try combining remaining parts with hyphens (longer combinations first)
    for (let end = parts.length; end > index; end--) {
      const component = parts.slice(index, end).join('-');
      const newPath = currentPath + '/' + component;
      generatePaths(end, newPath);
    }
  }

  generatePaths(0, '');

  // Find candidates that exist, preferring fewer path components (more hyphens preserved)
  // Sort by number of slashes (ascending) to prefer paths with hyphens in names
  candidates.sort((a, b) => {
    const slashesA = (a.match(/\//g) || []).length;
    const slashesB = (b.match(/\//g) || []).length;
    return slashesA - slashesB;
  });

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: replace all hyphens with slashes (original behavior)
  return '/' + parts.join('/');
}

/**
 * Extract project name from full path
 */
function projectNameFromPath(projectPath: string): string {
  return path.basename(projectPath);
}

/**
 * Discover all Claude Code sessions on this device
 *
 * Uses sessions-index.json for efficiency when available (one file read per project
 * instead of 64KB per session). Falls back to parsing individual files if index
 * is missing or stale.
 */
export async function discoverSessions(excludeSessionIDs: Set<string> = new Set()): Promise<ExternalSession[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const sessionMap = new Map<string, ExternalSession>();

  // Check if directory exists
  if (!fs.existsSync(claudeDir)) {
    return [];
  }

  // Read project directories
  const entries = fs.readdirSync(claudeDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectDir = path.join(claudeDir, entry.name);
    const projectPath = decodeProjectPath(entry.name);
    const projectName = projectNameFromPath(projectPath);

    // Try to use sessions-index.json first (much more efficient)
    const indexPath = path.join(projectDir, 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const index: SessionsIndex = JSON.parse(indexContent);

        // Track which sessions we need to re-parse due to stale index
        const staleSessionPaths: string[] = [];

        for (const indexEntry of index.entries) {
          // Skip sidechains, excluded sessions, and empty sessions
          if (indexEntry.isSidechain) continue;
          if (excludeSessionIDs.has(indexEntry.sessionId)) continue;
          if (indexEntry.messageCount === 0) continue;

          // Check if the actual file has been modified since the index was updated
          // If so, the index data is stale and we need to re-parse the file
          try {
            const stat = fs.statSync(indexEntry.fullPath);
            const actualMtimeMs = stat.mtimeMs;
            // Index fileMtime is in milliseconds
            if (actualMtimeMs > indexEntry.fileMtime + 1000) {
              // File is newer than index - mark for re-parsing
              staleSessionPaths.push(indexEntry.fullPath);
              continue;
            }
          } catch {
            // File doesn't exist or can't stat, skip
            continue;
          }

          const modifiedDate = new Date(indexEntry.modified);
          const isActive = Date.now() - modifiedDate.getTime() < ACTIVE_THRESHOLD_MS;

          // Use customTitle > summary > firstPrompt for title
          let title = indexEntry.customTitle || indexEntry.summary || '';
          if (!title && indexEntry.firstPrompt && indexEntry.firstPrompt !== 'No prompt') {
            title = generateTitle(indexEntry.firstPrompt);
          }
          if (!title) {
            title = indexEntry.sessionId.slice(0, 8);
          }

          const session: ExternalSession = {
            session_id: indexEntry.sessionId,
            slug: '',  // Not in index, but we don't really use it
            title,
            // Always use directory-derived projectPath, not indexEntry.projectPath
            // The index stores cwd at session start, which can be a subdirectory
            project: projectPath,
            project_name: projectNameFromPath(projectPath),
            file_path: indexEntry.fullPath,
            last_message: indexEntry.firstPrompt !== 'No prompt' ? generateTitle(indexEntry.firstPrompt) : '',
            last_activity: indexEntry.modified,  // This is the correct message timestamp!
            is_active: isActive,
            message_count: indexEntry.messageCount,
          };

          // Keep most recently active version
          const existing = sessionMap.get(session.session_id);
          if (!existing || new Date(session.last_activity) > new Date(existing.last_activity)) {
            sessionMap.set(session.session_id, session);
          }
        }

        // Re-parse stale sessions from index
        for (const stalePath of staleSessionPaths) {
          try {
            const session = await parseSessionFile(stalePath, projectPath, projectName);
            if (session.message_count === 0) continue;

            const existing = sessionMap.get(session.session_id);
            if (!existing || new Date(session.last_activity) > new Date(existing.last_activity)) {
              sessionMap.set(session.session_id, session);
            }
          } catch {
            // Failed to parse, skip
          }
        }

        // After processing index, check for files not in index (index can be stale)
        const indexedSessionIds = new Set(index.entries.map(e => e.sessionId));
        let missingFiles: string[];
        try {
          missingFiles = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
            .map(f => path.join(projectDir, f));
        } catch (err) {
          continue; // Can't read directory, skip
        }

        for (const jsonlPath of missingFiles) {
          const sessionId = path.basename(jsonlPath, '.jsonl');

          // Skip if already in index or excluded
          if (indexedSessionIds.has(sessionId)) continue;
          if (excludeSessionIDs.has(sessionId)) continue;

          try {
            const stat = fs.statSync(jsonlPath);
            const fileMtime = stat.mtimeMs;
            const cached = parsedSessionCache.get(sessionId);

            let session: ExternalSession;
            if (cached && cached.fileMtime === fileMtime) {
              // File unchanged, use cached session (update is_active)
              session = { ...cached.session };
              session.is_active = Date.now() - new Date(session.last_activity).getTime() < ACTIVE_THRESHOLD_MS;
            } else {
              // File is new or modified, parse it
              session = await parseSessionFile(jsonlPath, projectPath, projectName);
              if (session.message_count === 0) continue;
              parsedSessionCache.set(sessionId, { session, fileMtime });
            }

            const existing = sessionMap.get(session.session_id);
            if (!existing || new Date(session.last_activity) > new Date(existing.last_activity)) {
              sessionMap.set(session.session_id, session);
            }
          } catch (err) {
            continue; // Skip unparseable files
          }
        }
        continue; // Done with this project
      } catch (err) {
        // Index parsing failed, fall back to file parsing
        console.warn(`Failed to parse sessions-index.json in ${projectDir}, falling back to file parsing:`, err);
      }
    }

    // Fallback: parse individual .jsonl files (slower but always works)
    let jsonlFiles: string[];
    try {
      jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
        .map(f => path.join(projectDir, f));
    } catch (err) {
      console.warn(`Failed to read project directory ${projectDir}:`, err);
      continue;
    }

    for (const jsonlPath of jsonlFiles) {
      try {
        const session = await parseSessionFile(jsonlPath, projectPath, projectName);

        // Skip if excluded or no messages
        if (excludeSessionIDs.has(session.session_id)) continue;
        if (session.message_count === 0) continue;

        // Keep most recently active version
        const existing = sessionMap.get(session.session_id);
        if (!existing || new Date(session.last_activity) > new Date(existing.last_activity)) {
          sessionMap.set(session.session_id, session);
        }
      } catch (err) {
        // Skip files that can't be parsed
        continue;
      }
    }
  }

  // Convert to array and sort by last activity (most recent first)
  const sessions = Array.from(sessionMap.values());
  sessions.sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());

  return sessions;
}

/**
 * Parse a session JSONL file to extract metadata
 */
async function parseSessionFile(filePath: string, projectPath: string, projectName: string): Promise<ExternalSession> {
  const stat = fs.statSync(filePath);
  const lastActivity = stat.mtime;
  const isActive = Date.now() - lastActivity.getTime() < ACTIVE_THRESHOLD_MS;

  const session: ExternalSession = {
    session_id: '',
    slug: '',
    title: '',
    project: projectPath,
    project_name: projectName,
    file_path: filePath,
    last_message: '',
    last_activity: lastActivity.toISOString(),
    is_active: isActive,
    message_count: 0,
  };

  // Read the tail of the file
  const fileSize = stat.size;
  const fd = fs.openSync(filePath, 'r');

  try {
    const seekPos = Math.max(0, fileSize - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, fileSize));
    fs.readSync(fd, buffer, 0, buffer.length, seekPos);

    let content = buffer.toString('utf-8');

    // If we seeked into middle, skip first partial line
    if (seekPos > 0) {
      const newlineIdx = content.indexOf('\n');
      if (newlineIdx >= 0) {
        content = content.slice(newlineIdx + 1);
      }
    }

    const lines = content.split('\n').filter(l => l.trim());
    let firstUserMessage = '';
    let lastUserMessage = '';
    let messageCount = 0;
    let foundSessionId = false;
    let foundSlug = false;
    let lastMessageTimestamp = ''; // Track actual last message timestamp

    for (const line of lines) {
      try {
        const entry: SessionEntry = JSON.parse(line);

        // Extract session ID and slug
        if (!foundSessionId && entry.sessionId) {
          session.session_id = entry.sessionId;
          foundSessionId = true;
        }
        if (!foundSlug && entry.slug) {
          session.slug = entry.slug;
          foundSlug = true;
        }
        // NOTE: Do NOT override project with entry.cwd - the project path must come from
        // the directory where the session file is stored, not from cwd in JSONL entries.
        // The cwd can change during a session (e.g., when Claude changes to a subdirectory),
        // but the session file stays in its original project directory.

        // Count messages and track last message timestamp
        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++;
          // Track timestamp of actual user/assistant messages (not system messages)
          if (entry.timestamp) {
            lastMessageTimestamp = entry.timestamp;
          }
        }

        // Track first and last user messages (extract readable text only)
        if (entry.type === 'user' && entry.message?.content) {
          const text = extractReadableText(entry.message.content);
          if (text) {
            if (!firstUserMessage) {
              firstUserMessage = text;
            }
            lastUserMessage = text;
          }
        }
      } catch {
        continue;
      }
    }

    // Use actual last message timestamp if available, otherwise fall back to file mtime
    if (lastMessageTimestamp) {
      session.last_activity = lastMessageTimestamp;
      session.is_active = Date.now() - new Date(lastMessageTimestamp).getTime() < ACTIVE_THRESHOLD_MS;
    }

    session.message_count = messageCount;

    // Fallback session ID from filename
    if (!session.session_id) {
      session.session_id = path.basename(filePath, '.jsonl');
    }

    // Generate title from first user message, falling back to slug then session ID
    if (firstUserMessage) {
      session.title = generateTitle(firstUserMessage);
    }
    if (!session.title && session.slug) {
      session.title = session.slug;
    }
    if (!session.title) {
      session.title = session.session_id.slice(0, 8);
    }

    // Truncate last message for preview
    if (lastUserMessage.length > 100) {
      session.last_message = lastUserMessage.slice(0, 100) + '...';
    } else {
      session.last_message = lastUserMessage;
    }

  } finally {
    fs.closeSync(fd);
  }

  return session;
}

/**
 * Group sessions by project
 */
export function groupByProject(sessions: ExternalSession[]): ExternalSessionsByProject[] {
  const projectMap = new Map<string, ExternalSessionsByProject>();
  const projectOrder: string[] = [];

  for (const session of sessions) {
    if (!projectMap.has(session.project)) {
      projectMap.set(session.project, {
        project: session.project,
        project_name: session.project_name,
        sessions: [],
      });
      projectOrder.push(session.project);
    }
    projectMap.get(session.project)!.sessions.push(session);
  }

  return projectOrder.map(p => projectMap.get(p)!);
}

/**
 * Discover projects (directories in ~/.claude/projects/)
 */
export function discoverProjects(): { path: string; name: string }[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return [];
  }

  const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  const projects: { path: string; name: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectPath = decodeProjectPath(entry.name);
    const projectName = projectNameFromPath(projectPath);

    projects.push({ path: projectPath, name: projectName });
  }

  return projects;
}
