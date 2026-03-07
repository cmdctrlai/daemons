import { getCursorDB, ComposerInfo } from './adapter/cursor-db';

export interface ExternalSession {
  session_id: string;
  slug: string;
  title: string;
  project: string;
  project_name: string;
  file_path: string; // For Cursor, this is the DB path
  last_message: string;
  last_activity: string;
  is_active: boolean;
  message_count: number;
}

/**
 * Discover Cursor IDE sessions from the SQLite database
 * Returns sessions in a format compatible with CmdCtrl's external session API
 */
export function discoverSessions(excludeSessionIds: Set<string> = new Set()): ExternalSession[] {
  const cursorDb = getCursorDB();
  const composers = cursorDb.getComposers();
  const sessions: ExternalSession[] = [];

  const now = Date.now();
  const ACTIVE_THRESHOLD = 30 * 1000; // 30 seconds

  for (const composer of composers) {
    // Skip excluded sessions (managed by CmdCtrl)
    if (excludeSessionIds.has(composer.composerId)) {
      continue;
    }

    // Use composer metadata directly for discovery (avoid expensive per-session queries)
    // The detailed info (message count, last message preview) can be fetched on-demand
    const lastActivity = new Date(composer.lastUpdatedAt).toISOString();
    const isActive = (now - composer.lastUpdatedAt) < ACTIVE_THRESHOLD;

    // Generate a slug from the composer name
    const slug = generateSlug(composer.name);

    // Use project path if available, otherwise empty (frontend can show device name)
    const project = composer.projectPath || '';

    sessions.push({
      session_id: composer.composerId,
      slug,
      title: composer.name || 'Untitled',
      project,
      project_name: project ? project.split('/').pop() || 'cursor' : 'cursor',
      file_path: 'state.vscdb', // Reference to SQLite
      last_message: '', // Fetched on-demand when viewing session
      last_activity: lastActivity,
      is_active: isActive,
      message_count: 0, // Fetched on-demand when viewing session
    });
  }

  // Sort by last activity (newest first)
  return sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );
}

/**
 * Generate a URL-friendly slug from a title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);
}

/**
 * Get details for a specific session
 */
export function getSessionDetails(sessionId: string): ExternalSession | null {
  const cursorDb = getCursorDB();
  const composers = cursorDb.getComposers();
  const composer = composers.find(c => c.composerId === sessionId);

  if (!composer) {
    return null;
  }

  const messageCount = cursorDb.getBubbleCount(sessionId);
  const latestBubble = cursorDb.getLatestBubble(sessionId);
  const lastMessage = latestBubble?.text?.substring(0, 100) || '';
  const lastActivity = latestBubble?.createdAt || new Date(composer.lastUpdatedAt).toISOString();

  const now = Date.now();
  const ACTIVE_THRESHOLD = 30 * 1000;
  const lastUpdateTime = latestBubble
    ? new Date(latestBubble.createdAt).getTime()
    : composer.lastUpdatedAt;
  const isActive = (now - lastUpdateTime) < ACTIVE_THRESHOLD;

  const project = composer.projectPath || '';

  return {
    session_id: composer.composerId,
    slug: generateSlug(composer.name),
    title: composer.name || 'Untitled',
    project,
    project_name: project ? project.split('/').pop() || 'cursor' : 'cursor',
    file_path: 'state.vscdb',
    last_message: lastMessage,
    last_activity: lastActivity,
    is_active: isActive,
    message_count: messageCount,
  };
}
