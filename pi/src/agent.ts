/**
 * Pi agent integration.
 *
 * Spawns the `pi` CLI in JSON event-stream mode (`--mode json -p`) for each
 * task. Pi owns session storage: on a fresh task we pass no `--session`, and
 * pi writes the new session file at `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`.
 * We capture the session id from the first `{"type":"session",...}` event in
 * the event stream and surface it as our native session id. On resume, we
 * point pi at the same file via `--session <path>`, which we resolve through
 * `SessionManager.list(cwd)` – no hand-rolled path math and the session
 * remains visible to `pi --resume`.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import { PI_BIN } from './context';
import { resolveSessionPath } from './session-reader';

export type ProgressFn = (action: string, target: string) => void;

export interface RunResult {
  /** pi's session id – captured from the first session event, or the resumed id. */
  sessionId: string;
  /** Assistant text collected across message_end events. */
  result: string;
}

const running = new Map<string, ChildProcess>();

function validateProjectPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const resolved = path.resolve(p);
  if (resolved.includes('..')) return undefined;
  return resolved;
}

interface RunOpts {
  cwd: string;
  sessionPath?: string;
  onProgress: ProgressFn;
  onSessionId?: (id: string) => void;
  /** Key used to register/deregister the child for cancelTask. */
  runKey: string;
}

async function runPi(prompt: string, opts: RunOpts): Promise<RunResult> {
  const args = ['--mode', 'json', '-p'];
  if (opts.sessionPath) args.push('--session', opts.sessionPath);
  args.push(prompt);

  const child = spawn(PI_BIN, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  running.set(opts.runKey, child);

  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

  let collected = '';
  let stderrBuf = '';
  let sessionId: string | undefined;

  child.stderr!.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
  });

  opts.onProgress('Thinking', '');

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }

    switch (event.type) {
      case 'session': {
        if (typeof event.id === 'string' && !sessionId) {
          sessionId = event.id;
          opts.onSessionId?.(event.id);
        }
        break;
      }
      case 'tool_execution_start': {
        const name = String(event.toolName || 'tool');
        opts.onProgress(verbForTool(name), describeToolTarget(name, event.args));
        break;
      }
      case 'message_end': {
        const msg = event.message;
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              collected += (collected ? '\n\n' : '') + block.text;
            }
          }
        }
        break;
      }
      case 'auto_retry_start':
        opts.onProgress('Retrying', `attempt ${event.attempt}/${event.maxAttempts}`);
        break;
      case 'compaction_start':
        opts.onProgress('Compacting', String(event.reason || ''));
        break;
    }
  });

  try {
    const exitCode: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0 && !collected) {
      const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
      throw new Error(`pi exited with code ${exitCode}${tail ? `: ${tail}` : ''}`);
    }

    if (!sessionId) {
      throw new Error('pi did not emit a session event – cannot track session id');
    }

    return {
      sessionId,
      result: collected || '(pi produced no assistant text)',
    };
  } finally {
    running.delete(opts.runKey);
  }
}

function verbForTool(name: string): string {
  switch (name) {
    case 'read': return 'Reading';
    case 'write': return 'Writing';
    case 'edit': return 'Editing';
    case 'bash': return 'Running';
    case 'grep': return 'Searching';
    case 'find': return 'Finding';
    case 'ls': return 'Listing';
    default: return 'Using';
  }
}

function describeToolTarget(name: string, args: any): string {
  if (!args || typeof args !== 'object') return '';
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return String(args.path || args.file || '');
    case 'bash':
      return String(args.command || '').slice(0, 80);
    case 'grep':
    case 'find':
      return String(args.pattern || args.query || '');
    case 'ls':
      return String(args.path || '.');
    default:
      return '';
  }
}

/** Start a fresh pi session. Pi allocates the session id; we capture it. */
export async function startTask(
  instruction: string,
  projectPath: string | undefined,
  onProgress: ProgressFn,
  onSessionId: (id: string) => void
): Promise<RunResult> {
  const cwd = validateProjectPath(projectPath) || process.cwd();
  // Use a temporary run key tied to our own ephemeral id until pi tells us
  // its session id. cancelTask uses pi's id once it's known; the initial
  // window before sessionStarted is vanishingly small.
  const runKey = `start:${Date.now()}:${Math.random()}`;
  const result = await runPi(instruction, {
    cwd,
    onProgress,
    onSessionId: (id) => {
      // Re-key the running child under pi's id so cancelTask works.
      const child = running.get(runKey);
      if (child) {
        running.delete(runKey);
        running.set(id, child);
      }
      onSessionId(id);
    },
    runKey,
  });
  return result;
}

/** Follow-up turn on an existing pi session. */
export async function resumeTask(
  sessionId: string,
  message: string,
  projectPath: string | undefined,
  onProgress: ProgressFn
): Promise<RunResult> {
  const info = await resolveSessionPath(sessionId, projectPath);
  if (!info) {
    throw new Error(`pi session ${sessionId} not found (expected in ~/.pi/agent/sessions/)`);
  }
  if (!fs.existsSync(info.path)) {
    throw new Error(`pi session file missing: ${info.path}`);
  }
  const cwd = validateProjectPath(projectPath) || info.cwd || process.cwd();
  return runPi(message, {
    cwd,
    sessionPath: info.path,
    onProgress,
    runKey: sessionId,
  });
}

export function cancelTask(sessionId: string): void {
  const child = running.get(sessionId);
  if (!child) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running.has(sessionId)) child.kill('SIGKILL');
  }, 2000).unref();
  running.delete(sessionId);
}
