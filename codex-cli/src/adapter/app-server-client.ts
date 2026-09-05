/**
 * AppServerClient
 *
 * Owns one `codex app-server` child process and speaks JSON-RPC 2.0 over JSONL
 * stdio. Responsibilities:
 *   - spawn the child and do the initialize / initialized handshake
 *   - correlate outgoing requests with incoming responses
 *   - dispatch server notifications to subscribed handlers
 *   - report an unexpected child exit so the caller can fail its work
 *
 * The child's lifetime is the caller's to choose, and it is load-bearing rather
 * than an implementation detail: codex ties a thread's writer lock to the
 * app-server process that resumed it (~/.codex/thread-writer-locks/<id>.lock),
 * and nothing in the protocol hands that lock back. Exiting the process is the
 * only release, so a caller that wants a thread freed has to stop() its client.
 *
 * Intentionally agnostic about thread/turn semantics – that lives in
 * CodexAdapter.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  InitializeParams,
  InitializeResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestId,
  isError,
  isResponse,
} from './protocol-types';

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min – long enough for turn/start

/** Per escalation step in stop(); codex exits on stdin EOF in about 500ms. */
const STOP_GRACE_MS = 2000;

/** True if the promise settled in time, false if the wait ran out. */
async function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A JSON-RPC error response, kept structured so callers can match on the
 * server's own message instead of re-parsing a flattened string.
 */
export class AppServerError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly serverMessage: string
  ) {
    super(`${method}: ${code} ${serverMessage}`);
    this.name = 'AppServerError';
  }
}

/**
 * Where a codex binary might live, in preference order.
 *
 * The last two are not on any PATH the npm install controls: codex now ships
 * inside the ChatGPT app and in its own plugin directory, and a user who got
 * codex that way has no `codex` on PATH at all.
 */
export function codexCandidates(home: string): string[] {
  return [
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ];
}

/**
 * The first candidate that actually runs, or null if none does.
 *
 * Existing is not the same as working: an npm install whose platform package
 * failed to unpack leaves a `codex` symlink pointing at a vendored binary that
 * is not there, and spawning it dies with ENOENT. Picking that one and stopping
 * takes the daemon down while a perfectly good codex sits at the next path, so
 * a candidate has to answer before it is trusted and a broken one is skipped.
 */
export function selectCodexBinary(
  candidates: string[],
  exists: (p: string) => boolean,
  works: (p: string) => boolean,
): string | null {
  for (const p of candidates) {
    if (!exists(p)) continue;
    if (!works(p)) {
      console.warn(`[AppServer] Ignoring codex at ${p}: present but does not run`);
      continue;
    }
    return p;
  }
  return null;
}

