/**
 * CodexAdapter
 *
 * Drives `codex app-server` over JSON-RPC 2.0 (stdio) to manage Codex threads
 * and turns on behalf of the CmdCtrl daemon.
 *
 * Codex allows one writer per thread, and the claim is held by the app-server
 * process that started or resumed it – no protocol method hands it back, so the
 * process has to go away. Each task therefore gets its own app-server, stopped
 * the moment the task reaches a terminal state. Holding one shared app-server
 * open would keep every thread it ever touched locked, which locks the user out
 * of `codex resume` on their own machine until the daemon restarts.
 *
 * That makes process count a resource to manage rather than an afterthought:
 *   - concurrency is capped at MAX_CONCURRENT_TASKS; a task over the cap is
 *     refused with advice rather than queued behind an unbounded spawn
 *   - a task with no app-server traffic for IDLE_TIMEOUT_MS is presumed wedged
 *     and reaped, so a lock cannot outlive the work that took it
 *   - the daemon's own exit reaps the rest: stopAll() on a clean shutdown, and
 *     a killed daemon closes the child's stdin, which codex treats as EOF and
 *     exits on within ~500ms
 *
 * Event translation:
 *
 *   item/started           -> PROGRESS         { action, target }
 *   item/completed:
 *     - agentMessage       -> (tracked for TASK_COMPLETE; session-watcher
 *                              delivers the text as AGENT_RESPONSE)
 *     - commandExecution   -> OUTPUT           { output: "$ cmd\n<...>" }
 *     - other              -> PROGRESS         { action, target }
 *   turn/completed         -> TASK_COMPLETE    { session_id, result }
 *   error (notification)   -> ERROR            { error }
 */

import * as fs from 'fs';
import * as os from 'os';
import {
  AppServerClient,
  AppServerClientOptions,
  AppServerError,
} from './app-server-client';
import {
  ErrorNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartResponse,
  TurnStartedNotification,
  UserInput,
} from './protocol-types';

/** Long enough to be worth waiting for, short enough not to stall a shutdown. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * One app-server per task means one codex process per task, each around 130MB.
 * Six is enough that a person driving sessions from the app never meets the
 * limit, and low enough that a runaway caller cannot spawn the machine to death.
 */
const DEFAULT_MAX_CONCURRENT_TASKS = 6;

/**
 * A turn streams deltas continuously, so total silence for this long means the
 * app-server is wedged rather than thinking. Reaping it costs an unfinished turn
 * and buys back the writer lock, which is the more valuable of the two.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface AdapterLimits {
  maxConcurrentTasks: number;
  idleTimeoutMs: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function defaultLimits(): AdapterLimits {
  return {
    maxConcurrentTasks: positiveIntEnv(
      'CODEX_MAX_CONCURRENT_TASKS',
      DEFAULT_MAX_CONCURRENT_TASKS
    ),
    idleTimeoutMs: positiveIntEnv(
      'CODEX_TASK_IDLE_TIMEOUT_MS',
      DEFAULT_IDLE_TIMEOUT_MS
    ),
  };
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

interface RunningTask {
  taskId: string;
  threadId: string;
  turnId: string | null;
  context: string;
  client: AppServerClient;
  released: boolean;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Server-side conditions worth explaining rather than repeating verbatim. The
 * raw text is a JSON-RPC message aimed at a client author, and the user reading
 * it needs to know which of their own windows to go and close.
 */
const ERROR_EXPLANATIONS: {
  match: RegExp;
  explanation: string;
  /** Offered to the user as an action alongside the message, when set. */
  recovery?: string;
}[] = [
  {
    match: /already has (an active|a live local) writer/i,
    explanation:
      'It appears that this session is open in your terminal. Cmd+Ctrl cannot interact with it as long as it is open there.',
    recovery: 'force_quit_session',
  },
  {
    match: /already has an active or pending turn/i,
    explanation:
      'This session is already working on something. Wait for it to finish, then try again.',
  },
];

