/**
 * One ACP agent process, spawned from the registered command and spoken to over
 * its stdio. ACP multiplexes sessions on one connection, so every session the
 * daemon runs shares this process. It starts on first use, and again on the next
 * use after it exits; sessions it held must then be reopened before a prompt.
 */
import { spawn as spawnProcess, type ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { JsonRpcConnection, METHOD_NOT_FOUND } from './acp/connection';
import {
  PROTOCOL_VERSION,
  type AcpSessionInfo,
  type AgentCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsResponse,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type SessionUpdate,
} from './acp/types';

export interface AgentListener {
  update(notification: SessionNotification): void;
  /** The agent asks before running a tool; resolves with the user's choice. */
  permission(request: RequestPermissionRequest, requestId: number | string): Promise<RequestPermissionOutcome>;
  /** The agent withdrew a request it sent us, e.g. a permission ask its turn no longer needs. */
  requestWithdrawn(requestId: number | string): void;
  /** The process ended; every session it held is gone with it. */
  exited(reason: Error): void;
}

export type Spawn = (argv: string[]) => ChildProcess;

const INIT_TIMEOUT_MS = 60_000;
const STDERR_LINES = 20;
/** session/list pages to follow before reporting what was found. */
const MAX_LIST_PAGES = 10;

export const CLIENT_INFO = { name: 'cmdctrl-acp', title: 'Cmd+Ctrl' };

const defaultSpawn: Spawn = (argv) => spawnProcess(argv[0], argv.slice(1), {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  cwd: os.homedir(),
});

export class AcpAgent {
  private child: ChildProcess | null = null;
  private conn: JsonRpcConnection | null = null;
  private init: InitializeResponse | null = null;
  private starting: Promise<InitializeResponse> | null = null;
  /** Sessions this process created or reopened; only these accept a prompt. */
  private live = new Set<string>();
  /** Sessions being loaded: their replayed history goes here, not to the listener. */
  private replays = new Map<string, (update: SessionUpdate) => void>();
  /** Opens in flight, so two callers reopening one session share a request. */
  private opening = new Map<string, Promise<void>>();
  private stderrTail: string[] = [];

  constructor(
    private readonly argv: string[],
    private readonly listener: AgentListener,
    private readonly version: string,
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly spawn: Spawn = defaultSpawn,
  ) {}

  /** The executable's name, for messages: `dsh`, `qwen`. */
  get name(): string {
    return path.basename(this.argv[0]);
  }

  get capabilities(): AgentCapabilities {
    return this.init?.agentCapabilities ?? {};
  }

  get info(): InitializeResponse | null {
    return this.init;
  }

  get running(): boolean {
    return !!this.conn && !this.conn.isClosed && !!this.init;
  }

  isLive(sessionId: string): boolean {
    return this.running && this.live.has(sessionId);
  }

  /** Start the process and complete the ACP handshake, once per process. */
  start(): Promise<InitializeResponse> {
    if (this.running) return Promise.resolve(this.init!);
    if (!this.starting) {
      this.starting = this.launch().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async newSession(cwd: string): Promise<string> {
    await this.start();
    const result = await this.conn!.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] });
    this.live.add(result.sessionId);
    return result.sessionId;
  }

  /**
   * Make a session ready for a prompt. Loading replays its history, which goes to
   * `onReplay` when given – and with `onReplay` a session this process already
   * holds is loaded again, to read back what the agent has now. Resuming replays
   * nothing; it is used when there is no replay to catch.
   */
  open(sessionId: string, cwd: string, onReplay?: (update: SessionUpdate) => void): Promise<void> {
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;
    const opening = this.reopen(sessionId, cwd, onReplay).finally(() => this.opening.delete(sessionId));
    this.opening.set(sessionId, opening);
    return opening;
  }

  private async reopen(sessionId: string, cwd: string, onReplay?: (update: SessionUpdate) => void): Promise<void> {
    await this.start();
    // A replay wanted is a read-back, which an open session gets too: the agent may
    // hold turns taken elsewhere since. Without one, an open session is ready.
    if (this.live.has(sessionId) && !(onReplay && this.capabilities.loadSession)) return;
    const caps = this.capabilities;
    const canResume = !!caps.sessionCapabilities?.resume;
    if (caps.loadSession && (onReplay || !canResume)) {
      this.replays.set(sessionId, onReplay ?? (() => undefined));
      try {
        await this.conn!.request('session/load', { sessionId, cwd, mcpServers: [] });
      } finally {
        this.replays.delete(sessionId);
      }
    } else if (canResume) {
      await this.conn!.request('session/resume', { sessionId, cwd, mcpServers: [] });
    } else {
      throw new Error(`${this.name} can't reopen a session after it restarts, so this one can't continue. Start a new session.`);
    }
    this.live.add(sessionId);
  }

  /** Whether `open` can hand back a session's history. */
  get canReplay(): boolean {
    return !!this.capabilities.loadSession;
  }

  get acceptsImages(): boolean {
    return !!this.capabilities.promptCapabilities?.image;
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    if (!this.isLive(sessionId)) throw new Error('The session is not open in the agent');
    return this.conn!.request<PromptResponse>('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string): void {
    this.conn?.notify('session/cancel', { sessionId });
  }

  /**
   * The agent's own session list, when it offers one. Some agents only list the
   * sessions of one directory at a time, so each directory in `cwds` is asked
   * as well as the unfiltered list; results are merged by session id.
   */
  async listSessions(cwds: string[] = []): Promise<AcpSessionInfo[]> {
    await this.start();
    if (!this.capabilities.sessionCapabilities?.list) return [];
    const byId = new Map<string, AcpSessionInfo>();
    for (const cwd of [undefined, ...new Set(cwds)]) {
      for (const session of await this.listPages(cwd)) {
        if (session?.sessionId && !byId.has(session.sessionId)) byId.set(session.sessionId, session);
      }
    }
    return [...byId.values()];
  }

  private async listPages(cwd: string | undefined): Promise<AcpSessionInfo[]> {
    const sessions: AcpSessionInfo[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) };
      const result: ListSessionsResponse = await this.conn!.request('session/list', params);
      sessions.push(...(result?.sessions ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return sessions;
  }

  stop(): void {
    const child = this.child;
    this.conn?.close(new Error('The daemon is shutting down'));
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }

  private async launch(): Promise<InitializeResponse> {
    this.log(`Starting agent: ${this.argv.join(' ')}`);
    const child = this.spawn(this.argv);
    this.child = child;
    this.stderrTail = [];

    // Every error is handled: an 'error' event with no listener would take the daemon down.
    const failed = new Promise<never>((_, reject) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        this.log(`[${this.name}] process error: ${err.message}`);
        reject(new Error(err.code === 'ENOENT'
          ? `Could not start "${this.argv[0]}": not found on PATH`
          : `Could not start "${this.argv[0]}": ${err.message}`));
      });
    });
    failed.catch(() => undefined);
    child.stderr?.on('error', () => undefined);

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        this.log(`[${this.name}] ${line}`);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
      }
    });

    const conn = new JsonRpcConnection(
      child.stdout!,
      child.stdin!,
      (method, params, id) => this.handleRequest(method, params, id),
      (method, params) => this.handleNotification(method, params),
      process.env.CMDCTRL_ACP_TRACE ? (line) => this.log(`[acp] ${line.slice(0, 2000)}`) : undefined,
    );
    this.conn = conn;
    child.once('exit', (code, signal) => {
      const tail = this.stderrTail.slice(-5).join('\n');
      const why = signal ? `signal ${signal}` : `code ${code}`;
      conn.close(new Error(`${this.name} exited (${why})${tail ? `: ${tail}` : ''}`));
    });
    conn.once('close', (reason: Error) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.init = null;
      this.live.clear();
      this.replays.clear();
      if (child.exitCode === null) child.kill('SIGTERM');
      this.log(`Agent stopped: ${reason.message}`);
      this.listener.exited(reason);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.name} did not answer the ACP handshake within ${INIT_TIMEOUT_MS / 1000}s`)), INIT_TIMEOUT_MS);
    });
    try {
      const init = await Promise.race([
        conn.request<InitializeResponse>('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { ...CLIENT_INFO, version: this.version },
        }),
        failed,
        timeout,
      ]);
      if (init?.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`${this.name} speaks ACP version ${init?.protocolVersion}; this daemon speaks version ${PROTOCOL_VERSION}`);
      }
      this.init = init;
      const agent = init.agentInfo;
      this.log(`Agent ready: ${agent?.title || agent?.name || this.name} ${agent?.version ?? ''} – ${describeCapabilities(init.agentCapabilities)}`);
      return init;
    } catch (err) {
      conn.close(err as Error);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleRequest(method: string, params: any, id: number | string): Promise<unknown> {
    if (method === 'session/request_permission') {
      return { outcome: await this.listener.permission(params as RequestPermissionRequest, id) };
    }
    // fs/* and terminal/* were declined at initialize; anything else is an extension we don't know.
    throw { code: METHOD_NOT_FOUND, message: `Method not supported: ${method}` };
  }

  private handleNotification(method: string, params: any): void {
    if (method === 'session/update' && params?.sessionId && params.update) {
      const replay = this.replays.get(params.sessionId);
      if (replay) replay(params.update);
      else this.listener.update(params as SessionNotification);
    } else if (method === '$/cancel_request' && params?.requestId !== undefined) {
      this.listener.requestWithdrawn(params.requestId);
    }
  }
}


function describeCapabilities(caps: AgentCapabilities | undefined): string {
  const has = [
    caps?.loadSession && 'load',
    caps?.sessionCapabilities?.list && 'list',
    caps?.sessionCapabilities?.resume && 'resume',
    caps?.promptCapabilities?.image && 'images',
  ].filter(Boolean);
  return has.length ? `supports ${has.join(', ')}` : 'no optional session capabilities';
}
