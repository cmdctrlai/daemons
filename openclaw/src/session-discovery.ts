/**
 * Discover OpenClaw sessions by walking the state directory.
 *
 * Layout (per OpenClaw docs):
 *   ~/.openclaw/agents/{agentId}/sessions.json      – index of SessionEntry
 *   ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
 *
 * The state directory can be overridden with OPENCLAW_STATE_DIR.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionInfo } from '@cmdctrl/daemon-sdk';

const ACTIVE_THRESHOLD_MS = 30_000;
const TAIL_BYTES = 65_536;

interface SessionEntry {
  sessionId: string;
  updatedAt?: string | number;
  model?: string;
  title?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

interface SessionsIndex {
  [key: string]: SessionEntry;
}

export function openclawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
}

function agentsDir(): string {
  return path.join(openclawStateDir(), 'agents');
}

function toIso(updatedAt: string | number | undefined): string {
  if (!updatedAt) return new Date().toISOString();
  if (typeof updatedAt === 'number') return new Date(updatedAt).toISOString();
  const d = new Date(updatedAt);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Read the tail of a JSONL transcript to extract last-message text + count.
 */
function readTranscriptTail(filePath: string): { lastMessage: string; messageCount: number } {
  if (!fs.existsSync(filePath)) return { lastMessage: '', messageCount: 0 };

  const stat = fs.statSync(filePath);
  if (stat.size === 0) return { lastMessage: '', messageCount: 0 };

  const fd = fs.openSync(filePath, 'r');
  try {
    const seekPos = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    fs.readSync(fd, buf, 0, buf.length, seekPos);

    let content = buf.toString('utf-8');
    if (seekPos > 0) {
      const nl = content.indexOf('\n');
      if (nl >= 0) content = content.slice(nl + 1);
    }

    const lines = content.split('\n').filter((l) => l.trim());

    let lastMessage = '';
    let messageCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        // OpenClaw nests messages as { type: "message", message: { role, content } }
        const msg = entry.type === 'message' && entry.message && typeof entry.message === 'object'
          ? (entry.message as Record<string, unknown>)
          : null;
        const role = msg?.role as string | undefined
          || (entry.role as string | undefined);
        if (role === 'user' || role === 'assistant' || role === 'agent') {
          messageCount++;
          const content = msg?.content ?? entry.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((b: unknown) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
              .map((b: unknown) => ((b as { text?: string }).text || ''))
              .join(' ')
              .trim();
          }
          if (!text) text = (entry.text as string | undefined) || '';
          if (text) lastMessage = text;
        }
      } catch {
        continue;
      }
    }

    return { lastMessage, messageCount };
  } finally {
    fs.closeSync(fd);
  }
}

function titleFrom(message: string, fallback: string): string {
  const first = message.split('\n')[0].trim();
  if (!first) return fallback;
  if (first.length <= 50) return first;
  const cut = first.slice(0, 50);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '...';
}

/**
 * Walk `~/.openclaw/agents/{agentId}/sessions.json` across all agents
 * and return SessionInfo for each session, excluding managed IDs.
 */
export function discoverSessions(excludeIds: Set<string>): SessionInfo[] {
  const root = agentsDir();
  if (!fs.existsSync(root)) return [];

  const sessions: SessionInfo[] = [];

  let agents: fs.Dirent[];
  try {
    agents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const agent of agents) {
    if (!agent.isDirectory()) continue;

    const agentDir = path.join(root, agent.name);
    const indexPath = path.join(agentDir, 'sessions.json');
    const sessionsDir = path.join(agentDir, 'sessions');

    let index: SessionsIndex = {};
    try {
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SessionsIndex;
      }
    } catch {
      index = {};
    }

    // Track which session IDs we've already reported from the index
    const seen = new Set<string>();

    for (const [, entry] of Object.entries(index)) {
      if (!entry?.sessionId) continue;
      if (excludeIds.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);

      const filePath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
      const { lastMessage, messageCount } = readTranscriptTail(filePath);

      if (messageCount === 0 && !fs.existsSync(filePath)) continue;

      const lastActivity = toIso(entry.updatedAt);
      const isActive = Date.now() - new Date(lastActivity).getTime() < ACTIVE_THRESHOLD_MS;

      sessions.push({
        session_id: entry.sessionId,
        slug: entry.sessionId,
        title: entry.title || titleFrom(lastMessage, entry.sessionId.slice(0, 8)),
        project: '',
        project_name: agent.name,
        file_path: filePath,
        last_message: lastMessage.length > 100 ? lastMessage.slice(0, 100) + '...' : lastMessage,
        last_activity: lastActivity,
        is_active: isActive,
        message_count: messageCount,
      });
    }

    // Fall back: scan sessions/ directory for any JSONL files not in the index
    if (fs.existsSync(sessionsDir)) {
      let files: string[];
      try {
        files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        files = [];
      }

      for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        if (seen.has(sessionId)) continue;
        if (excludeIds.has(sessionId)) continue;

        const filePath = path.join(sessionsDir, file);
        const { lastMessage, messageCount } = readTranscriptTail(filePath);
        if (messageCount === 0) continue;

        const stat = fs.statSync(filePath);
        const lastActivity = stat.mtime.toISOString();

        sessions.push({
          session_id: sessionId,
          slug: sessionId,
          title: titleFrom(lastMessage, sessionId.slice(0, 8)),
          project: '',
          project_name: agent.name,
          file_path: filePath,
          last_message: lastMessage.length > 100 ? lastMessage.slice(0, 100) + '...' : lastMessage,
          last_activity: lastActivity,
          is_active: Date.now() - stat.mtime.getTime() < ACTIVE_THRESHOLD_MS,
          message_count: messageCount,
        });
      }
    }
  }

  sessions.sort(
    (a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime(),
  );

  return sessions;
}

/**
 * Resolve a session ID to its transcript JSONL path by scanning all agents.
 */
export function findTranscriptFile(sessionId: string): string | null {
  const root = agentsDir();
  if (!fs.existsSync(root)) return null;

  let agents: fs.Dirent[];
  try {
    agents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const filePath = path.join(root, agent.name, 'sessions', `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }

  return null;
}