/** The message text the server sent, without JSON-RPC framing. */
function serverMessageOf(err: unknown): string {
  if (err instanceof AppServerError) return err.serverMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * What to show the user for a failed app-server call. Never the JSON-RPC code:
 * "-32600" tells them nothing they can act on.
 */
export function describeAppServerError(err: unknown): string {
  return explainAppServerError(err).error;
}

/**
 * The user-facing text for a failed app-server call, plus the action that would
 * clear it where one exists. Never the JSON-RPC code: "-32600" tells them
 * nothing they can act on.
 */
export function explainAppServerError(err: unknown): {
  error: string;
  recovery?: string;
} {
  const message = serverMessageOf(err);
  for (const { match, explanation, recovery } of ERROR_EXPLANATIONS) {
    if (match.test(message)) return { error: explanation, recovery };
  }
  return { error: message };
}

/**
 * Whether a resume failed because the thread is gone rather than busy – the
 * caller starts a fresh session instead of surfacing an error.
 */
export function isThreadMissing(err: unknown): boolean {
  return /not found|no such thread|no session|no rollout found/i.test(
    serverMessageOf(err)
  );
}

function progressForItem(
  item: ThreadItem
): { action: string; target: string } | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        action: 'running command',
        target: (item as { command: string }).command.slice(0, 80),
      };
    case 'fileChange':
      return { action: 'editing files', target: '' };
    case 'webSearch':
      return {
        action: 'web search',
        target: (item as { query: string }).query.slice(0, 80),
      };
    case 'mcpToolCall': {
      const t = item as { server: string; tool: string };
      return { action: 'mcp tool', target: `${t.server}.${t.tool}` };
    }
    case 'plan':
      return { action: 'planning', target: '' };
    case 'reasoning':
      return { action: 'thinking', target: '' };
    default:
      return null;
  }
}

/** Injectable so the release-on-exit paths can be exercised without spawning codex. */
export type AppServerClientFactory = (
  options: AppServerClientOptions
) => AppServerClient;

export class CodexAdapter {
  private running = new Map<string, RunningTask>();

  /**
   * Sessions whose app-server has been told to stop but has not exited yet.
   * The lock survives until it does, so for those few seconds the process is
   * still ours – long enough for a force quit to find it and claim it closed
   * the user's terminal.
   */
  private releasing = new Set<string>();

