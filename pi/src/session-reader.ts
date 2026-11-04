/**
 * Session access for the pi family.
 *
 * The agent owns session storage (`~/.pi/agent/sessions/` for pi, `~/.omp/agent/sessions/`
 * for omp). We read through `session-source.ts` – pi's own SessionManager for pi – so
 * sessions created here show up in the agent's `--resume` unchanged.
 */

import * as path from 'path';
import type { MessageEntry, SessionInfo as DaemonSessionInfo } from '@cmdctrl/daemon-sdk';
import { sessionSource, type StoredEntry, type StoredSession } from './session-source';
import type { CommandCollapser } from './command-collapse';

/**
 * Locate the on-disk path for a session id. Optional cwd narrows the scan; a miss
 * there falls back to every session, because the agent buckets by the canonical
 * cwd and a project path reached through a symlink names a different bucket.
 */
export async function resolveSessionPath(
  sessionId: string,
  cwd?: string
): Promise<StoredSession | undefined> {
  const source = sessionSource();
  const scoped = cwd ? (await source.list(cwd)).find(s => s.id === sessionId) : undefined;
  return scoped ?? (await source.list()).find(s => s.id === sessionId);
}

/**
 * Read CmdCtrl-visible messages (user prompts + assistant text) for a session.
 * Tool calls and tool results are deliberately excluded – they surface live as
 * progress events during task runs and aren't part of the chat transcript.
 */
export async function readMessages(
  sessionId: string,
  opts: {
    cwd?: string;
    limit: number;
    beforeUuid?: string;
    afterUuid?: string;
    /** Puts `/name args` back in place of a command pi already expanded. */
    collapser?: CommandCollapser;
  }
): Promise<{
  messages: MessageEntry[];
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
}> {
  const info = await resolveSessionPath(sessionId, opts.cwd);
  if (!info) return { messages: [], hasMore: false };

  let mapped = (await sessionSource().entries(info.path))
    .filter(isMessage)
    .map(entry => toMessageEntry(entry, opts.collapser))
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

/**
 * SDK-shaped list of sessions for setSessionsProvider / report_sessions.
 *
 * Every session listed is one a person started. pi has no child or subtask
 * session at all; omp's subagents write their transcripts inside the parent
 * session's artifact directory, which the listing does not descend into. Forks are
 * deliberately kept: a fork is a branch the user made in the TUI, not machinery.
 */
export async function listReportedSessions(
  collapser?: CommandCollapser
): Promise<DaemonSessionInfo[]> {
  const all = await sessionSource().list();
  return all.map(info => {
    // firstMessage is the raw stored text, so a session opened with a command
    // would otherwise be titled with the command's whole expansion.
    const first = info.firstMessage || '';
    const preview = (first && collapser?.collapse(first)) || first;
    return {
      session_id: info.id,
      slug: info.id.slice(0, 8),
      title: info.name || preview,
      project: info.cwd,
      project_name: info.cwd ? path.basename(info.cwd) : '',
      file_path: info.path,
      last_message: preview,
      last_activity: info.modified.toISOString(),
      is_active: false,
      message_count: info.messageCount,
    };
  });
}

function isMessage(entry: StoredEntry): boolean {
  return entry.type === 'message';
}

function toMessageEntry(
  entry: StoredEntry,
  collapser?: CommandCollapser
): MessageEntry | null {
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
    // A user "message" that is really an expanded command reads as the command
    // again, so the app can render it the way it renders one.
    content: (mapped === 'USER' && collapser?.collapse(text)) || text,
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
