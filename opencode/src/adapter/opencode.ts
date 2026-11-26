import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionInfo } from '@cmdctrl/daemon-sdk';
import type { DiffTurn } from '@cmdctrl/daemon-sdk';
import {
  diffTurns, errorText, extractText, page, toEntries, turnState,
  type Entry, type OpenCodeMessage, type QuestionInfo, type TurnState,
} from './transcript';

/** How many of the user's most recent sessions the app's list is offered. */
const SESSION_LIST_LIMIT = 200;

/** What opencode substitutes the user's arguments for when expanding a command. */
const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

/**
 * How much of a template must match before an expansion is attributed to a
 * command. Templates run to paragraphs; anything this short is more likely to be
 * something the user genuinely typed.
 */
const MIN_TEMPLATE_PREFIX = 24;

/**
 * Where opencode keeps every session's transcript. The server watches a session
 * only once the daemon names the file behind it.
 */
export const TRANSCRIPT_FILE = join(
  process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db',
);

/** How many sessions' transcripts the list reads at once when they changed. */
const LIST_READ_CONCURRENCY = 8;
/** Enough of a transcript's tail to tell where its turn stands and preview it. */
const LIST_TAIL_MESSAGES = 5;

export interface GetMessagesResponse {
  messages: Entry[];
  hasMore: boolean;
}

/** What a finished turn produced: its final text, or the error it ended on. */
export interface TurnResult {
  text: string;
  error?: string;
}

/** A tool call opencode is holding until the user allows it. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
}

/** Questions the model asked with opencode's question tool, held until answered. */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  /** The question tool call holding the request; its id names the question's entries. */
  tool?: { messageID: string; callID: string };
}

/** A session's conversation as the app counts it, and where its turn stands. */
export interface SessionActivity {
  count: number;
  last?: Entry;
  state: TurnState;
}

interface OpenCodeSession {
  id: string;
  title?: string;
  slug?: string;
  directory?: string;
  time?: { updated: number };
}

