import * as fs from 'fs';
import * as path from 'path';
import { VSCODE_WORKSPACE_STORAGE, getWorkspaceStorageDirs } from './config/config';

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

interface RawChatSession {
  sessionId: string;
  customTitle?: string;
  creationDate: number;
  lastMessageDate: number;
  requests: Array<{
    message: {
      text: string;
    };
    response: Array<{
      value?: string;
    }>;
  }>;
}

/**
 * Discover all Copilot Chat sessions from VS Code workspace storage
 */
export function discoverSessions(excludeIds: Set<string> = new Set()): ExternalSession[] {
  const sessions: ExternalSession[] = [];
  const workspaceDirs = getWorkspaceStorageDirs();

  for (const workspaceDir of workspaceDirs) {
    const chatSessionsDir = path.join(workspaceDir, 'chatSessions');

    if (!fs.existsSync(chatSessionsDir)) {
      continue;
    }

    // Get workspace info
    let workspacePath = 'unknown';
    let projectName = 'unknown';
    const workspaceFile = path.join(workspaceDir, 'workspace.json');
    if (fs.existsSync(workspaceFile)) {
      try {
        const content = fs.readFileSync(workspaceFile, 'utf-8');
        const data = JSON.parse(content);
        const folder = data.folder || data.workspace;
        if (folder) {
          workspacePath = folder.replace('file://', '');
          projectName = path.basename(workspacePath);
        }
      } catch {
        // Ignore
      }
    }

    // Read all session JSON files
    const sessionFiles = fs.readdirSync(chatSessionsDir)
      .filter(f => f.endsWith('.json'));

    for (const sessionFile of sessionFiles) {
      const sessionPath = path.join(chatSessionsDir, sessionFile);

      try {
        const content = fs.readFileSync(sessionPath, 'utf-8');
        const raw = JSON.parse(content) as RawChatSession;

        // Skip if this session is managed by CmdCtrl
        if (excludeIds.has(raw.sessionId)) {
          continue;
        }

        // Get last message
        let lastMessage = '';
        if (raw.requests.length > 0) {
          const lastRequest = raw.requests[raw.requests.length - 1];
          const assistantResponse = lastRequest.response
            .filter(r => r.value)
            .map(r => r.value!)
            .join('\n');
          lastMessage = assistantResponse || lastRequest.message.text;
        }

        // Create slug from title or session ID
        const title = raw.customTitle || `Chat ${raw.sessionId.substring(0, 8)}`;
        const slug = title.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 50);

        // Check if recently active (within last hour)
        const lastActivity = new Date(raw.lastMessageDate);
        const isActive = Date.now() - raw.lastMessageDate < 3600000;

        sessions.push({
          session_id: raw.sessionId,
          slug,
          title,
          project: workspacePath,
          project_name: projectName,
          file_path: sessionPath,
          last_message: lastMessage.substring(0, 200),
          last_activity: lastActivity.toISOString(),
          is_active: isActive,
          message_count: raw.requests.length,
        });
      } catch {
        // Skip invalid session files
      }
    }
  }

  // Sort by last activity (most recent first)
  sessions.sort((a, b) =>
    new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
  );

  return sessions;
}
