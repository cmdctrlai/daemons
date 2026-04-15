/**
 * CodexAdapter
 *
 * Drives `codex app-server` over JSON-RPC 2.0 (stdio) to manage Codex threads
 * and turns on behalf of the CmdCtrl daemon. One long-lived app-server process
 * handles every task; individual tasks are routed by threadId.
 *
 * Event translation:
 *
 *   thread/started         -> SESSION_STARTED  { session_id }
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
import { AppServerClient } from './app-server-client';
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
  completed: boolean;
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

export class CodexAdapter {
  private client: AppServerClient;
  private running = new Map<string, RunningTask>();
  /** threadId -> taskId, for routing notifications back to the task. */
  private threadToTask = new Map<string, string>();
  private started = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private onEvent: EventCallback,
    clientVersion?: string
  ) {
    this.client = new AppServerClient({
      clientName: 'cmdctrl-codex-cli',
      clientVersion: clientVersion ?? '0.0.0',
      onReady: () => this.handleReady(),
    });

    this.client.on('thread/started', (p) => this.handleThreadStarted(p));
    this.client.on('turn/started', (p) => this.handleTurnStarted(p));
    this.client.on('item/started', (p) => this.handleItemStarted(p));
    this.client.on('item/completed', (p) => this.handleItemCompleted(p));
    this.client.on('turn/completed', (p) => this.handleTurnCompleted(p));
    this.client.on('error', (p) => this.handleErrorNotification(p));
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this.client.start().then(() => {
        this.started = true;
      });
    }
    await this.startPromise;
  }

  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] startTask: ${instruction.slice(0, 50)}...`);
    await this.ensureStarted();

    const cwd = this.resolveCwd(taskId, projectPath);

    const rt: RunningTask = {
      taskId,
      threadId: '',
      turnId: null,
      context: '',
      completed: false,
    };
    this.running.set(taskId, rt);

    let threadResp: ThreadStartResponse;
    try {
      threadResp = await this.client.request<ThreadStartResponse>(
        'thread/start',
        {
          cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }
      );
    } catch (err) {
      this.running.delete(taskId);
      this.onEvent(taskId, 'ERROR', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    rt.threadId = threadResp.thread.id;
    this.threadToTask.set(rt.threadId, taskId);
    this.onEvent(taskId, 'SESSION_STARTED', { session_id: rt.threadId });

    try {
      const turnResp = await this.client.request<TurnStartResponse>(
        'turn/start',
        {
          threadId: rt.threadId,
          input: [userText(instruction)],
        }
      );
      rt.turnId = turnResp.turn.id;
    } catch (err) {
      this.onEvent(taskId, 'ERROR', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.threadToTask.delete(rt.threadId);
      this.running.delete(taskId);
    }
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
    await this.ensureStarted();

    const cwd = this.resolveCwd(taskId, projectPath);

    const rt: RunningTask = {
      taskId,
      threadId,
      turnId: null,
      context: '',
      completed: false,
    };
    this.running.set(taskId, rt);
    this.threadToTask.set(threadId, taskId);

    try {
      await this.client.request<ThreadResumeResponse>('thread/resume', {
        threadId,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        persistExtendedHistory: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /not found/i.test(msg) ||
        /no such thread/i.test(msg) ||
        /no session/i.test(msg)
      ) {
        console.log(`[${taskId}] Thread not found, falling back to new session`);
        this.threadToTask.delete(threadId);
        this.running.delete(taskId);
        await this.startTask(taskId, message, projectPath);
        return;
      }
      this.onEvent(taskId, 'ERROR', { error: msg });
      this.threadToTask.delete(threadId);
      this.running.delete(taskId);
      return;
    }

    try {
      const turnResp = await this.client.request<TurnStartResponse>(
        'turn/start',
        { threadId, input: [userText(message)] }
      );
      rt.turnId = turnResp.turn.id;
    } catch (err) {
      this.onEvent(taskId, 'ERROR', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.threadToTask.delete(threadId);
      this.running.delete(taskId);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const rt = this.running.get(taskId);
    if (!rt) return;
    console.log(`[${taskId}] cancelTask`);
    if (rt.threadId && rt.turnId) {
      try {
        await this.client.request('turn/interrupt', {
          threadId: rt.threadId,
          turnId: rt.turnId,
        });
      } catch (err) {
        console.error(`[${taskId}] turn/interrupt failed:`, err);
      }
    }
    this.cleanupTask(taskId);
  }

  async stopAll(): Promise<void> {
    const taskIds = Array.from(this.running.keys());
    for (const id of taskIds) {
      await this.cancelTask(id);
    }
    await this.client.stop();
    this.started = false;
    this.startPromise = null;
  }

  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
  }

  // --- notification handlers --------------------------------------------

  private handleReady(): void {
    // On reconnect, re-resume any live threads so we keep receiving events.
    for (const rt of this.running.values()) {
      if (!rt.threadId || rt.completed) continue;
      console.log(
        `[${rt.taskId}] Re-resuming thread ${rt.threadId} after app-server restart`
      );
      this.client
        .request('thread/resume', {
          threadId: rt.threadId,
          persistExtendedHistory: false,
        })
        .catch((err) => {
          console.error(`[${rt.taskId}] Re-resume after restart failed:`, err);
        });
    }
  }

  private handleThreadStarted(params: unknown): void {
    const p = params as { thread?: { id?: string } };
    const threadId = p.thread?.id;
    if (!threadId) return;
    const taskId = this.threadToTask.get(threadId);
    if (!taskId) return;
    console.log(`[${taskId}] thread/started ${threadId}`);
  }

  private handleTurnStarted(params: unknown): void {
    const p = params as TurnStartedNotification;
    const taskId = this.threadToTask.get(p.threadId);
    if (!taskId) return;
    const rt = this.running.get(taskId);
    if (rt) rt.turnId = p.turn.id;
  }

  private handleItemStarted(params: unknown): void {
    const p = params as ItemStartedNotification;
    const taskId = this.threadToTask.get(p.threadId);
    if (!taskId) return;
    const progress = progressForItem(p.item);
    if (progress) {
      this.onEvent(taskId, 'PROGRESS', progress);
    }
  }

  private handleItemCompleted(params: unknown): void {
    const p = params as ItemCompletedNotification;
    const taskId = this.threadToTask.get(p.threadId);
    if (!taskId) return;
    const rt = this.running.get(taskId);
    if (!rt) return;
    const item = p.item;

    if (item.type === 'agentMessage') {
      const text = (item as { text?: string }).text || '';
      if (text) {
        if (rt.context) rt.context += '\n\n';
        rt.context += text;
      }
      return;
    }

    if (item.type === 'commandExecution') {
      const ce = item as {
        command: string;
        aggregatedOutput: string | null;
      };
      if (ce.aggregatedOutput) {
        const truncated =
          ce.aggregatedOutput.length > 500
            ? ce.aggregatedOutput.slice(0, 500) + '...'
            : ce.aggregatedOutput;
        this.onEvent(taskId, 'OUTPUT', {
          output: `$ ${ce.command}\n${truncated}`,
        });
      }
      return;
    }

    const progress = progressForItem(item);
    if (progress) {
      this.onEvent(taskId, 'PROGRESS', progress);
    }
  }

  private handleTurnCompleted(params: unknown): void {
    const p = params as TurnCompletedNotification;
    const taskId = this.threadToTask.get(p.threadId);
    if (!taskId) return;
    const rt = this.running.get(taskId);
    if (!rt) return;

    rt.completed = true;
    if (p.turn.status === 'failed') {
      this.onEvent(taskId, 'ERROR', {
        error:
          (p.turn.error as { message?: string } | null)?.message ||
          'Turn failed',
      });
    } else if (p.turn.status === 'interrupted') {
      this.onEvent(taskId, 'ERROR', { error: 'Turn interrupted' });
    } else {
      this.onEvent(taskId, 'TASK_COMPLETE', {
        session_id: rt.threadId,
        result: rt.context || '',
      });
    }
    this.cleanupTask(taskId);
  }

  private handleErrorNotification(params: unknown): void {
    const p = params as ErrorNotification;
    const taskId = this.threadToTask.get(p.threadId);
    if (!taskId) return;
    const msg =
      (p.error as { message?: string })?.message || 'Unknown app-server error';
    console.error(`[${taskId}] app-server error: ${msg}`);
    this.onEvent(taskId, 'ERROR', { error: msg });
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

  private cleanupTask(taskId: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;
    if (rt.threadId) this.threadToTask.delete(rt.threadId);
    this.running.delete(taskId);
  }
}

function userText(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}
