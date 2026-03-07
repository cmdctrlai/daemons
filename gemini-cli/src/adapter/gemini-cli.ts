/**
 * Gemini CLI Adapter
 *
 * Spawns the Gemini CLI in headless mode with --output-format stream-json
 * and translates the NDJSON event stream into CmdCtrl daemon events.
 *
 * Gemini CLI commands:
 *   New session:    gemini -p "instruction" --output-format stream-json -y
 *   Resume session: gemini -p "message" --resume <session-id> --output-format stream-json -y
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiStreamEvent, extractProgressFromToolUse } from './events';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function findGeminiCli(): string {
  if (process.env.GEMINI_CLI_PATH) {
    return process.env.GEMINI_CLI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'gemini'),
    path.join(home, '.npm-global', 'bin', 'gemini'),
    '/usr/local/bin/gemini',
    '/opt/homebrew/bin/gemini',
    'gemini' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'gemini') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      continue;
    }
  }

  return 'gemini';
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

export class GeminiAdapter {
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
    console.log(`[${taskId}] Starting Gemini task: ${instruction.substring(0, 50)}...`);

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

    // Gemini CLI headless args:
    //   -p <prompt>               Non-interactive mode
    //   --output-format stream-json  NDJSON event stream
    //   -y (--yolo)               Auto-approve tool executions
    const args = [
      '-p', instruction,
      '--output-format', 'stream-json',
      '-y'
    ];

    console.log(`[${taskId}] Spawning: ${findGeminiCli()} with cwd: ${cwd || 'default'}`);

    const proc = spawn(findGeminiCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    console.log(`[${taskId}] Resuming Gemini session ${sessionId}: ${message.substring(0, 50)}...`);

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

    // Resume with --resume <session-id>
    const args = [
      '-p', message,
      '--resume', sessionId,
      '--output-format', 'stream-json',
      '-y'
    ];

    console.log(`[${taskId}] Spawning resume: gemini --resume ${sessionId}`);

    const proc = spawn(findGeminiCli(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    rt.process = proc;

    // Track session-not-found for fallback
    let sessionNotFound = false;

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      console.log(`[${taskId}] stderr: ${text}`);
      // Gemini CLI may report session not found differently, catch common patterns
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
      // Emit TASK_COMPLETE on clean exit if not already emitted via 'result' event
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
        const event = JSON.parse(line) as GeminiStreamEvent;
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
        const event = JSON.parse(line) as GeminiStreamEvent;
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
   * Handle a parsed Gemini stream-json event and translate to CmdCtrl events.
   *
   * Gemini events → CmdCtrl events:
   *   init         → SESSION_STARTED
   *   message      → accumulate context / OUTPUT
   *   tool_use     → PROGRESS
   *   tool_result  → OUTPUT (verbose)
   *   error        → ERROR
   *   result       → TASK_COMPLETE
   */
  private handleStreamEvent(
    taskId: string,
    event: GeminiStreamEvent,
    rt: RunningTask
  ): void {
    console.log(`[${taskId}] Gemini event: type=${event.type}`);

    switch (event.type) {
      case 'init':
        if (event.session_id) {
          rt.sessionId = event.session_id;
          console.log(`[${taskId}] Session initialized: ${event.session_id} (model: ${event.model})`);
          this.onEvent(taskId, 'SESSION_STARTED', {
            session_id: event.session_id,
          });
        }
        break;

      case 'message':
        if (event.role === 'assistant' && event.content) {
          // Accumulate assistant text for the final result
          if (rt.context) rt.context += '\n\n';
          rt.context += event.content;

          // Send as verbose output for streaming display
          this.onEvent(taskId, 'OUTPUT', {
            output: event.content,
          });
        }
        break;

      case 'tool_use':
        if (event.tool_name) {
          const progress = extractProgressFromToolUse(event.tool_name, event.parameters);
          if (progress) {
            this.onEvent(taskId, 'PROGRESS', {
              action: progress.action,
              target: progress.target,
            });
          }
        }
        break;

      case 'tool_result':
        // Send tool results as verbose output
        if (event.output) {
          const truncated = event.output.length > 500
            ? event.output.substring(0, 500) + '...'
            : event.output;
          this.onEvent(taskId, 'OUTPUT', {
            output: `[${event.status}] ${truncated}`,
          });
        }
        break;

      case 'error':
        console.error(`[${taskId}] Gemini error: ${event.message}`);
        this.onEvent(taskId, 'ERROR', {
          error: event.message || 'Unknown Gemini error',
        });
        break;

      case 'result': {
        // Task completed - use accumulated context or the result response
        const finalResult = rt.context || event.response || '';
        console.log(`[${taskId}] Task complete, result length: ${finalResult.length}`);
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.sessionId,
          result: finalResult,
        });
        // Mark as completed so close handler doesn't emit a duplicate
        this.running.delete(taskId);
        break;
      }
    }
  }
}
