import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { CURSOR_GLOBAL_STORAGE, CURSOR_WORKSPACE_STORAGE } from '../config/config';

export interface ComposerInfo {
  composerId: string;
  name: string;
  createdAt: number;
  lastUpdatedAt: number;
  unifiedMode: string;
  contextUsagePercent: number;
  projectPath?: string; // Extracted from file context
}

export interface ComposerData {
  allComposers: ComposerInfo[];
  fullConversationHeadersOnly?: Array<{
    bubbleId: string;
    type: number; // 1 = user, 2 = assistant
  }>;
}

export interface BubbleData {
  _v: number;
  type: number; // 1 = user, 2 = assistant
  bubbleId: string;
  text: string;
  createdAt: string;
  tokenCount?: {
    inputTokens: number;
    outputTokens: number;
  };
  toolResults?: unknown[];
  codebaseContextChunks?: unknown[];
  allThinkingBlocks?: unknown[];
}

export interface MessageEntry {
  uuid: string;
  role: 'USER' | 'AGENT';
  content: string;
  timestamp: string;
}

/**
 * Cursor SQLite Database Reader
 * Reads conversation data from Cursor's local storage
 */
export class CursorDB {
  private globalDb: Database.Database | null = null;
  private lastOpenAttempt = 0;
  private lastRefresh = 0;
  private readonly RETRY_INTERVAL = 5000; // 5 seconds between retries
  private readonly REFRESH_INTERVAL = 2000; // 2s - refresh connection to see WAL updates

  /**
   * Check if the Cursor database exists
   */
  static exists(): boolean {
    return fs.existsSync(CURSOR_GLOBAL_STORAGE);
  }

  /**
   * Open the global storage database (read-only)
   * Periodically refreshes the connection to see WAL updates from Cursor
   */
  private openGlobalDb(): Database.Database | null {
    const now = Date.now();

    // If we have a connection but it's stale, refresh it to see WAL updates
    if (this.globalDb && now - this.lastRefresh > this.REFRESH_INTERVAL) {
      this.globalDb.close();
      this.globalDb = null;
      // Reset lastOpenAttempt so we don't hit the retry cooldown after refresh
      this.lastOpenAttempt = 0;
    }

    if (this.globalDb) {
      return this.globalDb;
    }

    // Don't retry too frequently after FAILED open attempts (not refreshes)
    if (this.lastOpenAttempt > 0 && now - this.lastOpenAttempt < this.RETRY_INTERVAL) {
      return null;
    }

    if (!CursorDB.exists()) {
      console.warn('[CursorDB] Database not found:', CURSOR_GLOBAL_STORAGE);
      return null;
    }

    try {
      this.globalDb = new Database(CURSOR_GLOBAL_STORAGE, {
        readonly: true,
        fileMustExist: true,
      });
      // Force WAL checkpoint to see latest changes
      try {
        this.globalDb.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // Checkpoint may fail on readonly, that's ok
      }
      this.lastRefresh = now;
      this.lastOpenAttempt = now;
      return this.globalDb;
    } catch (err) {
      console.error('[CursorDB] Failed to open database:', err);
      return null;
    }
  }

  /**
   * Close database connections
   */
  close(): void {
    if (this.globalDb) {
      this.globalDb.close();
      this.globalDb = null;
    }
  }

  /**
   * Extract project path from composer context
   * Looks at fileSelections and folderSelections for path info
   */
  private extractProjectPath(context: unknown): string | undefined {
    if (!context || typeof context !== 'object') {
      return undefined;
    }

    const ctx = context as Record<string, unknown>;

    // Try folderSelections first
    const folderSelections = ctx.folderSelections as Array<{ uri?: { fsPath?: string } }> | undefined;
    if (folderSelections?.length) {
      const firstFolder = folderSelections[0]?.uri?.fsPath;
      if (firstFolder) {
        return firstFolder;
      }
    }

    // Try fileSelections - extract directory from first file
    const fileSelections = ctx.fileSelections as Array<{ uri?: { fsPath?: string } }> | undefined;
    if (fileSelections?.length) {
      const firstFile = fileSelections[0]?.uri?.fsPath;
      if (firstFile) {
        // Find a reasonable project root (go up to find common patterns)
        return this.findProjectRoot(firstFile);
      }
    }

    return undefined;
  }

