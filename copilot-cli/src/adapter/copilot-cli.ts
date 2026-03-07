/**
 * Copilot CLI Adapter
 *
 * Spawns the Copilot CLI in non-interactive mode with `copilot -p "instruction"`
 * and captures stdout as the agent response.
 *
 * Copilot CLI commands:
 *   New session:    copilot -p "instruction" --allow-all-tools --silent
 *   Resume session: copilot --resume <session-id> -p "message" --allow-all-tools --silent
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function findCopilotCli(): string {
  if (process.env.COPILOT_CLI_PATH) {
    return process.env.COPILOT_CLI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'copilot'),
    path.join(home, '.npm-global', 'bin', 'copilot'),
    '/usr/local/bin/copilot',
    '/opt/homebrew/bin/copilot',
    'copilot' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'copilot') return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      continue;
    }
  }

  return 'copilot';
}

/**
 * Find the most recently created session in ~/.copilot/session-state/
 * that was created after the given timestamp.
 */
function findNewSessionId(afterTimestamp: number): string | null {
  const sessionDir = path.join(os.homedir(), '.copilot', 'session-state');
  if (!fs.existsSync(sessionDir)) return null;

  let newest: { id: string; mtime: number } | null = null;

  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventsFile = path.join(sessionDir, entry.name, 'events.jsonl');
      try {
        const stat = fs.statSync(eventsFile);
        if (stat.mtimeMs > afterTimestamp && (!newest || stat.mtimeMs > newest.mtime)) {
          newest = { id: entry.name, mtime: stat.mtimeMs };
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return newest?.id || null;
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

export class CopilotAdapter {
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
    console.log(`[${taskId}] Starting Copilot task: ${instruction.substring(0, 50)}...`);

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

    const startTimestamp = Date.now();

    // copilot -p "instruction" --allow-all-tools --silent
    const args = [
      '-p', instruction,
      '--allow-all-tools',
      '--silent',
    ];

    console.log(`[${taskId}] Spawning: ${findCopilotCli()} -p "..." --allow-all-tools --silent`);

    const proc = spawn(findCopilotCli(), args, {
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

    this.onEvent(taskId, 'PROGRESS', {
      action: 'Working',
      target: instruction.substring(0, 40),
    });

    this.handleProcessOutput(taskId, proc, rt, startTimestamp);
  }

  async resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Resuming Copilot session ${sessionId}: ${message.substring(0, 50)}...`);

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

    // copilot --resume <session-id> -p "message" --allow-all-tools --silent
    const args = [
      '--resume', sessionId,
      '-p', message,
      '--allow-all-tools',
      '--silent',
    ];

    console.log(`[${taskId}] Spawning resume: copilot --resume ${sessionId} -p "..."`);

    const proc = spawn(findCopilotCli(), args, {
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
      if (text.includes('not found') || text.includes('No session') || text.includes('no such session')) {
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

    // Collect stdout (close handled above)
    this.collectStdoutWithoutClose(taskId, proc, rt);

    proc.on('error', (err) => {
      console.error(`[${taskId}] Process error:`, err);
      this.onEvent(taskId, 'ERROR', { error: err.message });
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);
      this.running.delete(taskId);
    });
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

  /**
   * Collect stdout text and handle process lifecycle for new tasks.
   * After process exits, discover the session ID from the filesystem.
   */
  private handleProcessOutput(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask,
    startTimestamp: number
  ): void {
    let output = '';

    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
    });

    proc.stderr?.on('data', (data) => {
      console.log(`[${taskId}] stderr: ${data.toString()}`);
    });

    proc.on('close', (code) => {
      console.log(`[${taskId}] Process exited with code ${code}`);
      if (rt.timeoutHandle) clearTimeout(rt.timeoutHandle);

      if (this.running.has(taskId)) {
        // Discover session ID from filesystem
        const sessionId = findNewSessionId(startTimestamp);
        if (sessionId) {
          rt.sessionId = sessionId;
          this.onEvent(taskId, 'SESSION_STARTED', { session_id: sessionId });
        }

        rt.context = output.trim();
        if (rt.context) {
          this.onEvent(taskId, 'OUTPUT', { output: rt.context });
        }

        if (code === 0) {
          this.onEvent(taskId, 'TASK_COMPLETE', {
            session_id: rt.sessionId,
            result: rt.context,
          });
        } else {
          this.onEvent(taskId, 'ERROR', {
            error: `Process exited with code ${code}`,
          });
        }
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

  /**
   * Collect stdout for resumed tasks (close handled by caller).
   */
  private collectStdoutWithoutClose(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask
  ): void {
    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      rt.context += text;
    });
  }
}
