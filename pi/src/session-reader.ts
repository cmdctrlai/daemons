/**
 * Session access backed by pi's own SessionManager.
 *
 * Pi owns session storage (`~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`).
 * We read via its public API – no path math, no JSONL parsing. Sessions
 * created here show up in `pi --resume` unchanged.
 */

import * as path from 'path';
import type {
  SessionInfo as PiSessionInfo,
  SessionEntry,
  SessionMessageEntry,
} from '@mariozechner/pi-coding-agent';
import type { MessageEntry, SessionInfo as DaemonSessionInfo } from '@cmdctrl/daemon-sdk';
import { piSdk } from './pi-sdk';

/** Locate the on-disk path for a pi session id. Optional cwd narrows the scan. */
export async function resolveSessionPath(
  piSessionId: string,
  cwd?: string
): Promise<PiSessionInfo | undefined> {
  const { SessionManager } = await piSdk();
  const candidates = cwd
    ? await SessionManager.list(cwd)
    : await SessionManager.listAll();
  return candidates.find(s => s.id === piSessionId);
}

/**
 * Read CmdCtrl-visible messages (user prompts + assistant text) for a session.
 * Tool calls and tool results are deliberately excluded – they surface live as
 * progress events during task runs and aren't part of the chat transcript.
 */
export async function readMessages(
  piSessionId: string,
  opts: { cwd?: string; limit: number; beforeUuid?: string; afterUuid?: string }
): Promise<{
  messages: MessageEntry[];
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
}> {
  const info = await resolveSessionPath(piSessionId, opts.cwd);
  if (!info) return { messages: [], hasMore: false };

  const { SessionManager, CURRENT_SESSION_VERSION, VERSION: PI_SDK_VERSION } = await piSdk();
  const mgr = SessionManager.open(info.path);
  const header = mgr.getHeader();
  if (header?.version != null && header.version > CURRENT_SESSION_VERSION) {
    throw new Error(
      `pi session ${piSessionId} was written with file-format v${header.version}; ` +
        `this daemon bundles pi SDK ${PI_SDK_VERSION} (reads up to v${CURRENT_SESSION_VERSION}). ` +
        `Upgrade @cmdctrl/pi.`
    );
  }

  let mapped = mgr
    .getEntries()
    .filter(isMessage)
    .map(toMessageEntry)
    .filter((m): m is MessageEntry => m !== null);

  if (opts.beforeUuid) {
    const idx = mapped.findIndex(m => m.uuid === opts.beforeUuid);
    if (idx > 0) mapped = mapped.slice(0, idx);
  }
  if (opts.afterUuid) {
    const idx = mapped.findIndex(m => m.uuid === opts.afterUuid);
    if (idx >= 0) mapped = mapped.slice(idx + 1);
  }

  const hasMore = mapped.length > opts.limit;
  const limited = mapped.slice(-opts.limit);
  return {
    messages: limited,
    hasMore,
    oldestUuid: limited[0]?.uuid,
    newestUuid: limited[limited.length - 1]?.uuid,
  };
}

/** SDK-shaped list of sessions for setSessionsProvider / report_sessions. */
export async function listReportedSessions(): Promise<DaemonSessionInfo[]> {
  const { SessionManager } = await piSdk();
  const all = await SessionManager.listAll();
  return all.map(info => ({
    session_id: info.id,
    slug: info.id.slice(0, 8),
    title: info.name || info.firstMessage || '',
    project: info.cwd,
    project_name: info.cwd ? path.basename(info.cwd) : '',
    file_path: info.path,
    last_message: info.firstMessage || '',
    last_activity: info.modified.toISOString(),
    is_active: false,
    message_count: info.messageCount,
  }));
}

function isMessage(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message';
}

function toMessageEntry(entry: SessionMessageEntry): MessageEntry | null {
  const msg: any = entry.message;
  const role = msg?.role;
  let mapped: 'USER' | 'AGENT';
  if (role === 'user') mapped = 'USER';
  else if (role === 'assistant') mapped = 'AGENT';
  else return null;

  const text = extractText(msg.content);
  if (!text.trim()) return null;

  return {
    uuid: entry.id,
    role: mapped,
    content: text,
    timestamp: entry.timestamp,
  };
}

function extractText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}
