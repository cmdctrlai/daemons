import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_AGENT_ID = 'main';

export function agentId(): string {
  return process.env.OPENCLAW_AGENT_ID || DEFAULT_AGENT_ID;
}

export function buildStartArgs(instruction: string): string[] {
  return ['agent', '--agent', agentId(), '--message', instruction, '--json'];
}

export function buildResumeArgs(sessionId: string, message: string): string[] {
  return ['agent', '--agent', agentId(), '--message', message, '--session-id', sessionId, '--json'];
}

/**
 * Callbacks the adapter uses to report back to the CmdCtrl server.
 * These mirror the SDK TaskHandle / ResumeHandle methods.
 */
export interface TaskCallbacks {
  sessionStarted(sessionId: string): void;
  progress(action: string, target: string): void;
  complete(result: string): void;
  error(message: string): void;
}

/**
 * Find the openclaw CLI binary.
 */
function findOpenClawCli(): string {
  if (process.env.OPENCLAW_CLI_PATH) {
    return process.env.OPENCLAW_CLI_PATH;
  }

  const home = os.homedir();
  const paths = [
    path.join(home, '.openclaw', 'bin', 'openclaw'),
    path.join(home, '.local', 'bin', 'openclaw'),
    path.join(home, '.npm-global', 'bin', 'openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  return 'openclaw'; // Fall back to PATH
}

/**
 * Find the last top-level JSON object in a string that may contain log lines.
 * Scans backwards from the final '}' and counts braces to find the matching '{'.
 */
function extractLastJsonObject(s: string): string | null {
  const end = s.lastIndexOf('}');
  if (end < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = end; i >= 0; i--) {
    const ch = s[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      // Next char (going backward) was escaped – but we're scanning backward,
      // so this backslash escapes the char at i+1. We need to count consecutive
      // backslashes to determine if the quote at i+1 was truly escaped.
      // Simpler: just try JSON.parse when we find a candidate '{'.
      continue;
    }

    if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '}') depth++;
    if (ch === '{') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(i, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Not valid JSON at this position, keep scanning
          depth++;
        }
      }
    }
  }

  return null;
}

/**
 * Extract a meaningful reply from OpenClaw's JSON output.
 *
 * OpenClaw emits its structured response on stderr (stdout may be empty).
 * The JSON shape is:
 *   { payloads: [{ text: "..." }], meta: { agentMeta: { sessionId: "..." } } }
 *
 * We also try generic field names as a fallback in case the schema changes.
 */
export function extractReply(output: string): { text: string; sessionId?: string } {
  const trimmed = output.trim();
  if (!trimmed) return { text: '' };

  // stderr may contain log lines before the JSON. The response is a single
  // pretty-printed JSON object at the end. Find it by matching the final '}'
  // back to its opening '{'.
  const jsonStr = extractLastJsonObject(trimmed) || trimmed;

  try {
    const parsed = JSON.parse(jsonStr);

    // OpenClaw shape: payloads[0].text
    const payloadText = Array.isArray(parsed.payloads)
      ? parsed.payloads.map((p: { text?: string }) => p.text || '').join('\n').trim()
      : undefined;

    // OpenClaw shape: meta.agentMeta.sessionId
    const sessionId =
      (parsed.meta?.agentMeta?.sessionId as string | undefined) ||
      (parsed.session_id as string | undefined) ||
      (parsed.sessionId as string | undefined) ||
      (parsed.session?.id as string | undefined);

    const text =
      payloadText ||
      (parsed.reply as string | undefined) ||
      (parsed.response as string | undefined) ||
      (parsed.text as string | undefined) ||
      (parsed.message as string | undefined) ||
      (parsed.content as string | undefined) ||
      (parsed.output as string | undefined) ||
      (parsed.result?.text as string | undefined) ||
      (parsed.result?.content as string | undefined) ||
      (typeof parsed.result === 'string' ? parsed.result : undefined) ||
      jsonStr;

    return { text, sessionId };
  } catch {
    return { text: trimmed };
  }
}