/** An image attachment as opencode takes it: a file part carrying a data URL. */
interface OpenCodeFilePart {
  type: 'file';
  mime: string;
  filename: string;
  url: string;
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

/**
 * The environment the daemon runs opencode in: opencode's own installer puts the
 * binary in ~/.opencode/bin, which comes before the rest of PATH.
 */
export function opencodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: `${env.HOME}/.opencode/bin:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}` };
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

  /**
   * Whether a turn is running in a project. Reloading opencode's commands
   * disposes the project's instance, which aborts any turn running in it.
   */
  busy: (directory: string) => boolean = () => false;
  /** A command reload under way, which a new turn waits out rather than lose. */
  private reloading: Promise<unknown> = Promise.resolve();
  /** The tail of each listed session's transcript, kept until opencode touches it again. */
  private tails = new Map<string, { updated: number; messages: OpenCodeMessage[] }>();

  /** The opencode server this adapter talks to. */
  get url(): string {
    return this.baseUrl;
  }

  /** Pass the URL of an opencode server that is already running; otherwise call startServer. */
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['serve', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opencodeEnv(),
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

  /**
   * Start a session in the project the user picked. A path this machine doesn't
   * have falls back to the server's own directory rather than failing the task.
   */
  async createSession(projectPath?: string): Promise<string> {
    let url = `${this.baseUrl}/session`;
    if (projectPath && existsSync(projectPath)) {
      url += `?directory=${encodeURIComponent(projectPath)}`;
    } else if (projectPath) {
      console.warn(`Project path does not exist: ${projectPath}; using the daemon's directory`);
    }

    const response = await fetch(url, {
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
   * Like listCommands, but sees a command the user added since opencode last read
   * this project. opencode loads commands once per project instance and offers no
   * reload, so the instance is disposed and the listing builds a fresh one.
   *
   * Disposing aborts any turn running in it, so this returns null without
   * touching opencode while one is; try again later.
   */
  async reloadCommands(directory: string): Promise<OpenCodeCommand[] | null> {
    if (this.busy(directory)) return null;
    // The daemon may start a turn here while the status is read.
    if ((await this.running(directory)) || this.busy(directory)) return null;

    const reload = (async () => {
      const response = await fetch(
        `${this.baseUrl}/instance/dispose?directory=${encodeURIComponent(directory)}`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new Error(`Failed to reload commands: HTTP ${response.status}`);
      }
      return this.listCommands(directory);
    })();
    this.reloading = reload.catch(() => undefined);
    return reload;
  }

  /**
   * Whether this server is running a turn in the project – a terminal attached to
   * it runs turns the daemon never started. When it can't tell, it says yes.
   */
  private async running(directory: string): Promise<boolean> {
    try {
      const status = await this.getJson<Record<string, { type: string }>>(
        `/session/status?directory=${encodeURIComponent(directory)}`,
      );
      return Object.values(status).some((s) => s.type !== 'idle');
    } catch {
      return true;
    }
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

  /**
   * Start a turn, with any attached images (base64 data URLs) for the model to see.
   *
   * Returns once opencode has the turn; the turn itself is followed on the event
   * stream. A command or `/compact` gets its HTTP answer only when the turn ends,
   * so its rejection arrives later, through `onFailure`.
   */
  async send(
    sessionId: string,
    text: string,
    images: string[] | undefined,
    onFailure: (err: Error) => void,
  ): Promise<void> {
    await this.reloading;
    const files = imageParts(images);

    if (text.trim() === '/compact') {
      const model = await this.sessionModel(sessionId);
      if (!model) return onFailure(new Error('Nothing to compact yet'));
      return this.fire(`/session/${sessionId}/summarize`, model, onFailure);
    }

    const command = this.matchCommand(text);
    if (command) {
      const body = { command: command.name, arguments: command.args, ...(files.length ? { parts: files } : {}) };
      return this.fire(`/session/${sessionId}/command`, body, onFailure);
    }

    try {
      // Images first, so the text that refers to them comes after them.
      const parts = [...files, ...(text ? [{ type: 'text', text }] : [])];
      await this.post(`/session/${sessionId}/prompt_async`, { parts });
    } catch (err) {
      onFailure(err as Error);
    }
  }

  /** Allow or refuse a tool call opencode is holding for the user. */
  async replyPermission(id: string, directory: string, reply: 'once' | 'reject', message?: string): Promise<void> {
    await this.post(`/permission/${id}/reply?directory=${encodeURIComponent(directory)}`, {
      reply,
      ...(message ? { message } : {}),
    });
  }

  /** Answer a question opencode is holding for the user: one list of labels per question. */
  async replyQuestion(id: string, directory: string, answers: string[][]): Promise<void> {
    await this.post(`/question/${id}/reply?directory=${encodeURIComponent(directory)}`, { answers });
  }

  /** The permission and question requests a project is waiting on, straight from opencode. */
  async pendingRequests(directory: string): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }> {
    const dir = encodeURIComponent(directory);
    const [permissions, questions] = await Promise.all([
      this.getJson<PermissionRequest[]>(`/permission?directory=${dir}`),
      this.getJson<QuestionRequest[]>(`/question?directory=${dir}`),
    ]);
    return { permissions, questions };
  }

  /** The project directory a session runs in. */
  async sessionDirectory(sessionId: string): Promise<string> {
    return (await this.getJson<{ directory: string }>(`/session/${sessionId}`)).directory;
  }

  /** The session that started this one – a subagent's runs in a child session – or null. */
  async parentSession(sessionId: string): Promise<string | null> {
    return (await this.getJson<{ parentID?: string }>(`/session/${sessionId}`)).parentID ?? null;
  }

  /**
   * Halt the turn running in a session. The session's project instance is the
   * one running it, so the directory goes along.
   */
  async abort(sessionId: string, directory?: string): Promise<void> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    await this.post(`/session/${sessionId}/abort${query}`, {});
  }

  /**
   * Wait until the session's newest message has ended, so the transcript shows how
   * the turn finished. abort returns before opencode records the aborted message.
   */
  async awaitTurnEnd(sessionId: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [last] = await this.messages(sessionId, 1);
      const open = last?.info.role === 'assistant' && !last.info.error && !last.info.time.completed;
      if (!open || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** What the agent changed in a session, turn by turn, newest first. */
  async diff(sessionId: string): Promise<DiffTurn[]> {
    return diffTurns(await this.messages(sessionId), (t) => this.collapseCommandTemplate(t));
  }

  /** The final text of the session's newest turn, or the error it ended on. */
  async turnResult(sessionId: string): Promise<TurnResult> {
    const [last] = await this.messages(sessionId, 1);
    if (!last || last.info.role !== 'assistant') return { text: '' };
    return { text: extractText(last), error: errorText(last.info.error) };
  }

  /** The session's conversation as the app counts it, and where its turn stands. */
  async activity(sessionId: string): Promise<SessionActivity> {
    const raw = await this.messages(sessionId);
    const entries = toEntries(raw, (t) => this.collapseCommandTemplate(t));
    return { count: entries.length, last: entries[entries.length - 1], state: turnState(raw, Date.now()) };
  }

  /** The model the session last used, which opencode needs to summarize it. */
  private async sessionModel(sessionId: string): Promise<{ providerID: string; modelID: string } | null> {
    const recent = await this.messages(sessionId, 10);
    for (let i = recent.length - 1; i >= 0; i--) {
      const { providerID, modelID, model } = recent[i].info;
      if (providerID && modelID) return { providerID, modelID };
      if (model) return model;
    }
    return null;
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`opencode ${path.split('?')[0]}: HTTP ${response.status}`);
    }
  }

  /**
   * Start a request opencode answers only when the turn ends. Dropping the
   * connection does not stop the turn, so a client timeout on a long one is
   * expected and ignored; only opencode refusing the request is a failure.
   */
  private fire(path: string, body: unknown, onFailure: (err: Error) => void): void {
    fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      (response) => {
        if (!response.ok) onFailure(new Error(`opencode ${path}: HTTP ${response.status}`));
        else response.body?.cancel().catch(() => undefined);
      },
      (err: Error & { cause?: { code?: string } }) => {
        if (!err.cause?.code?.startsWith('UND_ERR_')) onFailure(err);
      },
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`opencode ${path.split('?')[0]}: HTTP ${response.status}`);
    return await response.json() as T;
  }

  /** The session's messages, oldest first; the newest `limit` when given. */
  private messages(sessionId: string, limit?: number): Promise<OpenCodeMessage[]> {
    return this.getJson<OpenCodeMessage[]>(`/session/${sessionId}/message${limit ? `?limit=${limit}` : ''}`);
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

  /** One page of the conversation, as the app shows it. See `page` for `afterTime`. */
  async getMessages(
    sessionId: string,
    limit: number,
    before?: string,
    after?: string,
    afterTime?: number,
  ): Promise<GetMessagesResponse> {
    const entries = toEntries(await this.messages(sessionId), (t) => this.collapseCommandTemplate(t));
    return page(entries, limit, before, after, afterTime);
  }

  /**
   * The user's opencode sessions from every project, newest first, whichever
   * directory the daemon was started in. opencode's own `/session` is scoped to
   * the server's project; `/experimental/session` is its cross-project list.
   *
   * Only top-level sessions (`roots`). opencode runs a subtask – the `task` tool,
   * and any command marked `subtask` such as `/review` – in a child session, and
   * the parent receives the summary, so the child is an implementation detail
   * rather than a conversation the user started. Surfacing children put phantom
   * entries in the session list whose opening "user" message was the command's
   * whole expanded prompt template.
   *
   * Never throws: the SDK polls this on a timer, and an empty list is the honest
   * answer while opencode is unreachable.
   */
  async listSessions(managedIds: Set<string>): Promise<SessionInfo[]> {
    let sessions: OpenCodeSession[];
    try {
      const response = await fetch(
        `${this.baseUrl}/experimental/session?roots=true&limit=${SESSION_LIST_LIMIT}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      sessions = await response.json() as OpenCodeSession[];
    } catch (err) {
      console.warn('Could not list opencode sessions:', (err as Error).message);
      return [];
    }

    const listed = sessions.filter((s) => s.id && !managedIds.has(s.id));
    const states = await this.listStates(listed);
    return listed.map((s, i) => {
      const directory = s.directory || '';
      return {
        session_id: s.id,
        slug: s.slug || s.id,
        title: s.title || s.id,
        project: directory,
        project_name: directory.split('/').filter(Boolean).pop() || '',
        file_path: TRANSCRIPT_FILE,
        last_message: states[i]?.preview ?? '',
        last_activity: new Date(s.time?.updated ?? Date.now()).toISOString(),
        is_active: states[i]?.running ?? false,
        // At most the tail read; the server only asks whether any exist, to resume rather than start anew.
        message_count: this.tails.get(s.id)?.messages.length ?? 0,
      };
    });
  }

  /**
   * Each listed session's preview and whether its turn is running. The tail of a
   * transcript is re-read only when opencode has touched the session since.
   */
  private async listStates(sessions: OpenCodeSession[]): Promise<Array<TurnState | undefined>> {
    const now = Date.now();
    const states: Array<TurnState | undefined> = new Array(sessions.length);
    let next = 0;
    const worker = async () => {
      while (next < sessions.length) {
        const i = next++;
        const s = sessions[i];
        const updated = s.time?.updated ?? 0;
        let tail = this.tails.get(s.id);
        if (!tail || tail.updated !== updated) {
          try {
            tail = { updated, messages: await this.messages(s.id, LIST_TAIL_MESSAGES) };
            this.tails.set(s.id, tail);
          } catch {
            continue;
          }
        }
        states[i] = turnState(tail.messages, updated, now);
      }
    };
    await Promise.all(Array.from({ length: LIST_READ_CONCURRENCY }, worker));
    return states;
  }
}

/**
 * opencode file parts for the user's attached images. The app sends base64 data
 * URLs, which opencode hands the model as-is; anything else is skipped.
 */
export function imageParts(images?: string[]): OpenCodeFilePart[] {
  const parts: OpenCodeFilePart[] = [];
  for (const url of images ?? []) {
    const mime = /^data:([^;,]+);base64,/.exec(url)?.[1];
    if (!mime?.startsWith('image/')) continue;
    parts.push({ type: 'file', mime, filename: `image-${parts.length + 1}`, url });
  }
  return parts;
}
