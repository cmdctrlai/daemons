/**
 * The session list the daemon reports: every session it has a record of, and
 * every session the agent lists itself when it supports `session/list` – which
 * is how sessions started in the agent's own UI reach the app.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionInfo } from '@cmdctrl/daemon-sdk';
import type { AcpSessionInfo } from './acp/types';
import { TranscriptStore, type SessionRecord } from './transcript';

const MAX_REPORTED = 200;
const PREVIEW_CHARS = 200;

export function reportedSessions(
  records: SessionRecord[],
  listed: AcpSessionInfo[],
  isBusy: (sessionId: string) => boolean,
): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const s of listed) {
    if (!s?.sessionId) continue;
    byId.set(s.sessionId, info(s.sessionId, s.cwd ?? '', s.title ?? '', s.updatedAt ?? '', '', 0));
  }
  for (const record of records) {
    const agentSide = byId.get(record.sessionId);
    const lastAgent = [...record.entries].reverse().find((e) => e.role === 'AGENT')?.content ?? '';
    const activity = [agentSide?.last_activity, record.updatedAt].filter(Boolean).sort().pop() ?? '';
    byId.set(record.sessionId, info(
      record.sessionId,
      record.cwd || agentSide?.project || '',
      record.title || agentSide?.title || TranscriptStore.titleOf(record),
      activity,
      lastAgent,
      record.entries.length,
    ));
  }
  return [...byId.values()]
    .map((s) => (isBusy(s.session_id) ? { ...s, is_active: true } : s))
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity))
    .slice(0, MAX_REPORTED);
}

function info(sessionId: string, cwd: string, title: string, lastActivity: string, lastMessage: string, count: number): SessionInfo {
  return {
    session_id: sessionId,
    slug: sessionId.slice(0, 8),
    title: title || sessionId.slice(0, 8),
    project: cwd,
    project_name: cwd ? path.basename(cwd) : '',
    file_path: '',
    last_message: lastMessage.slice(0, PREVIEW_CHARS),
    last_activity: lastActivity || new Date(0).toISOString(),
    is_active: false,
    message_count: count,
  };
}

/**
 * The working directory for a new session: the project the app named, or the
 * home directory when it named none. ACP needs an absolute path that exists.
 * It is the real path: an agent's own CLI files sessions under the folder it
 * resolves (macOS's /tmp is /private/tmp), so a symlinked path would put the
 * app's sessions where the agent's terminal never looks.
 */
export function projectDir(projectPath: string | undefined): string {
  if (!projectPath) return os.homedir();
  const resolved = path.resolve(projectPath.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project folder not found on this machine: ${projectPath}`);
  }
  return fs.realpathSync(resolved);
}

/**
 * The session a task_start really continues, if any. The server starts a new
 * session under a `PENDING-` id; it also sends task_start, under the session's
 * real id, for the first message to a session it holds no messages for – one the
 * agent listed, or one created here that the user answered within seconds. Those
 * continue the named session.
 */
export function continuedSession(taskId: string): string | undefined {
  const native = taskId.split(':').slice(2).join(':');
  return native && !native.startsWith('PENDING-') ? native : undefined;
}