  /**
   * Find project root from a file path
   * Looks for common project markers (package.json, .git, go.mod, etc.)
   */
  private findProjectRoot(filePath: string): string {
    let dir = path.dirname(filePath);
    const markers = ['package.json', '.git', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml'];

    // Walk up max 10 levels
    for (let i = 0; i < 10 && dir !== '/'; i++) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(dir, marker))) {
          return dir;
        }
      }
      dir = path.dirname(dir);
    }

    // If no marker found, return the parent of the file
    return path.dirname(filePath);
  }

  /**
   * Get all composers (conversation sessions)
   */
  getComposers(): ComposerInfo[] {
    const db = this.openGlobalDb();
    if (!db) return [];

    try {
      const stmt = db.prepare(`
        SELECT key, value FROM cursorDiskKV
        WHERE key LIKE 'composerData:%'
      `);
      const rows = stmt.all() as Array<{ key: string; value: string | Buffer }>;

      const allComposers: ComposerInfo[] = [];
      for (const row of rows) {
        try {
          const valueStr = typeof row.value === 'string'
            ? row.value
            : row.value.toString('utf-8');
          const data = JSON.parse(valueStr);

          // Each composerData:* key contains ONE composer directly
          // Format: { _v, composerId, name, createdAt, lastUpdatedAt, context, ... }
          if (data.composerId) {
            const composerId = data.composerId;
            const createdAt = data.createdAt || Date.now();

            // Use lastUpdatedAt if present, otherwise fall back to createdAt
            const lastUpdatedAt = data.lastUpdatedAt || createdAt;

            // Try to extract project path from file context
            const projectPath = this.extractProjectPath(data.context);

            allComposers.push({
              composerId,
              name: data.name || 'Untitled Session',
              createdAt,
              lastUpdatedAt,
              unifiedMode: data.unifiedMode || 'unknown',
              contextUsagePercent: data.contextUsagePercent || 0,
              projectPath,
            });
          }
        } catch {
          // Skip malformed entries
        }
      }

      return allComposers.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    } catch (err) {
      console.error('[CursorDB] Error getting composers:', err);
      return [];
    }
  }

  /**
   * Get composer data including conversation headers
   */
  getComposerData(composerId: string): ComposerData | null {
    const db = this.openGlobalDb();
    if (!db) return null;

    try {
      const stmt = db.prepare(`
        SELECT value FROM cursorDiskKV
        WHERE key = ?
      `);
      const row = stmt.get(`composerData:${composerId}`) as { value: string | Buffer } | undefined;

      if (!row) return null;

      const valueStr = typeof row.value === 'string'
        ? row.value
        : row.value.toString('utf-8');
      return JSON.parse(valueStr) as ComposerData;
    } catch (err) {
      console.error('[CursorDB] Error getting composer data:', err);
      return null;
    }
  }

  /**
   * Get all bubbles (messages) for a composer
   */
  getBubbles(composerId: string): BubbleData[] {
    const db = this.openGlobalDb();
    if (!db) return [];

    try {
      const stmt = db.prepare(`
        SELECT key, value FROM cursorDiskKV
        WHERE key LIKE ?
      `);
      const pattern = `bubbleId:${composerId}:%`;
      const rows = stmt.all(pattern) as Array<{ key: string; value: string | Buffer }>;

      const bubbles: BubbleData[] = [];
      for (const row of rows) {
        try {
          const valueStr = typeof row.value === 'string'
            ? row.value
            : row.value.toString('utf-8');
          const bubble = JSON.parse(valueStr) as BubbleData;
          bubbles.push(bubble);
        } catch {
          // Skip malformed entries
        }
      }

      // Sort by creation time
      return bubbles.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } catch (err) {
      console.error('[CursorDB] Error getting bubbles:', err);
      return [];
    }
  }

  /**
   * Get the latest bubble for a composer (optimized - uses SQL sorting)
   */
  getLatestBubble(composerId: string): BubbleData | null {
    const db = this.openGlobalDb();
    if (!db) return null;

    try {
      // Use json_extract to sort by createdAt directly in SQL
      const stmt = db.prepare(`
        SELECT key, value FROM cursorDiskKV
        WHERE key LIKE ?
        ORDER BY json_extract(value, '$.createdAt') DESC
        LIMIT 1
      `);
      const pattern = `bubbleId:${composerId}:%`;
      const row = stmt.get(pattern) as { key: string; value: string | Buffer | null } | undefined;

      if (!row || !row.value) return null;

      const valueStr = typeof row.value === 'string'
        ? row.value
        : row.value.toString('utf-8');
      return JSON.parse(valueStr) as BubbleData;
    } catch (err) {
      console.error('[CursorDB] Error getting latest bubble:', err);
      return null;
    }
  }

  /**
   * Get messages for a session in a format compatible with CmdCtrl API
   * @param composerId The composer/session ID
   * @param limit Maximum number of messages to return
   * @param beforeUuid Return messages before this UUID (for backward pagination)
   * @param afterUuid Return messages after this UUID (for incremental/forward fetches)
   */
  getMessages(composerId: string, limit = 30, beforeUuid?: string, afterUuid?: string): {
    messages: MessageEntry[];
    hasMore: boolean;
    oldestUuid?: string;
    newestUuid?: string;
  } {
    const bubbles = this.getBubbles(composerId);

    // Handle afterUuid for incremental fetches (messages AFTER the given UUID)
    if (afterUuid) {
      const afterIdx = bubbles.findIndex(b => b.bubbleId === afterUuid);
      if (afterIdx !== -1) {
        // Get all bubbles after the cursor
        const rawSlice = bubbles.slice(afterIdx + 1, afterIdx + 1 + limit);

        // Filter out empty bubbles - Cursor creates entries BEFORE populating text
        const slice = rawSlice.filter(b => b.text && b.text.trim().length > 0);

        const messages: MessageEntry[] = slice.map(b => ({
          uuid: b.bubbleId,
          role: b.type === 1 ? 'USER' : 'AGENT',
          content: b.text || '',
          timestamp: b.createdAt,
        }));

        return {
          messages,
          hasMore: afterIdx + 1 + limit < bubbles.length,
          oldestUuid: slice.length > 0 ? slice[0].bubbleId : undefined,
          newestUuid: slice.length > 0 ? slice[slice.length - 1].bubbleId : undefined,
        };
      }
      // If afterUuid not found, fall through to return all messages
    }

    // Handle beforeUuid for backward pagination
    let startIndex = bubbles.length;
    if (beforeUuid) {
      const idx = bubbles.findIndex(b => b.bubbleId === beforeUuid);
      if (idx !== -1) {
        startIndex = idx;
      }
    }

    // Get messages before the cursor, limited to `limit`
    // Filter out empty bubbles (Cursor creates entries before text is populated)
    const startFrom = Math.max(0, startIndex - limit);
    const slice = bubbles
      .slice(startFrom, startIndex)
      .filter(b => b.text && b.text.trim().length > 0);

    const messages: MessageEntry[] = slice.map(b => ({
      uuid: b.bubbleId,
      role: b.type === 1 ? 'USER' : 'AGENT',
      content: b.text || '',
      timestamp: b.createdAt,
    }));

    // Return oldest-first (chronological order) to match Claude Code daemon
    return {
      messages,
      hasMore: startFrom > 0,
      oldestUuid: slice.length > 0 ? slice[0].bubbleId : undefined,
      newestUuid: slice.length > 0 ? slice[slice.length - 1].bubbleId : undefined,
    };
  }

  /**
   * Get the count of bubbles for a composer
   */
  getBubbleCount(composerId: string): number {
    const db = this.openGlobalDb();
    if (!db) return 0;

    try {
      const stmt = db.prepare(`
        SELECT COUNT(*) as count FROM cursorDiskKV
        WHERE key LIKE ?
      `);
      const pattern = `bubbleId:${composerId}:%`;
      const row = stmt.get(pattern) as { count: number };
      return row.count;
    } catch (err) {
      console.error('[CursorDB] Error counting bubbles:', err);
      return 0;
    }
  }

  /**
   * Get workspace storage paths that contain state.vscdb files
   */
  getWorkspaceStoragePaths(): string[] {
    const paths: string[] = [];
    if (!fs.existsSync(CURSOR_WORKSPACE_STORAGE)) {
      return paths;
    }

    try {
      const entries = fs.readdirSync(CURSOR_WORKSPACE_STORAGE);
      for (const entry of entries) {
        const dbPath = path.join(CURSOR_WORKSPACE_STORAGE, entry, 'state.vscdb');
        if (fs.existsSync(dbPath)) {
          paths.push(dbPath);
        }
      }
    } catch (err) {
      console.error('[CursorDB] Error reading workspace storage:', err);
    }

    return paths;
  }

  /**
   * Try to determine the project path for a workspace storage hash
   * This is a best-effort attempt based on workspace.json if it exists
   */
  getWorkspaceProjectPath(workspaceHash: string): string | null {
    const workspaceJsonPath = path.join(
      CURSOR_WORKSPACE_STORAGE,
      workspaceHash,
      'workspace.json'
    );

    if (!fs.existsSync(workspaceJsonPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(workspaceJsonPath, 'utf-8');
      const data = JSON.parse(content);
      // workspace.json typically contains a "folder" property with the URI
      if (data.folder) {
        // Convert file:// URI to path
        return data.folder.replace('file://', '');
      }
    } catch {
      // Ignore errors
    }

    return null;
  }
}

// Singleton instance
let cursorDbInstance: CursorDB | null = null;

export function getCursorDB(): CursorDB {
  if (!cursorDbInstance) {
    cursorDbInstance = new CursorDB();
  }
  return cursorDbInstance;
}