function codexBinaryRuns(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Resolved once: probing spawns a process per candidate. */
let resolvedCodexCli: string | null = null;

function findCodexCli(): string {
  // An explicit override is the operator's business and is taken at face value.
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (resolvedCodexCli) return resolvedCodexCli;

  const found = selectCodexBinary(
    codexCandidates(os.homedir()),
    (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    codexBinaryRuns,
  );
  if (found) {
    resolvedCodexCli = found;
    return found;
  }
  // Nothing on disk worked. Fall back to PATH so a codex we don't know about
  // still gets a chance, and let spawn report the failure if there isn't one.
  return 'codex';
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export type NotificationHandler = (params: unknown) => void;

export interface AppServerClientOptions {
  clientName?: string;
  clientVersion?: string;
  /**
   * Invoked when the child exits without stop() having been called. The thread
   * this client held is gone with it, so the caller's work cannot continue.
   */
  onExit?: (err: Error) => void;
}

export class AppServerClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private ready = false;
  private stopped = false;
  private initializePromise: Promise<InitializeResponse> | null = null;

  constructor(private options: AppServerClientOptions = {}) {
    super();
  }

  /** Start the child and complete the initialize handshake. */
  async start(): Promise<InitializeResponse> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.spawnAndInitialize();
    return this.initializePromise;
  }

  /**
   * Stop the child, releasing the writer lock on any thread it holds. Safe to
   * call more than once. After this, start() cannot be called again.
   *
   * Resolves only once the process is actually gone, because "released" is a
   * claim about the kernel having dropped the lock descriptor, not about a
   * signal having been sent. Closing stdin first is what codex itself treats as
   * a shutdown -- it exits on EOF within about half a second -- and SIGTERM
   * then SIGKILL cover a child that is wedged rather than listening.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const proc = this.proc;
    this.proc = null;
    this.failAllPending(new Error('AppServerClient stopped'));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));

    try {
      proc.stdin?.end();
    } catch {
      // Already closed; the signals below still apply.
    }
    proc.kill('SIGTERM');

    if (await settledWithin(exited, STOP_GRACE_MS)) return;

    console.warn('[AppServer] Child ignored SIGTERM, sending SIGKILL');
    proc.kill('SIGKILL');
    if (!(await settledWithin(exited, STOP_GRACE_MS))) {
      console.error(
        '[AppServer] Child survived SIGKILL; a thread writer lock may still be held'
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Register a handler for a server notification method (e.g. "turn/started"). */
  on(event: string, handler: NotificationHandler): this {
    let set = this.notificationHandlers.get(event);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: NotificationHandler): this {
    this.notificationHandlers.get(event)?.delete(handler);
    return this;
  }

  /** Send a JSON-RPC request and await the response. */
  async request<Result = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<Result> {
    if (!this.ready || !this.proc) {
      throw new Error(`AppServerClient not ready (request: ${method})`);
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (r) => resolve(r as Result),
        reject,
        method,
        timer,
      });

      try {
        this.proc!.stdin!.write(JSON.stringify(req) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a fire-and-forget JSON-RPC notification. */
  notify(method: string, params: unknown): void {
    if (!this.proc) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    try {
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      console.error(`[AppServer] Failed to send notification ${method}:`, err);
    }
  }

  // --- internals ---------------------------------------------------------

  private async spawnAndInitialize(): Promise<InitializeResponse> {
    this.spawnChild();
    return this.doInitialize();
  }

  private spawnChild(): void {
    const bin = findCodexCli();
    console.log(`[AppServer] Spawning: ${bin} app-server`);
    const proc = spawn(bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc = proc;

    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => this.handleLine(line));

    proc.stderr?.on('data', (data) => {
      // codex app-server writes structured logs + config warnings to stderr.
      // Forward at debug granularity.
      const text = data.toString().trimEnd();
      if (text) console.log(`[AppServer stderr] ${text}`);
    });

    proc.on('error', (err) => {
      console.error('[AppServer] Process error:', err);
      this.handleChildExit(err);
    });

    proc.on('exit', (code, signal) => {
      console.log(`[AppServer] Exited code=${code} signal=${signal}`);
      this.handleChildExit(
        new Error(`codex app-server exited code=${code} signal=${signal}`)
      );
    });
  }

  private async doInitialize(): Promise<InitializeResponse> {
    // We must send `initialize` before `this.ready = true` (since request()
    // checks ready). Do it manually without going through request().
    const id = this.nextId++;
    const params: InitializeParams = {
      clientInfo: {
        name: this.options.clientName ?? 'cmdctrl-codex-cli',
        title: null,
        version: this.options.clientVersion ?? '0.0.0',
      },
      capabilities: { experimentalApi: false },
    };
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params,
    };

    const result = await new Promise<InitializeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('initialize timed out'));
      }, 10000);
      this.pending.set(id, {
        resolve: (r) => resolve(r as InitializeResponse),
        reject,
        method: 'initialize',
        timer,
      });
      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
    });

    // Send the `initialized` notification
    const initNotif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    };
    this.proc!.stdin!.write(JSON.stringify(initNotif) + '\n');

    this.ready = true;
    console.log(
      `[AppServer] Ready: ${result.userAgent} (${result.platformOs})`
    );

    return result;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[AppServer] Non-JSON line from server: ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        console.warn(`[AppServer] Response for unknown id ${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (isError(msg)) {
        const err = msg as JsonRpcErrorResponse;
        pending.reject(
          new AppServerError(pending.method, err.error.code, err.error.message)
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification
    const notif = msg as JsonRpcNotification;
    const handlers = this.notificationHandlers.get(notif.method);
    if (handlers && handlers.size > 0) {
      for (const h of handlers) {
        try {
          h(notif.params);
        } catch (err) {
          console.error(
            `[AppServer] Notification handler for ${notif.method} threw:`,
            err
          );
        }
      }
    }
  }

  private handleChildExit(err: Error): void {
    const wasRunning = this.proc !== null;
    this.ready = false;
    this.proc = null;
    this.failAllPending(err);
    this.initializePromise = null;
    // A stopped client exiting is the point of stop(); only an exit we did not
    // ask for is news. Restarting here would be pointless: the child took the
    // thread's writer lock and its history with it, so the turn cannot resume.
    if (this.stopped || !wasRunning) return;
    this.options.onExit?.(err);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
