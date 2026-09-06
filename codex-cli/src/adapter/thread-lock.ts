/**
 * Thread writer locks, and taking one back.
 *
 * Codex allows one writer per thread and the claim lives on a file descriptor,
 * so the only way to release someone else's claim is to end their process. That
 * is a destructive act on a window the user may be sitting in front of, so
 * everything here is built to refuse rather than guess: a holder we cannot
 * positively identify as the user's own codex CLI is left alone.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Where codex keeps one lock file per thread. */
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const LOCK_DIR = path.join(CODEX_HOME, 'thread-writer-locks');

/**
 * A turn writes to the rollout continuously, so a recent write means the holder
 * is mid-turn and killing it would destroy work with no other record. Ten
 * seconds is longer than any gap between deltas and short enough that a thread
 * abandoned at a prompt is never mistaken for a live one.
 */
const ACTIVE_WRITE_WINDOW_MS = 10_000;

/** How long to let a signalled process wind down before escalating. */
const TERM_GRACE_MS = 3_000;

/** Poll interval while waiting for a signalled process to drop the lock. */
const POLL_INTERVAL_MS = 100;

export interface LockHolder {
  pid: number;
  /** argv[0] as reported by ps, for logging and for the same-binary check. */
  command: string;
}

export type ForceQuitOutcome =
  | { status: 'released'; pid: number }
  | { status: 'shared' }
  | { status: 'not_held' }
  | { status: 'busy' }
  | { status: 'foreign' }
  | { status: 'failed'; reason: string };

export function lockPathFor(threadId: string): string {
  return path.join(LOCK_DIR, `${threadId}.lock`);
}

/**
 * The pids holding a thread's lock file open. Empty when the file is absent,
 * unlocked, or lsof is unavailable – all of which mean "nothing to take back".
 */
async function pidsHolding(lockPath: string): Promise<number[]> {
  if (!fs.existsSync(lockPath)) return [];
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '--', lockPath]);
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // lsof exits non-zero when no process has the file open.
    return [];
  }
}

/** The owning uid of a pid, or null if it is gone. */
async function uidOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'uid=', '-p', String(pid)]);
    const uid = Number(stdout.trim());
    return Number.isInteger(uid) ? uid : null;
  } catch {
    return null;
  }
}

/**
 * The binary a pid is actually executing.
 *
 * Deliberately not `ps -o comm=`: on macOS that reports argv[0], which the
 * target process chooses. `exec -a codex /bin/sleep` reports `codex`, and the
 * real codex at ~/.npm-global/bin/codex reports `node`. Identifying a process
 * we are about to kill by a name it made up is not identification at all.
 *
 * lsof's `txt` descriptor is the mapped executable, set by the kernel. The
 * first entry is the program; the rest are the dynamic linker and libraries.
 */
async function executableOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-p',
      String(pid),
      '-a',
      '-d',
      'txt',
      '-Fn',
    ]);
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const candidate = line.slice(1).trim();
      if (candidate) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an executable path is a codex the user is running in a terminal.
 *
 * Must be given a real executable path – see executableOf. Two things get
 * excluded, and both were holding real locks on this machine when the check was
 * written. `codex-code-mode-host` and the crashpad helpers merely have "codex"
 * in the name. The harder one is the ChatGPT desktop app, which bundles a
 * binary at `/Applications/ChatGPT.app/Contents/Resources/codex` – basename and
 * all – so name alone would have us closing a window of an app the user never
 * asked us to touch. Nothing inside a `.app` bundle is a terminal session, so
 * nothing inside one is ours to end.
 */
export function isCodexCli(executable: string): boolean {
  if (path.basename(executable) !== 'codex') return false;
  if (!path.isAbsolute(executable)) return false;
  if (executable.includes('.app/Contents/')) return false;
  // codex now also ships an app-server inside its own plugin directory, put
  // there by the ChatGPT desktop app. Same binary, same name, and not a
  // terminal session either.
  return !executable.startsWith(path.join(CODEX_HOME, 'plugins') + path.sep);
}

/**
 * Every thread this process holds the writer lock for.
 *
 * A codex process is not one session. A TUI with subagents holds the parent
 * thread and each child -- four on this machine at the time of writing -- and
 * the daemon surfaces those children in the app as sessions of their own. A
 * signal does not distinguish between them, so this is what decides whether
 * the process is safe to end at all.
 */
