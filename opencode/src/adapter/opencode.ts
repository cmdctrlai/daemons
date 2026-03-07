import { ChildProcess, spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SessionInfo, MessageEntry } from '@cmdctrl/daemon-sdk';

const OPENCODE_DB = join(process.env.HOME || '~', '.local', 'share', 'opencode', 'opencode.db');

export interface GetMessagesResponse {
  messages: MessageEntry[];
  hasMore: boolean;
}

interface OpenCodeMessagePart {
  type: string;
  text?: string;
}

interface OpenCodeMessage {
  info: {
    id: string;
    role: string;
    time: { created: number };
  };
  parts: OpenCodeMessagePart[];
}

interface OpenCodeSession {
  id: string;
  title?: string;
  slug?: string;
  directory?: string;
  time?: { updated: number };
}

export class OpenCodeAdapter {
  private port: number = 0;
  private serverProcess: ChildProcess | null = null;
  private baseUrl: string = '';

  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const homeBin = `${process.env.HOME}/.opencode/bin`;
      const env = {
        ...process.env,
        PATH: `${homeBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      };

      const proc = spawn('opencode', ['serve', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      this.serverProcess = proc;

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('opencode serve did not start within 30 seconds'));
      }, 30000);

      const onData = (data: Buffer) => {
        const line = data.toString();
        const match = line.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/i);
        if (match) {
          clearTimeout(timeout);
          this.port = parseInt(match[1], 10);
          this.baseUrl = `http://127.0.0.1:${this.port}`;
          proc.stdout?.off('data', onData);
          proc.stderr?.off('data', onData);
          resolve();
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start opencode: ${err.message}`));
      });

      proc.on('exit', (code) => {
        if (this.port === 0) {
          clearTimeout(timeout);
          reject(new Error(`opencode exited with code ${code} before listening`));
        }
      });
    });
  }

  stopServer(): void {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }

  async createSession(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: HTTP ${response.status}`);
    }

    const data = await response.json() as OpenCodeSession;
    return data.id;
  }

  async sendMessage(sessionId: string, text: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: HTTP ${response.status}`);
    }

    const data = await response.json() as OpenCodeMessage;
    const textParts = data.parts.filter((p) => p.type === 'text' && p.text);
    return textParts.map((p) => p.text!).join('\n');
  }

  async getMessages(sessionId: string, limit: number): Promise<GetMessagesResponse> {
    const response = await fetch(`${this.baseUrl}/session/${sessionId}/message`);

    if (!response.ok) {
      throw new Error(`Failed to get messages: HTTP ${response.status}`);
    }

    const all = await response.json() as OpenCodeMessage[];

    const entries: MessageEntry[] = all
      .filter((m) => m.parts.some((p) => p.type === 'text' && p.text))
      .map((m) => ({
        uuid: m.info.id,
        role: (m.info.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
        content: m.parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n'),
        timestamp: new Date(m.info.time.created).toISOString(),
      }));

    const hasMore = entries.length > limit;
    const messages = entries.slice(-limit);
    return { messages, hasMore };
  }

  listSessions(managedIds: Set<string>): SessionInfo[] {
    if (!existsSync(OPENCODE_DB)) return [];

    const sql = `
      SELECT s.id, s.slug, s.title, s.directory, s.time_updated,
             COUNT(m.id) as message_count
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      WHERE s.time_archived IS NULL
      GROUP BY s.id
      ORDER BY s.time_updated DESC
      LIMIT 200
    `;

    let output: string;
    try {
      output = execFileSync('sqlite3', ['-separator', '\t', OPENCODE_DB, sql], {
        encoding: 'utf-8',
        timeout: 3000,
      });
    } catch {
      return [];
    }

    const now = new Date().toISOString();
    const results: SessionInfo[] = [];

    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      const [id, slug, title, directory, timeUpdatedRaw, messageCountRaw] = line.split('\t');
      if (!id || managedIds.has(id)) continue;

      const timeUpdated = timeUpdatedRaw ? new Date(parseInt(timeUpdatedRaw, 10)).toISOString() : now;
      const projectName = directory ? directory.split('/').filter(Boolean).pop() || '' : '';
      const messageCount = messageCountRaw ? parseInt(messageCountRaw, 10) : 0;

      results.push({
        session_id: id,
        slug: slug || id,
        title: title || id,
        project: directory || '',
        project_name: projectName,
        file_path: '',
        last_message: '',
        last_activity: timeUpdated,
        is_active: false,
        message_count: messageCount,
      });
    }

    return results;
  }
}