  constructor(
    private onEvent: EventCallback,
    private clientVersion?: string,
    private createClient: AppServerClientFactory = (options) =>
      new AppServerClient(options),
    private limits: AdapterLimits = defaultLimits()
  ) {}

  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] startTask: ${instruction.slice(0, 50)}...`);
    const cwd = this.resolveCwd(taskId, projectPath);

    const rt = await this.beginTask(taskId, '');
    if (!rt) return;

    let threadResp: ThreadStartResponse;
    try {
      threadResp = await rt.client.request<ThreadStartResponse>('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
    } catch (err) {
      this.failTask(taskId, err);
      return;
    }

    rt.threadId = threadResp.thread.id;
    this.onEvent(taskId, 'SESSION_STARTED', { session_id: rt.threadId });

    await this.startTurn(rt, instruction);
  }

  async resumeTask(
    taskId: string,
    threadId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(
      `[${taskId}] resumeTask thread=${threadId}: ${message.slice(0, 50)}...`
    );
    const cwd = this.resolveCwd(taskId, projectPath);

    const rt = await this.beginTask(taskId, threadId);
    if (!rt) return;

    try {
      await rt.client.request<ThreadResumeResponse>('thread/resume', {
        threadId,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        persistExtendedHistory: false,
      });
    } catch (err) {
      if (isThreadMissing(err)) {
        console.log(`[${taskId}] Thread not found, falling back to new session`);
        this.releaseTask(taskId);
        await this.startTask(taskId, message, projectPath);
        return;
      }
      this.failTask(taskId, err);
      return;
    }

    await this.startTurn(rt, message);
  }

  async cancelTask(taskId: string): Promise<void> {
    const rt = this.running.get(taskId);
    if (!rt) return;
    console.log(`[${taskId}] cancelTask`);
    if (rt.threadId && rt.turnId) {
      try {
        await rt.client.request(
          'turn/interrupt',
          { threadId: rt.threadId, turnId: rt.turnId },
          INTERRUPT_TIMEOUT_MS
        );
      } catch (err) {
        console.error(`[${taskId}] turn/interrupt failed:`, err);
      }
    }
    this.releaseTask(taskId);
  }

  async stopAll(): Promise<void> {
    for (const taskId of Array.from(this.running.keys())) {
      await this.cancelTask(taskId);
    }
  }

  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
  }

  /**
   * Whether this daemon is currently running a turn on a session.
   *
   * Force quit asks this before it signals anything. Excluding our own
   * app-server by pid does not work: the npm install of codex is a
   * `#!/usr/bin/env node` wrapper that spawns the Rust binary as a grandchild,
   * and it is the grandchild that takes the writer lock – so the pid we spawned
   * is never the pid holding the lock. Session identity is the thing we
   * actually know, so that is what the refusal is built on.
   */
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId) || this.releasing.has(sessionId);
  }

  // --- task lifecycle ----------------------------------------------------

  /**
   * Register the task and bring up the app-server that will own its thread.
   * Null means the task already failed and was reported.
   */
  private async beginTask(
    taskId: string,
    threadId: string
  ): Promise<RunningTask | null> {
    // taskId is the session's canonical id, stable across turns, and nothing
    // upstream stops a second message arriving while the first turn runs.
    // Overwriting the map entry would strand the first app-server with the
    // writer lock still open and no handle left to stop it.
    if (this.running.has(taskId)) {
      this.onEvent(taskId, 'ERROR', {
        error:
          'This session is already working on something. Wait for it to finish, then try again.',
      });
      return null;
    }

    if (this.running.size >= this.limits.maxConcurrentTasks) {
      // Spawning anyway would trade a lock bug for a fork bomb.
      this.onEvent(taskId, 'ERROR', {
        error:
          `Too many Codex tasks running at once (limit ${this.limits.maxConcurrentTasks}). ` +
          'Wait for one to finish, then try again.',
      });
      return null;
    }

    let rt: RunningTask | null = null;
    const client = this.createClient({
      clientName: 'cmdctrl-codex-cli',
      clientVersion: this.clientVersion ?? '0.0.0',
      onExit: (err) => {
        if (!rt || !this.isCurrent(rt)) return;
        console.error(`[${taskId}] app-server exited:`, err.message);
        this.failTask(taskId, err);
      },
    });

    rt = {
      taskId,
      threadId,
      turnId: null,
      context: '',
      client,
      released: false,
      idleTimer: null,
    };
    this.running.set(taskId, rt);
    this.subscribe(rt);
    this.touch(rt);

    try {
      await client.start();
    } catch (err) {
      this.failTask(taskId, err);
      return null;
    }
    return rt;
  }

  /**
   * Whether this task object is still the one registered under its id. Handlers
   * hold their task by reference, so acting without this check would let a
   * stale one stop a later task's app-server or report on its behalf.
   */
  private isCurrent(rt: RunningTask): boolean {
    return this.running.get(rt.taskId) === rt;
  }

  private subscribe(rt: RunningTask): void {
    const on = (event: string, handle: (params: unknown) => void) =>
      rt.client.on(event, (params) => {
        if (!this.isCurrent(rt)) return;
        this.touch(rt);
        handle(params);
      });

    on('turn/started', (p) => this.handleTurnStarted(rt, p));
    on('item/started', (p) => this.handleItemStarted(rt, p));
    on('item/completed', (p) => this.handleItemCompleted(rt, p));
    on('turn/completed', (p) => this.handleTurnCompleted(rt, p));
    on('error', (p) => this.handleErrorNotification(rt, p));
  }

  /**
   * Restart the task's idle countdown. Any traffic from the app-server proves it
   * is alive; running out means nobody will ever release the lock for us.
   */
  private touch(rt: RunningTask): void {
    if (rt.released) return;
    if (rt.idleTimer) clearTimeout(rt.idleTimer);
    rt.idleTimer = setTimeout(() => {
      if (!this.isCurrent(rt)) return;
      console.error(
        `[${rt.taskId}] No app-server activity for ${this.limits.idleTimeoutMs}ms – releasing the thread`
      );
      this.failTask(rt.taskId, new Error('Codex stopped responding'));
    }, this.limits.idleTimeoutMs);
    rt.idleTimer.unref?.();
  }

  private async startTurn(rt: RunningTask, text: string): Promise<void> {
    try {
      const turnResp = await rt.client.request<TurnStartResponse>('turn/start', {
        threadId: rt.threadId,
        input: [userText(text)],
      });
      rt.turnId = turnResp.turn.id;
    } catch (err) {
      this.failTask(rt.taskId, err);
    }
  }

  /** Report the failure once, then hand the thread back. */
  private failTask(taskId: string, err: unknown): void {
    // releaseTask drops the task from the map, so a second failure is a no-op.
    const rt = this.running.get(taskId);
    if (!rt) return;
    this.onEvent(taskId, 'ERROR', { ...explainAppServerError(err) });
    this.releaseTask(taskId);
  }

  /**
   * Drop the task's app-server. Idempotent, and the only thing that frees the
   * thread for the user's own `codex resume`.
   */
  private releaseTask(taskId: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;
    rt.released = true;
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = null;
    }
    this.running.delete(taskId);
    this.releasing.add(taskId);
    void rt.client
      .stop()
      .catch((err) => {
        console.error(`[${taskId}] Failed to stop app-server:`, err);
      })
      .finally(() => {
        this.releasing.delete(taskId);
      });
  }

  // --- notification handlers --------------------------------------------

  private handleTurnStarted(rt: RunningTask, params: unknown): void {
    rt.turnId = (params as TurnStartedNotification).turn.id;
  }

  private handleItemStarted(rt: RunningTask, params: unknown): void {
    const progress = progressForItem((params as ItemStartedNotification).item);
    if (progress) {
      this.onEvent(rt.taskId, 'PROGRESS', progress);
    }
  }

  private handleItemCompleted(rt: RunningTask, params: unknown): void {
    const item = (params as ItemCompletedNotification).item;

    if (item.type === 'agentMessage') {
      const text = (item as { text?: string }).text || '';
      if (text) {
        if (rt.context) rt.context += '\n\n';
        rt.context += text;
      }
      return;
    }

    if (item.type === 'commandExecution') {
      const ce = item as { command: string; aggregatedOutput: string | null };
      if (ce.aggregatedOutput) {
        const truncated =
          ce.aggregatedOutput.length > 500
            ? ce.aggregatedOutput.slice(0, 500) + '...'
            : ce.aggregatedOutput;
        this.onEvent(rt.taskId, 'OUTPUT', {
          output: `$ ${ce.command}\n${truncated}`,
        });
      }
      return;
    }

    const progress = progressForItem(item);
    if (progress) {
      this.onEvent(rt.taskId, 'PROGRESS', progress);
    }
  }

  private handleTurnCompleted(rt: RunningTask, params: unknown): void {
    const p = params as TurnCompletedNotification;

    if (p.turn.status === 'failed') {
      this.onEvent(rt.taskId, 'ERROR', {
        error:
          (p.turn.error as { message?: string } | null)?.message ||
          'Turn failed',
      });
    } else if (p.turn.status === 'interrupted') {
      this.onEvent(rt.taskId, 'ERROR', { error: 'Turn interrupted' });
    } else {
      this.onEvent(rt.taskId, 'TASK_COMPLETE', {
        session_id: rt.threadId,
        result: rt.context || '',
      });
    }
    this.releaseTask(rt.taskId);
  }

  /**
   * An error the server will retry is progress reporting; the turn is still
   * live. One it will not retry ends the task, and telling the user it failed
   * while still holding their thread is the whole defect – so that path
   * releases.
   */
  private handleErrorNotification(rt: RunningTask, params: unknown): void {
    const p = params as ErrorNotification;
    const msg =
      (p.error as { message?: string })?.message || 'Unknown app-server error';
    console.error(`[${rt.taskId}] app-server error: ${msg}`);
    if (p?.willRetry) {
      this.onEvent(rt.taskId, 'ERROR', { error: msg });
      return;
    }
    this.failTask(rt.taskId, new Error(msg));
  }

  // --- helpers ----------------------------------------------------------

  private resolveCwd(taskId: string, projectPath?: string): string {
    if (projectPath && fs.existsSync(projectPath)) return projectPath;
    if (projectPath) {
      console.log(
        `[${taskId}] Warning: project path does not exist: ${projectPath}`
      );
    }
    return os.homedir();
  }
}

function userText(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}