export async function locksHeldBy(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-p', String(pid), '-Fn']);
    const ids: string[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const file = line.slice(1).trim();
      if (path.dirname(file) !== LOCK_DIR) continue;
      const id = path.basename(file, '.lock');
      if (isThreadId(id)) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Codex thread ids, as they appear in rollout filenames and lock filenames.
 * Anything else is refused before it reaches a path: the id arrives from the
 * server, and `foo/../../etc/passwd` would otherwise become a lock path and a
 * signal target.
 */
const THREAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value);
}

/**
 * The process holding this thread, if it is one we are willing to end: the
 * user's own uid, running the codex CLI. Anything else reports null and the
 * caller leaves it alone.
 */
export async function findLockHolder(
  threadId: string
): Promise<LockHolder | null> {
  if (!isThreadId(threadId)) return null;
  const ourUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (ourUid === null) return null;

  for (const pid of await pidsHolding(lockPathFor(threadId))) {
    if (pid === process.pid) continue;
    if ((await uidOf(pid)) !== ourUid) continue;
    const executable = await executableOf(pid);
    if (!executable || !isCodexCli(executable)) continue;
    return { pid, command: executable };
  }
  return null;
}

/**
 * Whether the thread's rollout was written to just now, which is the only
 * signal available that the holder is mid-turn – the app-server tells us
 * nothing about a session it does not own.
 */
export function isMidTurn(
  rolloutPath: string | null,
  now: number = Date.now()
): boolean {
  if (!rolloutPath) return false;
  try {
    const { mtimeMs } = fs.statSync(rolloutPath);
    return now - mtimeMs < ACTIVE_WRITE_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Whether a pid still exists, without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRelease(
  threadId: string,
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid) && (await pidsHolding(lockPathFor(threadId))).length === 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * End the process holding a thread so the daemon can resume it.
 *
 * Refuses on anything ambiguous: no holder, a holder we did not positively
 * identify, or a rollout being written to right now. Returning the lock without
 * confirming the process is gone would only produce a second failed resume, so
 * the wait is part of the operation rather than an optimisation.
 */
export async function forceQuitLockHolder(
  threadId: string,
  rolloutPathFor: (threadId: string) => string | null,
  isRunningHere: (threadId: string) => boolean = () => false
): Promise<ForceQuitOutcome> {
  if (!isThreadId(threadId)) {
    return { status: 'failed', reason: 'not a codex thread id' };
  }
  const holder = await findLockHolder(threadId);
  if (!holder) {
    // Either free already, or held by something that is not ours to end.
    const stillHeld = (await pidsHolding(lockPathFor(threadId))).length > 0;
    return stillHeld ? { status: 'foreign' } : { status: 'not_held' };
  }

  // One process, one session, or we do not touch it.
  //
  // Everything about this feature is inferred from codex's internals -- where
  // it puts lock files, how it names them, which process ends up holding one.
  // Reasoning about a process that owns several threads means reasoning about
  // parents and subagents and which of them is mid-turn, and three review
  // passes each found a different wrong assumption in exactly that reasoning.
  // A process holding one lock needs none of it: what dies is what the user
  // asked to close. Anything else is refused and explained.
  const held = await locksHeldBy(holder.pid);
  if (held.length > 1) return { status: 'shared' };

  if (isRunningHere(threadId)) return { status: 'busy' };
  if (isMidTurn(rolloutPathFor(threadId))) return { status: 'busy' };

  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }

  if (await waitForRelease(threadId, holder.pid, TERM_GRACE_MS)) {
    return { status: 'released', pid: holder.pid };
  }

  // The user asked for a force quit, and a codex that ignored SIGTERM is not
  // going to yield to a second one. Re-identify first: several seconds have
  // passed, and if the holder died while something else took the lock, this pid
  // may now belong to an unrelated process.
  if (!isAlive(holder.pid)) return { status: 'released', pid: holder.pid };
  const stillOurs = await executableOf(holder.pid);
  if (!stillOurs || stillOurs !== holder.command) {
    return { status: 'failed', reason: 'the process holding this session changed' };
  }

  try {
    process.kill(holder.pid, 'SIGKILL');
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }

  if (await waitForRelease(threadId, holder.pid, TERM_GRACE_MS)) {
    return { status: 'released', pid: holder.pid };
  }
  return { status: 'failed', reason: 'lock still held after SIGKILL' };
}
