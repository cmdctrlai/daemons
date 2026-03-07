/**
 * Cursor CLI Adapter
 *
 * Spawns cursor-agent in headless mode with --output-format stream-json
 * and translates the NDJSON event stream into CmdCtrl daemon events.
 *
 * Cursor CLI commands:
 *   New session:    cursor-agent -p "instruction" --output-format stream-json
 *   Resume session: cursor-agent --resume=<session-id> -p "message" --output-format stream-json
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StreamEvent, extractProgressFromToolCall } from './events';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function findCursorCli(): string {
  if (process.env.CURSOR_CLI_PATH) {
    return process.env.CURSOR_CLI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'cursor-agent'),
    path.join(home, '.cursor', 'bin', 'cursor-agent'),
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent',
    'cursor-agent'
  ];

  for (const p of commonPaths) {
    if (p === 'cursor-agent') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      continue;
    }
  }

  return 'cursor-agent';
}

interface RunningTask {
  taskId: string;
  sessionId: string;
  context: string;
  process: ChildProcess | null;
  timeoutHandle: NodeJS.Timeout | null;
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

export class CursorAdapter {
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
    console.log(`[${taskId}] Starting Cursor task: ${instruction.substring(0, 50)}...`);

    const rt: RunningTask = {
      taskId,
      sessionId: '',
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

    const args = [
      '-p', instruction,
      '--output-format', 'stream-json'
    ];

    console.log(`[${taskId}] Spawning: ${findCursorCli()} with cwd: ${cwd || 'default'}`);

    const proc = spawn(findCursorCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      },
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
    sessionId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Resuming Cursor session ${sessionId}: ${message.substring(0, 50)}...`);

    const rt: RunningTask = {
      taskId,
      sessionId,
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

    const args = [
      `--resume=${sessionId}`,
      '-p', message,
      '--output-format', 'stream-json'
    ];

    console.log(`[${taskId}] Spawning resume: cursor-agent --resume ${sessionId}`);

    const proc = spawn(findCursorCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      },
    });

    rt.process = proc;

    let sessionNotFound = false;

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      console.log(`[${taskId}] stderr: ${text}`);
      if (text.includes('not found') || text.includes('No session') || text.includes('invalid session')) {
        sessionNotFound = true;
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && sessionNotFound) {
        console.log(`[${taskId}] Session not found, falling back to new session`);
        if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
        this.running.delete(taskId);
        this.startTask(taskId, message, projectPath);
        return;
      }
      console.log(`[${taskId}] Process exited with code ${code}`);
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      if (this.running.has(taskId) && code === 0) {
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.sessionId,
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
        const event = JSON.parse(line) as StreamEvent;
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
      // Emit error if process exited non-zero and we haven't already emitted a result
      if (this.running.has(taskId) && code !== 0) {
        this.onEvent(taskId, 'ERROR', { error: `cursor-agent exited with code ${code}` });
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
        const event = JSON.parse(line) as StreamEvent;
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
   * Handle a parsed stream event from cursor-agent and translate to CmdCtrl events.
   *
   * cursor-agent events → CmdCtrl events:
   *   system (init)        → SESSION_STARTED
   *   user                 → (ignored, echo of input)
   *   thinking (delta)     → (accumulate context)
   *   thinking (completed) → (ignored)
   *   assistant            → OUTPUT
   *   tool_call            → PROGRESS
   *   tool_result          → OUTPUT (verbose)
   *   result (success)     → TASK_COMPLETE
   *   result (error)       → ERROR
   */
  private handleStreamEvent(
    taskId: string,
    event: StreamEvent,
    rt: RunningTask
  ): void {
    console.log(`[${taskId}] Cursor event: type=${event.type} subtype=${event.subtype || ''}`);

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && event.session_id) {
          rt.sessionId = event.session_id;
          console.log(`[${taskId}] Session initialized: ${event.session_id} (model: ${event.model})`);
          this.onEvent(taskId, 'SESSION_STARTED', {
            session_id: event.session_id,
          });
        }
        break;

      case 'user':
        // Echo of user input, ignore
        break;

      case 'thinking':
        // Accumulate thinking text but don't send as output (too noisy with deltas)
        if (event.subtype === 'delta' && event.text) {
          rt.context += event.text;
        }
        break;

      case 'assistant':
        if (event.message?.content) {
          const text = event.message.content
            .map(block => block.text || '')
            .join('')
            .trim();
          if (text) {
            // Reset context to assistant response (thinking was intermediate)
            rt.context = text;
            this.onEvent(taskId, 'OUTPUT', { output: text });
          }
        }
        break;

      case 'tool_call': {
        const progress = extractProgressFromToolCall(event);
        if (progress) {
          this.onEvent(taskId, 'PROGRESS', {
            action: progress.action,
            target: progress.target,
          });
        }
        break;
      }

      case 'tool_result':
        if (event.output) {
          const truncated = event.output.length > 500
            ? event.output.substring(0, 500) + '...'
            : event.output;
          this.onEvent(taskId, 'OUTPUT', {
            output: `[${event.status || 'done'}] ${truncated}`,
          });
        }
        break;

      case 'result': {
        if (event.is_error || event.subtype === 'error') {
          console.error(`[${taskId}] Cursor error: ${event.result}`);
          this.onEvent(taskId, 'ERROR', {
            error: event.result || 'Unknown Cursor error',
          });
        } else {
          const finalResult = event.result || rt.context || '';
          console.log(`[${taskId}] Task complete, result length: ${finalResult.length}`);
          this.onEvent(taskId, 'TASK_COMPLETE', {
            session_id: rt.sessionId,
            result: finalResult,
          });
        }
        this.running.delete(taskId);
        break;
      }
    }
  }
}
