import { ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { DiffTurn, SessionInfo } from '@cmdctrl/daemon-sdk';
import {
  imageParts, opencodeEnv, TRANSCRIPT_FILE,
  type GetMessagesResponse, type OpenCodeCommand, type PermissionRequest, type QuestionRequest,
  type SessionActivity, type TurnResult,
} from '../adapter/opencode';
import { page, type TurnState } from '../adapter/transcript';
import type { EventFeed, OpenCodeEvent } from '../events';
import { formAnswer, toPermissionRequest, toQuestionRequest, V2EventTranslator, type V2Form, type V2Frame, type V2Permission } from './events';
import { changedTurns, diffTurn, toEntries, turnResult, turnState, type V2Message } from './transcript';

/** How many of the user's most recent sessions the app's list is offered. */
const SESSION_LIST_LIMIT = 200;
/** The most messages v2 returns in one page. */
const PAGE_LIMIT = 200;
/** How many sessions' transcripts the list reads at once when they changed. */
const LIST_READ_CONCURRENCY = 8;
/** Enough of a transcript's tail to tell where its turn stands and preview it. */
const LIST_TAIL_MESSAGES = 5;
/** Enough of a transcript's tail to find the newest turn's final answer. */
const RESULT_TAIL_MESSAGES = 20;
/** How many typed commands to keep on disk; older ones show as their expansion. */
const REMEMBERED_COMMANDS = 2000;

interface V2Session {
  id: string;
  parentID?: string;
  title?: string;
  location?: { directory?: string };
  time?: { updated?: number };
}

/**
 * Drives opencode v2's server: everything under `/api`, behind Basic auth with the
 * password the server generated and printed when it started.
 */
export class OpenCodeV2Adapter {
  private serverProcess: ChildProcess | null = null;
  private baseUrl: string;
  private authorization = '';
  private readonly translator = new V2EventTranslator();
  /** Command names opencode advertised, so a leading-slash message runs the command. */
  private knownCommands = new Set<string>();
  /** The advertised names that are skills, which v2 runs as an attachment to a prompt. */
  private skills = new Set<string>();
  /** Commands sent per session whose expansion opencode hasn't filed yet, oldest first. */
  private pendingCommands = new Map<string, string[]>();
  /**
   * What each command expansion was typed as, by its user message. v2 stores only
   * the expanded prompt, so the transcript would otherwise show the template.
   * Kept in `commandsFile` so a restart doesn't turn them back into templates.
   */
  private typedCommands = new Map<string, string>();
  /** The tail of each listed session's transcript, kept until opencode touches it again. */
  private tails = new Map<string, { updated: number; messages: V2Message[] }>();

  /** v2 reloads commands by itself, so nothing here waits on a turn. */
  busy: (directory: string) => boolean = () => false;

  /** Pass the URL and password of a v2 server already running; otherwise call startServer. */
  constructor(baseUrl = '', password?: string, private readonly commandsFile?: string) {
    this.baseUrl = baseUrl;
    if (password) this.authorize(password);
    this.loadCommands();
  }

  get url(): string {
    return this.baseUrl;
  }

  /** v2's event stream, read as the events the daemon's turns follow. */
  get eventFeed(): EventFeed {
    return { path: '/api/event', headers: () => ({ Authorization: this.authorization }), parse: (data) => this.parseEvent(data) };
  }

  /**
   * Start a v2 server and adopt the password it generates. v2 takes a chosen
   * password only from its environment, and passes that environment to every
   * shell, tool and MCP server it runs – so the agent could read it back.
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: serverEnv(opencodeEnv()),
      });
      this.serverProcess = proc;
      let listening = false;
      let output = '';

      const timeout = setTimeout(() => {
        proc.kill();
        const started = parseStartup(output).url;
        reject(new Error(started ? 'opencode serve started but never printed its password' : 'opencode serve did not start within 30 seconds'));
      }, 30000);

      const onData = (data: Buffer) => {
        output += data.toString();
        const { url, password } = parseStartup(output);
        if (!url || !password) return;
        clearTimeout(timeout);
        listening = true;
        output = '';
        this.baseUrl = url;
        this.authorize(password);
        proc.stdout?.off('data', onData);
        proc.stderr?.off('data', onData);
        resolve();
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start opencode: ${err.message}`));
      });
      proc.on('exit', (code) => {
        if (listening) return;
        clearTimeout(timeout);
        reject(new Error(`opencode exited with code ${code} before listening`));
      });
    });
  }

  private authorize(password: string): void {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  stopServer(): void {
    this.serverProcess?.kill('SIGTERM');
    this.serverProcess = null;
  }

  /**
   * Start a session in the project the user picked, by its real path: v2 records
   * no changes for a session opened through a symlink. A path this machine doesn't
   * have falls back to the server's own directory.
   */
  async createSession(projectPath?: string): Promise<string> {
    const body: { location?: { directory: string } } = {};
    if (projectPath && existsSync(projectPath)) {
      body.location = { directory: realpathSync(projectPath) };
    } else if (projectPath) {
      console.warn(`Project path does not exist: ${projectPath}; using the daemon's directory`);
    }
    return (await this.request<{ data: V2Session }>('POST', '/api/session', body)).data.id;
  }

  /**
   * What the `/` menu offers in a directory: opencode's commands – built-in and the
   * project's own – then its skills, which v2 lists apart. A command wins a name both use.
   */
  async listCommands(directory?: string): Promise<OpenCodeCommand[]> {
    const query = locationQuery(directory);
    const [commands, skills] = await Promise.all([
      this.request<{ data: OpenCodeCommand[] }>('GET', `/api/command${query}`),
      this.request<{ data: Array<{ id: string; description?: string }> }>('GET', `/api/skill${query}`),
    ]);
    const names = new Set(commands.data.map((c) => c.name));
    const asCommands = skills.data
      .filter((s) => !names.has(s.id))
      .map((s): OpenCodeCommand => ({ name: s.id, description: s.description, source: 'skill' }));
    return [...commands.data, ...asCommands];
  }

  /** v2 watches command files itself, so the listing is always current. */
  reloadCommands(directory: string): Promise<OpenCodeCommand[] | null> {
    return this.listCommands(directory);
  }

  /** The command names a leading-slash message may run, across every project. */
  setCommands(commands: OpenCodeCommand[]): void {
    this.knownCommands = new Set(commands.map((c) => c.name));
    this.skills = new Set(commands.filter((c) => c.source === 'skill').map((c) => c.name));
  }

  async getProjectDirectory(): Promise<string> {
    return (await this.request<{ directory?: string }>('GET', '/api/location')).directory ?? '';
  }

  /**
   * Start a turn, with any attached images (base64 data URLs). Returns once
   * opencode has queued it; the turn is followed on the event stream.
   */
  async send(sessionId: string, text: string, images: string[] | undefined, onFailure: (err: Error) => void): Promise<void> {
    const files = imageParts(images).map((p) => ({ uri: p.url, name: p.filename }));
    const attached = files.length ? { files } : {};
    try {
      if (text.trim() === '/compact') {
        await this.request('POST', `/api/session/${sessionId}/compact`, {});
        return;
      }
      const command = this.matchCommand(text);
      if (!command || this.skills.has(command.name)) {
        const skills = command ? { skills: [{ id: command.name }] } : {};
        await this.request('POST', `/api/session/${sessionId}/prompt`, { text: command ? command.args : text, ...attached, ...skills });
        return;
      }
      const queue = this.pendingCommands.get(sessionId) ?? [];
      queue.push(text.trim());
      this.pendingCommands.set(sessionId, queue);
      try {
        await this.request('POST', `/api/session/${sessionId}/command`, { name: command.name, text: command.args, ...attached });
      } catch (err) {
        const unsent = queue.indexOf(text.trim());
        if (unsent !== -1) queue.splice(unsent, 1);
        throw err;
      }
    } catch (err) {
      onFailure(err as Error);
    }
  }

  async replyPermission(id: string, _directory: string, reply: 'once' | 'reject', message?: string): Promise<void> {
    const sessionId = this.translator.permissionSession(id);
    if (!sessionId) throw new Error('opencode is no longer asking for that permission');
    await this.request('POST', `/api/session/${sessionId}/permission/${id}/reply`, { decision: reply, ...(message ? { message } : {}) });
  }

  async replyQuestion(id: string, _directory: string, answers: string[][]): Promise<void> {
    const form = this.translator.form(id);
    if (!form) throw new Error('opencode is no longer asking that question');
    await this.request('POST', `/api/session/${form.sessionID}/form/${id}/reply`, { answer: formAnswer(form, answers) });
  }

  /** The permission and question requests a project is waiting on, straight from opencode. */
  async pendingRequests(directory: string): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }> {
    const query = locationQuery(directory);
    const [permissions, forms] = await Promise.all([
      this.request<{ data: V2Permission[] }>('GET', `/api/permission/request${query}`),
      this.request<{ data: V2Form[] }>('GET', `/api/form${query}`),
    ]);
    for (const p of permissions.data) this.translator.rememberPermission(p);
    for (const f of forms.data) this.translator.rememberForm(f);
    return { permissions: permissions.data.map(toPermissionRequest), questions: forms.data.map(toQuestionRequest) };
  }

  async sessionDirectory(sessionId: string): Promise<string> {
    return (await this.session(sessionId)).location?.directory ?? '';
  }

  async parentSession(sessionId: string): Promise<string | null> {
    return (await this.session(sessionId)).parentID ?? null;
  }

  async abort(sessionId: string): Promise<void> {
    await this.request('POST', `/api/session/${sessionId}/interrupt`);
  }

  /** Wait until the session's turn has ended, so the transcript shows how it finished. */
  async awaitTurnEnd(sessionId: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [last] = await this.messages(sessionId, 1);
      if (!last || last.type === 'idle' || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** What the agent changed in a session, turn by turn, newest first. */
  async diff(sessionId: string): Promise<DiffTurn[]> {
    const result: DiffTurn[] = [];
    for (const turn of changedTurns(await this.messages(sessionId), (id) => this.typedCommands.get(id))) {
      const { data } = await this.request<{ data: Parameters<typeof diffTurn>[1] }>(
        'GET', `/api/session/${sessionId}/diff?from=${encodeURIComponent(turn.id)}`,
      );
      if (data.length) result.push(diffTurn(turn, data));
    }
    return result;
  }

  async turnResult(sessionId: string): Promise<TurnResult> {
    return turnResult(await this.messages(sessionId, RESULT_TAIL_MESSAGES));
  }

  async activity(sessionId: string): Promise<SessionActivity> {
    const raw = await this.messages(sessionId);
    const entries = toEntries(raw, (id) => this.typedCommands.get(id));
    return { count: entries.length, last: entries[entries.length - 1], state: turnState(raw, Date.now()) };
  }

  async getMessages(sessionId: string, limit: number, before?: string, after?: string, afterTime?: number): Promise<GetMessagesResponse> {
    const entries = toEntries(await this.messages(sessionId), (id) => this.typedCommands.get(id));
    return page(entries, limit, before, after, afterTime);
  }

  /**
   * The user's top-level sessions from every project, newest first. Never throws:
   * the SDK polls this, and an empty list is the honest answer while opencode is
   * unreachable.
   */
  async listSessions(managedIds: Set<string>): Promise<SessionInfo[]> {
    let sessions: V2Session[];
    try {
      sessions = (await this.request<{ data: V2Session[] }>('GET', `/api/session?parentID=null&limit=${SESSION_LIST_LIMIT}`)).data;
    } catch (err) {
      console.warn('Could not list opencode sessions:', (err as Error).message);
      return [];
    }
    const listed = sessions.filter((s) => s.id && !managedIds.has(s.id));
    const states = await this.listStates(listed);
    return listed.map((s, i) => {
      const directory = s.location?.directory ?? '';
      return {
        session_id: s.id,
        slug: s.id,
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

  private async listStates(sessions: V2Session[]): Promise<Array<TurnState | undefined>> {
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

  private parseEvent(data: string): OpenCodeEvent[] {
    let frame: V2Frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return [];
    }
    if (frame.type === 'session.inbox.enqueued') this.fileCommand(frame.data ?? {});
    return this.translator.translate(frame);
  }

  /** A command this daemon sent has been queued as a user message: remember what was typed. */
  private fileCommand(data: Record<string, any>): void {
    const queue = this.pendingCommands.get(data.sessionID);
    if (!queue?.length || data.item?.type !== 'user') return;
    this.typedCommands.set(data.inboxID, queue.shift()!);
    if (!queue.length) this.pendingCommands.delete(data.sessionID);
    this.saveCommands();
  }

  private loadCommands(): void {
    if (!this.commandsFile) return;
    try {
      this.typedCommands = new Map(Object.entries(JSON.parse(readFileSync(this.commandsFile, 'utf-8'))));
    } catch {
      // None yet, or unreadable: commands sent before show as their expansion.
    }
  }

  private saveCommands(): void {
    if (!this.commandsFile) return;
    const kept = [...this.typedCommands].slice(-REMEMBERED_COMMANDS);
    this.typedCommands = new Map(kept);
    try {
      mkdirSync(dirname(this.commandsFile), { recursive: true });
      writeFileSync(this.commandsFile, JSON.stringify(Object.fromEntries(kept)), 'utf-8');
    } catch (err) {
      console.warn('Could not save typed commands:', (err as Error).message);
    }
  }

  /** A leading-slash message names a command only when opencode advertised it. */
  private matchCommand(text: string): { name: string; args: string } | null {
    const match = text.startsWith('/') ? text.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/) : null;
    if (!match || !this.knownCommands.has(match[1])) return null;
    return { name: match[1], args: match[2] ?? '' };
  }

  private async session(sessionId: string): Promise<V2Session> {
    return (await this.request<{ data: V2Session }>('GET', `/api/session/${sessionId}`)).data;
  }

  /** The session's messages, oldest first; the newest `limit` when given. */
  private async messages(sessionId: string, limit?: number): Promise<V2Message[]> {
    const path = `/api/session/${sessionId}/message`;
    if (limit) {
      return (await this.request<{ data: V2Message[] }>('GET', `${path}?order=desc&limit=${limit}`)).data.reverse();
    }
    const all: V2Message[] = [];
    let query = `order=asc&limit=${PAGE_LIMIT}`;
    for (;;) {
      const { data, cursor } = await this.request<{ data: V2Message[]; cursor?: { next?: string | null } }>('GET', `${path}?${query}`);
      all.push(...data);
      if (data.length < PAGE_LIMIT || !cursor?.next) return all;
      query = `cursor=${encodeURIComponent(cursor.next)}&limit=${PAGE_LIMIT}`;
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.json().then((e) => (e as { message?: string }).message, () => undefined);
      throw new Error(`opencode ${path.split('?')[0]}: HTTP ${response.status}${detail ? ` – ${detail}` : ''}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
}

/** The variables v2 reads a chosen server password from; without them it makes its own. */
const PASSWORD_VARIABLES = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'];

/** The environment for a v2 server: the daemon's, without a password for v2 to pass on. */
export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PASSWORD_VARIABLES.includes(name)));
}

/** Where a starting v2 server listens and the password it generated, once it has printed both. */
export function parseStartup(output: string): { url?: string; password?: string } {
  return {
    url: output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/i)?.[1],
    // Only a whole line: output can arrive split mid-password.
    password: output.match(/^server password (\S+)\r?\n/m)?.[1],
  };
}

/** v2 scopes a listing to a directory with a `location[directory]` query. */
function locationQuery(directory?: string): string {
  return directory ? `?${encodeURIComponent('location[directory]')}=${encodeURIComponent(directory)}` : '';
}
