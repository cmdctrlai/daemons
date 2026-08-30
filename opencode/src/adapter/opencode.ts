import { ChildProcess, spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SessionInfo, MessageEntry } from '@cmdctrl/daemon-sdk';

const OPENCODE_DB = join(process.env.HOME || '~', '.local', 'share', 'opencode', 'opencode.db');

/** What opencode substitutes the user's arguments for when expanding a command. */
const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

/**
 * How much of a template must match before an expansion is attributed to a
 * command. Templates run to paragraphs; anything this short is more likely to be
 * something the user genuinely typed.
 */
const MIN_TEMPLATE_PREFIX = 24;

export interface GetMessagesResponse {
  messages: MessageEntry[];
  hasMore: boolean;
}

interface OpenCodeMessagePart {
  type: string;
  text?: string;
  /**
   * opencode's own flag for text it generated to keep a turn moving – the
   * "Summarize the task tool output above and continue with your task." nudge
   * after a subtask, for instance. The user never typed it, so it is machinery
   * rather than conversation and is dropped rather than shown as their message.
   */
  synthetic?: boolean;
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

/**
 * One entry from opencode's `GET /command`: a built-in command, a skill, or an
 * MCP prompt. Each is a prompt template opencode expands and hands to the model,
 * so `name`/`description` are all a composer menu needs.
 */
export interface OpenCodeCommand {
  name: string;
  description?: string;
  source?: 'command' | 'skill' | 'mcp';
  hints?: string[];
  /**
   * The prompt this command expands to. opencode stores that expansion as the
   * user's message – there is no record that a command produced it – so the
   * template is what lets us recognise one after the fact.
   */
  template?: string;
  /** True when opencode runs the command in a child session rather than this one. */
  subtask?: boolean;
}

export class OpenCodeAdapter {
  private port: number = 0;
  private serverProcess: ChildProcess | null = null;
  private baseUrl: string = '';
  /** Command names opencode advertised, so a leading-slash message routes to /command. */
  private knownCommands = new Set<string>();

  /** Command templates, longest prefix first – see setCommands. */
  private commandTemplates: Array<{
    name: string;
    prefix: string;
    suffix: string;
    /** exact: no placeholder; args: one, so they can be read back; prefix: several. */
    mode: 'exact' | 'args' | 'prefix';
  }> = [];

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

  /**
   * The commands opencode will autocomplete for a directory, from `GET /command`.
   * opencode resolves this per directory: global built-ins + user skills merged
   * with that project's own `.opencode`/`.claude` commands. Pass the session's
   * project directory to get the set that session should actually see; omit it
   * for the server's own directory. The caller records the names it wants routed
   * via setKnownCommands.
   */
  async listCommands(directory?: string): Promise<OpenCodeCommand[]> {
    const url = directory
      ? `${this.baseUrl}/command?directory=${encodeURIComponent(directory)}`
      : `${this.baseUrl}/command`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to list commands: HTTP ${response.status}`);
    }
    return await response.json() as OpenCodeCommand[];
  }

  /**
   * The commands this daemon knows about, across every project it has enumerated.
   *
   * Two uses: the names decide which leading-slash message routes to `/command`
   * instead of `/message`, and the templates let `collapseCommandTemplate` turn an
   * expansion back into the command that produced it.
   */
  setCommands(commands: OpenCodeCommand[]): void {
    this.knownCommands = new Set(commands.map((c) => c.name));
    this.commandTemplates = commands
      .filter((c) => c.template && c.template.trim())
      .map((c) => {
        const template = c.template!.trim();
        const marker = template.indexOf(ARGUMENTS_PLACEHOLDER);
        if (marker === -1) {
          return { name: c.name, prefix: template, suffix: '', mode: 'exact' as const };
        }
        const prefix = template.slice(0, marker).trim();
        // A template that uses the placeholder once brackets the arguments, so
        // they can be read back out. One that repeats it interleaves them with
        // its own prose, where anything we recovered would be a guess – so the
        // command is named and the arguments are left behind.
        if (template.indexOf(ARGUMENTS_PLACEHOLDER, marker + 1) !== -1) {
          return { name: c.name, prefix, suffix: '', mode: 'prefix' as const };
        }
        return {
          name: c.name,
          prefix,
          suffix: template.slice(marker + ARGUMENTS_PLACEHOLDER.length).trim(),
          mode: 'args' as const,
        };
      })
      // Longest prefix first: a specific command wins over one that merely
      // shares its opening lines.
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * Turn an expanded command prompt back into the `/name args` the user typed.
   *
   * opencode expands a command into a plain user message and keeps no record of
   * which command produced it, so a transcript otherwise shows the whole template
   * where the user only ever typed `/review`. Matching the stored text against the
   * templates recovers the invocation, whichever client sent it, and lets the app
   * render it as a command rather than a wall of prompt. Returns null for ordinary
   * prose, which is the overwhelmingly common case.
   */
  collapseCommandTemplate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    for (const command of this.commandTemplates) {
      // A short prefix would match innocent prose; real templates are long.
      if (command.prefix.length < MIN_TEMPLATE_PREFIX) {
        if (trimmed === command.prefix) return `/${command.name}`;
        continue;
      }
      if (!trimmed.startsWith(command.prefix)) continue;

      if (command.mode === 'exact') {
        // With nowhere to substitute them, opencode appends the arguments to the
        // end of the template, so anything trailing is what the user typed.
        const trailing = trimmed.slice(command.prefix.length).trim();
        return trailing ? `/${command.name} ${trailing}` : `/${command.name}`;
      }
      if (command.mode === 'prefix') return `/${command.name}`;

      let rest = trimmed.slice(command.prefix.length);
      if (command.suffix) {
        if (!rest.endsWith(command.suffix)) continue;
        rest = rest.slice(0, rest.length - command.suffix.length);
      }
      const args = rest.trim();
      return args ? `/${command.name} ${args}` : `/${command.name}`;
    }
    return null;
  }

  /** The directory this opencode server resolved, which its sessions are keyed under. */
  async getProjectDirectory(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/path`);
    if (!response.ok) {
      throw new Error(`Failed to get project directory: HTTP ${response.status}`);
    }

