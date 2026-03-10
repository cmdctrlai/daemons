import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { VSCODE_WORKSPACE_STORAGE, getWorkspaceStorageDirs } from '../config/config';
import { EventEmitter } from 'events';

/**
 * Message structure from VS Code Copilot Chat JSON
 */
export interface ChatMessage {
  requestId: string;
  text: string;
  response: string;
  thinkingContent?: string;
  timestamp: number;
  modelId: string;
}

/**
 * Session structure from VS Code Copilot Chat JSON
 */
export interface CopilotSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  creationDate: number;
  lastMessageDate: number;
  messages: ChatMessage[];
}

/**
 * Raw structure from VS Code chat session JSON files
 */
interface RawChatSession {
  sessionId: string;
  customTitle?: string;
  creationDate: number;
  lastMessageDate: number;
  requests: Array<{
    requestId: string;
    message: {
      text: string;
    };
    response: Array<{
      kind?: string;
      value?: string;
    }>;
    timestamp: number;
    modelId?: string;
  }>;
}

/**
 * Watches VS Code workspace storage for Copilot Chat session changes
 */
export class SessionWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private sessionCache = new Map<string, CopilotSession>();
  private workspaceMap = new Map<string, string>(); // workspaceHash -> workspacePath

  constructor() {
    super();
  }

  /**
   * Start watching for session changes
   */
  async start(): Promise<void> {
    // Build initial workspace map
    await this.buildWorkspaceMap();

    // Watch the workspace storage directory for chatSession JSON files
    const pattern = path.join(VSCODE_WORKSPACE_STORAGE, '*/chatSessions/*.json');

    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath) => this.handleSessionFile(filePath, 'add'));
    this.watcher.on('change', (filePath) => this.handleSessionFile(filePath, 'change'));
    this.watcher.on('unlink', (filePath) => this.handleSessionRemoved(filePath));
    this.watcher.on('error', (error) => this.emit('error', error));

    console.log('[SessionWatcher] Started watching for Copilot Chat sessions');
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.sessionCache.clear();
    console.log('[SessionWatcher] Stopped');
  }

  /**
   * Get all known sessions
   */
  getSessions(): CopilotSession[] {
    return Array.from(this.sessionCache.values());
  }

  /**
   * Get a specific session by ID
   */
  getSession(sessionId: string): CopilotSession | undefined {
    return this.sessionCache.get(sessionId);
  }

  /**
   * Build map of workspace hashes to workspace paths
   */
  private async buildWorkspaceMap(): Promise<void> {
    const dirs = getWorkspaceStorageDirs();
    for (const dir of dirs) {
      const workspaceFile = path.join(dir, 'workspace.json');
      if (fs.existsSync(workspaceFile)) {
        try {
          const content = fs.readFileSync(workspaceFile, 'utf-8');
          const data = JSON.parse(content);
          const folder = data.folder || data.workspace;
          if (folder) {
            const hash = path.basename(dir);
            // Convert file:// URI to path
            const workspacePath = folder.replace('file://', '');
            this.workspaceMap.set(hash, workspacePath);
          }
        } catch {
          // Ignore invalid workspace files
        }
      }
    }
  }

  /**
   * Handle a session file being added or changed
   */
  private async handleSessionFile(filePath: string, event: 'add' | 'change'): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = JSON.parse(content) as RawChatSession;

      // Get workspace path from directory structure
      const parts = filePath.split(path.sep);
      const workspaceStorageIndex = parts.findIndex(p => p === 'workspaceStorage');
      const workspaceHash = parts[workspaceStorageIndex + 1];
      const workspacePath = this.workspaceMap.get(workspaceHash) || 'unknown';

      // Convert to our session format
      const session: CopilotSession = {
        sessionId: raw.sessionId,
        title: raw.customTitle || 'Copilot Chat',
        workspacePath,
        creationDate: raw.creationDate,
        lastMessageDate: raw.lastMessageDate,
        messages: raw.requests.map(req => ({
          requestId: req.requestId,
          text: req.message.text,
          response: req.response
            .filter(r => r.value && !r.kind)
            .map(r => r.value!)
            .join('\n'),
          thinkingContent: req.response
            .filter(r => r.kind === 'thinking' && r.value)
            .map(r => r.value!)
            .join('\n') || undefined,
          timestamp: req.timestamp,
          modelId: req.modelId || 'unknown',
        })),
      };

      const previousSession = this.sessionCache.get(session.sessionId);
      this.sessionCache.set(session.sessionId, session);

      if (event === 'add') {
        this.emit('session:discovered', session);
      } else if (previousSession) {
        // New messages (new requestId) or existing messages that received a response
        const changedMessages = session.messages.filter(m => {
          const prev = previousSession.messages.find(pm => pm.requestId === m.requestId);
          if (!prev) return true; // New message
          return !prev.response && !!m.response; // Response filled in
        });
        if (changedMessages.length > 0) {
          this.emit('session:updated', session, changedMessages);
        }
      }
    } catch (err) {
      console.error(`[SessionWatcher] Error parsing session file ${filePath}:`, err);
    }
  }

  /**
   * Handle a session file being removed
   */
  private handleSessionRemoved(filePath: string): void {
    // Extract session ID from filename
    const sessionId = path.basename(filePath, '.json');
    const session = this.sessionCache.get(sessionId);
    if (session) {
      this.sessionCache.delete(sessionId);
      this.emit('session:removed', session);
    }
  }
}

// Singleton instance
let watcherInstance: SessionWatcher | null = null;

export function getSessionWatcher(): SessionWatcher {
  if (!watcherInstance) {
    watcherInstance = new SessionWatcher();
  }
  return watcherInstance;
}