interface RunningTask {
  process: ChildProcess;
  timeout: NodeJS.Timeout;
}

export class OpenClawAdapter {
  private running = new Map<string, RunningTask>();

  /**
   * Start a new task by spawning `openclaw agent --message <instruction> --json`.
   */
  startTask(
    taskId: string,
    instruction: string,
    callbacks: TaskCallbacks,
    projectPath?: string,
  ): void {
    console.log(`[${taskId}] Starting: ${instruction.substring(0, 60)}...`);
    this.runAgent(taskId, buildStartArgs(instruction), callbacks, projectPath);
  }

  /**
   * Continue an existing session with a follow-up message.
   */
  resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    callbacks: TaskCallbacks,
    projectPath?: string,
  ): void {
    console.log(`[${taskId}] Resuming ${sessionId.slice(-8)}: ${message.substring(0, 60)}...`);
    this.runAgent(
      taskId,
      buildResumeArgs(sessionId, message),
      callbacks,
      projectPath,
    );
  }

  /**
   * Cancel a running task.
   */
  cancelTask(taskId: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;
    rt.process.kill('SIGTERM');
    clearTimeout(rt.timeout);
    this.running.delete(taskId);
    console.log(`[${taskId}] Cancelled`);
  }

  /**
   * Stop all running tasks (graceful shutdown).
   */
  stopAll(): void {
    for (const [taskId, rt] of this.running) {
      console.log(`[${taskId}] Stopping`);
      rt.process.kill('SIGTERM');
      clearTimeout(rt.timeout);
    }
    this.running.clear();
  }

  /**
   * List sessions via `openclaw sessions list --json --all-agents`.
   * Returns the parsed JSON array, or an empty array on failure.
   */
  listSessions(): unknown[] {
    const cli = findOpenClawCli();
    try {
      const output = execFileSync(cli, ['sessions', 'list', '--json', '--all-agents'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.sessions)) return parsed.sessions;
      return [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private resolveCwd(taskId: string, projectPath?: string): string | undefined {
    if (!projectPath) return undefined;
    if (fs.existsSync(projectPath)) return projectPath;
    console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}`);
    return os.homedir();
  }

  private runAgent(
    taskId: string,
    args: string[],
    cb: TaskCallbacks,
    projectPath?: string,
  ): void {
    const cli = findOpenClawCli();
    const cwd = this.resolveCwd(taskId, projectPath);

    const proc = spawn(cli, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      proc.kill('SIGKILL');
      cb.error('execution timeout');
    }, DEFAULT_TIMEOUT);

    this.running.set(taskId, { process: proc, timeout });

    let stdoutBuf = '';
    let stderrBuf = '';
    let sessionReported = false;

    cb.progress('Thinking', '');

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuf += text;
      console.log(`[${taskId}] stderr: ${text}`);
      // OpenClaw emits structured JSON on stderr – scan for session ID
      if (!sessionReported) {
        const match = stderrBuf.match(/"sessionId"\s*:\s*"([^"]+)"/);
        if (match) {
          sessionReported = true;
          cb.sessionStarted(match[1]);
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      this.running.delete(taskId);
      console.error(`[${taskId}] Process error:`, err);
      cb.error(err.message);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      this.running.delete(taskId);
      console.log(`[${taskId}] Process exited with code ${code}`);

      if (code !== 0) {
        const msg = stderrBuf.trim() || `openclaw exited with code ${code}`;
        cb.error(msg);
        return;
      }

      // OpenClaw emits its JSON response on stderr; stdout may be empty
      const { text, sessionId } = extractReply(stderrBuf || stdoutBuf);
      if (!sessionReported && sessionId) {
        cb.sessionStarted(sessionId);
      }
      cb.complete(text || 'No response');
    });
  }
}