    const data = await response.json() as { directory?: string };
    return data.directory || '';
  }

  async sendMessage(sessionId: string, text: string): Promise<string> {
    const command = this.matchCommand(text);
    const url = command
      ? `${this.baseUrl}/session/${sessionId}/command`
      : `${this.baseUrl}/session/${sessionId}/message`;
    const body = command
      ? { command: command.name, arguments: command.args }
      : { parts: [{ type: 'text', text }] };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: HTTP ${response.status}`);
    }

    const data = await response.json() as OpenCodeMessage;
    return extractText(data);
  }

  /**
   * A message picked from the composer's slash menu arrives as text like
   * "/review main". opencode's plain message endpoint sends that to the model
   * verbatim, which improvises rather than running the command; only /command
   * expands the template. So split a leading-slash message into a command name
   * and its arguments, but only when opencode actually advertised that name –
   * a real command, not a stray "/tmp/..." path.
   */
  private matchCommand(text: string): { name: string; args: string } | null {
    if (!text.startsWith('/')) return null;

    const match = text.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const name = match[1];
    if (!this.knownCommands.has(name)) return null;

    return { name, args: match[2] ?? '' };
  }

  async getMessages(sessionId: string, limit: number): Promise<GetMessagesResponse> {
    const response = await fetch(`${this.baseUrl}/session/${sessionId}/message`);

    if (!response.ok) {
      throw new Error(`Failed to get messages: HTTP ${response.status}`);
    }

    const all = await response.json() as OpenCodeMessage[];

    const entries: MessageEntry[] = all
      .map((m) => {
        const role = (m.info.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT';
        const content = extractText(m);
        return {
          uuid: m.info.id,
          role,
          // A user "message" that is really an expanded command reads as the
          // command again, so the app can render it the way it renders one.
          content: (role === 'USER' && this.collapseCommandTemplate(content)) || content,
          timestamp: new Date(m.info.time.created).toISOString(),
        };
      })
      // Messages whose only text was synthetic drop out here, having no content.
      .filter((m) => m.content);

    const hasMore = entries.length > limit;
    const messages = entries.slice(-limit);
    return { messages, hasMore };
  }

  /**
   * The user's opencode sessions, read from opencode's own database.
   *
   * Only top-level sessions. opencode runs a subtask – the `task` tool, and any
   * command marked `subtask` such as `/review` – in a child session, and the
   * parent receives the summary, so the child is an implementation detail rather
   * than a conversation the user started. Surfacing children put phantom entries
   * in the session list whose opening "user" message was the command's whole
   * expanded prompt template.
   */
  listSessions(managedIds: Set<string>): SessionInfo[] {
    if (!existsSync(OPENCODE_DB)) return [];

    const sql = `
      SELECT s.id, s.slug, s.title, s.directory, s.time_updated,
             COUNT(m.id) as message_count
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      WHERE s.time_archived IS NULL
        AND s.parent_id IS NULL
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

/**
 * Join an opencode message's text parts, dropping reasoning and tool parts along
 * with opencode's own synthetic continuations, which are machinery rather than
 * anything a participant said.
 */
function extractText(message: OpenCodeMessage): string {
  return message.parts
    .filter((p) => p.type === 'text' && p.text && !p.synthetic)
    .map((p) => p.text!)
    .join('\n');
}
