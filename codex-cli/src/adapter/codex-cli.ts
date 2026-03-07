/**
 * Codex CLI Adapter
 *
 * Spawns the Codex CLI in headless mode with `codex exec --json`
 * and translates the JSONL event stream into CmdCtrl daemon events.
 *
 * Codex CLI commands:
 *   New session:    codex exec --json --full-auto "instruction"
 *   Resume session: codex exec resume --json --full-auto <thread-id> "message"
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexStreamEvent, CodexItemEvent, extractProgressFromItem } from './events';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function findCodexCli(): string {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    'codex' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'codex') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      continue;
    }
  }

  return 'codex';
}

interface RunningTask {
  taskId: string;
  threadId: string;
  context: string;
  process: ChildProcess | null;
  timeoutHandle: NodeJS.Timeout | null;
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

export class CodexAdapter {
  private running: Map<string, RunningTask> = new Map();
  private onEvent: EventCallback;

  constructor(onEvent: EventCallback) {
    this.onEvent = onEvent;
  }

  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Starting Codex task: ${instruction.substring(0, 50)}...`);

    const rt: RunningTask = {
      taskId,
      threadId: '',
      context: '',
      process: null,
      timeoutHandle: null,
    };
    this.running.set(taskId, rt);

    let cwd: string | undefined = undefined;
    if (projectPath && fs.existsSync(projectPath)) {
      cwd = projectPath;
    } else if (projectPath) {
      console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}`);
      cwd = os.homedir();
    }

    // codex exec --json --full-auto --skip-git-repo-check "instruction"
    const args = [
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      instruction,
    ];

    console.log(`[${taskId}] Spawning: ${findCodexCli()} exec --json --full-auto --skip-git-repo-check`);

    const proc = spawn(findCodexCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    rt.process = proc;
    rt.timeoutHandle = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      proc.kill('SIGKILL');
      this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
    }, DEFAULT_TIMEOUT);

    this.handleProcessOutput(taskId, proc, rt);
  }

  async resumeTask(
    taskId: string,
    threadId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Resuming Codex thread ${threadId}: ${message.substring(0, 50)}...`);

    const rt: RunningTask = {
      taskId,
      threadId,
      context: '',
      process: null,
      timeoutHandle: null,
    };
    this.running.set(taskId, rt);

    let cwd: string | undefined = undefined;
    if (projectPath && fs.existsSync(projectPath)) {
      cwd = projectPath;
    } else if (projectPath) {
      cwd = os.homedir();
    }

    // codex exec resume --json --full-auto --skip-git-repo-check <thread-id> "message"
    const args = [
      'exec',
      'resume',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      threadId,
      message,
    ];

    console.log(`[${taskId}] Spawning resume: codex exec resume ${threadId}`);

    const proc = spawn(findCodexCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    rt.process = proc;

    // Track session-not-found for fallback
    let sessionNotFound = false;

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      console.log(`[${taskId}] stderr: ${text}`);
      if (text.includes('not found') || text.includes('No session') || text.includes('no such thread')) {
        sessionNotFound = true;
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && sessionNotFound) {
        console.log(`[${taskId}] Thread not found, falling back to new session`);
        if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
        this.running.delete(taskId);
        this.startTask(taskId, message, projectPath);
        return;
      }
      console.log(`[${taskId}] Process exited with code ${code}`);
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      // Emit TASK_COMPLETE on clean exit for resumed tasks
      if (this.running.has(taskId) && code === 0) {
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.threadId,
          result: rt.context || '',
        });
      }
      this.running.delete(taskId);
    });

    rt.timeoutHandle = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      proc.kill('SIGKILL');
      this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
    }, DEFAULT_TIMEOUT);

    // Parse stdout only (close handled above)
    this.handleProcessOutputWithoutClose(taskId, proc, rt);
  }

  async cancelTask(taskId: string): Promise<void> {
    const rt = this.running.get(taskId);
    if (!rt) return;
    if (rt.process) rt.process.kill('SIGTERM');
    if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
    this.running.delete(taskId);
    console.log(`[${taskId}] Task cancelled`);
  }

  async stopAll(): Promise<void> {
    for (const [taskId, rt] of this.running) {
      console.log(`[${taskId}] Stopping task`);
      if (rt.process) rt.process.kill('SIGTERM');
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
    }
    this.running.clear();
  }

  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
  }

  private handleProcessOutput(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask
  ): void {
    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as CodexStreamEvent;
        this.handleStreamEvent(taskId, event, rt);
      } catch {
        // Not valid JSON, skip
      }
    });

    proc.stderr?.on('data', (data) => {
      console.log(`[${taskId}] stderr: ${data.toString()}`);
    });

    proc.on('close', (code) => {
      console.log(`[${taskId}] Process exited with code ${code}`);
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      // If we never got a TASK_COMPLETE, emit one on clean exit
      if (this.running.has(taskId) && code === 0) {
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.threadId,
          result: rt.context || '',
        });
      }
      this.running.delete(taskId);
    });

    proc.on('error', (err) => {
      console.error(`[${taskId}] Process error:`, err);
      this.onEvent(taskId, 'ERROR', { error: err.message });
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      this.running.delete(taskId);
    });
  }

  private handleProcessOutputWithoutClose(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask
  ): void {
    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as CodexStreamEvent;
        this.handleStreamEvent(taskId, event, rt);
      } catch {
        // skip
      }
    });

    proc.on('error', (err) => {
      console.error(`[${taskId}] Process error:`, err);
      this.onEvent(taskId, 'ERROR', { error: err.message });
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      this.running.delete(taskId);
    });
  }

  /**
   * Handle a parsed Codex exec --json event and translate to CmdCtrl events.
   *
   * Codex events -> CmdCtrl events:
   *   thread.started  -> SESSION_STARTED
   *   item.started    -> PROGRESS (for commands, file changes, etc.)
   *   item.completed  -> OUTPUT (for agent_message), PROGRESS (for others)
   *   turn.completed  -> (internal, used for final result assembly)
   *   turn.failed     -> ERROR
   *   error           -> ERROR
   */
  private handleStreamEvent(
    taskId: string,
    event: CodexStreamEvent,
    rt: RunningTask
  ): void {
    console.log(`[${taskId}] Codex event: type=${event.type}`);

    switch (event.type) {
      case 'thread.started':
        rt.threadId = event.thread_id;
        console.log(`[${taskId}] Thread started: ${event.thread_id}`);
        this.onEvent(taskId, 'SESSION_STARTED', {
          session_id: event.thread_id,
        });
        break;

      case 'item.started': {
        const itemEvent = event as CodexItemEvent;
        const progress = extractProgressFromItem(itemEvent.item);
        if (progress) {
          this.onEvent(taskId, 'PROGRESS', {
            action: progress.action,
            target: progress.target,
          });
        }
        break;
      }

      case 'item.completed': {
        const itemEvent = event as CodexItemEvent;
        const item = itemEvent.item;

        if (item.type === 'agent_message') {
          const text = item.content || item.text || '';
          if (text) {
            if (rt.context) rt.context += '\n\n';
            rt.context += text;
            // Don't emit OUTPUT for agent_message — the watcher delivers this as AGENT_RESPONSE
          }
        } else if (item.type === 'command_execution') {
          if (item.output) {
            const truncated = item.output.length > 500
              ? item.output.substring(0, 500) + '...'
              : item.output;
            this.onEvent(taskId, 'OUTPUT', {
              output: `$ ${item.command}\n${truncated}`,
            });
          }
        } else {
          const progress = extractProgressFromItem(item);
          if (progress) {
            this.onEvent(taskId, 'PROGRESS', {
              action: progress.action,
              target: progress.target,
            });
          }
        }
        break;
      }

      case 'turn.completed':
        // Turn completed - Codex may have multiple turns, so we don't
        // emit TASK_COMPLETE here. We rely on process close for that.
        console.log(`[${taskId}] Turn completed (tokens: ${JSON.stringify(event.usage || {})})`);
        break;

      case 'turn.failed':
        console.error(`[${taskId}] Turn failed: ${event.error}`);
        this.onEvent(taskId, 'ERROR', {
          error: event.error || 'Turn failed',
        });
        break;

      case 'error':
        console.error(`[${taskId}] Codex error: ${event.message || event.error}`);
        this.onEvent(taskId, 'ERROR', {
          error: event.message || event.error || 'Unknown Codex error',
        });
        break;
    }
  }
}
