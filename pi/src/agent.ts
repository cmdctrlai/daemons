/**
 * Pi agent integration.
 *
 * Spawns the `pi` CLI in JSON event-stream mode (`--mode json -p`) for each
 * task, with the user's message on stdin. Pi owns session storage: on a fresh task we pass no `--session`, and
 * pi writes the new session file at `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`.
 * We capture the session id from the first `{"type":"session",...}` event in
 * the event stream and surface it as our native session id. On resume, we
 * point pi at the same file via `--session <path>`, which we resolve through
 * the active session source – no hand-rolled path math and the session remains
 * visible to `pi --resume`. omp takes the same flags and writes under `~/.omp/agent/`.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import { AGENT_TYPE, PI_BIN } from './context';
import { resolveSessionPath } from './session-reader';
import { sessionSource } from './session-source';

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

  // The message goes on stdin, never in argv: as an argument, one that starts
  // with `-` is read as a flag and one that starts with `@` as a file to attach.
  // A `--` separator is not enough – pi still reads `@` as a file after it.
  const child = spawn(PI_BIN, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdin!.on('error', () => { /* the agent exited before reading; its exit code says why */ });
  child.stdin!.end(prompt);
  running.set(opts.runKey, child);

  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

  let collected = '';
  let modelError: string | undefined;
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
        if (msg?.role === 'assistant') {
          // A failed model call ends the turn with exit code 0; the error is only here.
          // A retry that succeeds clears it.
          modelError = msg.stopReason === 'error' ? String(msg.errorMessage || 'The model request failed') : undefined;
          for (const block of Array.isArray(msg.content) ? msg.content : []) {
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

    if (modelError) throw new Error(modelError);

    if (exitCode !== 0 && !collected) {
      const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
      throw new Error(`${AGENT_TYPE} exited with code ${exitCode}${tail ? `: ${tail}` : ''}`);
    }

    if (!sessionId) {
      throw new Error(`${AGENT_TYPE} did not emit a session event – cannot track session id`);
    }

    return {
      sessionId,
      result: collected || `(${AGENT_TYPE} produced no assistant text)`,
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

/**
 * One agent process per session at a time. The app keeps its composer open while
 * a turn runs, so a follow-up can arrive mid-turn; run at once, it would be a
 * second writer on the same session – omp moves it to a continuation that then
 * diverges from the original, pi interleaves two branches in one file. Each
 * session's turns therefore run one after another: the tail of its queue.
 */
const turns = new Map<string, Promise<void>>();

/** Bumped by cancelTask: a turn queued before the stop is dropped, not run. */
const stops = new Map<string, number>();

function queueTurn<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const before = turns.get(sessionId) ?? Promise.resolve();
  const stopsWhenQueued = stops.get(sessionId) ?? 0;
  const result = before.then(() => {
    if ((stops.get(sessionId) ?? 0) !== stopsWhenQueued) {
      throw new Error('Not sent: the session was stopped while this message waited for the turn before it.');
    }
    return run();
  });
  const settled = result.then(() => undefined, () => undefined);
  turns.set(sessionId, settled);
  void settled.then(() => { if (turns.get(sessionId) === settled) turns.delete(sessionId); });
  return result;
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
  // A follow-up can only name this session once its id is known, so that is
  // when this turn becomes the head of the session's queue.
  let ended!: () => void;
  const finished = new Promise<void>(resolve => { ended = resolve; });
  let sessionId: string | undefined;
  try {
    return await runPi(instruction, {
      cwd,
      onProgress,
      onSessionId: (id) => {
        sessionId = id;
        if (!turns.has(id)) turns.set(id, finished);
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
  } finally {
    ended();
    if (sessionId && turns.get(sessionId) === finished) turns.delete(sessionId);
  }
}

/** Follow-up turn on an existing pi session; waits for any turn already running on it. */
export function resumeTask(
  sessionId: string,
  message: string,
  projectPath: string | undefined,
  onProgress: ProgressFn
): Promise<RunResult> {
  return queueTurn(sessionId, async () => {
    // Resolved only now: the turn before may have moved the session (an omp continuation).
    const source = sessionSource();
    const info = await resolveSessionPath(sessionId, projectPath);
    if (!info) {
      throw new Error(`${source.agent} session ${sessionId} not found (expected in ${source.location})`);
    }
    if (!fs.existsSync(info.path)) {
      throw new Error(`${source.agent} session file missing: ${info.path}`);
    }
    const cwd = validateProjectPath(projectPath) || info.cwd || process.cwd();
    return runPi(message, {
      cwd,
      sessionPath: info.path,
      onProgress,
      runKey: sessionId,
    });
  });
}

/**
 * Stop the session: end the running turn, and drop any follow-up still waiting
 * behind it (each fails with a message saying it was not sent).
 */
export function cancelTask(sessionId: string): void {
  stops.set(sessionId, (stops.get(sessionId) ?? 0) + 1);
  const child = running.get(sessionId);
  if (!child) return;
  child.kill('SIGTERM');
  // runPi drops the child from `running` when it exits; still there means it
  // ignored SIGTERM, and the session's next turn is waiting on it.
  setTimeout(() => {
    if (running.get(sessionId) === child) child.kill('SIGKILL');
  }, 2000).unref();
}
