/**
 * AppServerClient
 *
 * Owns a long-lived `codex app-server` child process and speaks JSON-RPC 2.0
 * over JSONL stdio. Responsibilities:
 *   - spawn and supervise the child (auto-restart with backoff)
 *   - do the initialize / initialized handshake
 *   - correlate outgoing requests with incoming responses
 *   - dispatch server notifications to subscribed handlers
 *
 * Intentionally agnostic about thread/turn semantics – that lives in
 * AppServerAdapter.
 */

import { spawn, ChildProcess } from 'child_process';
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
const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

function findCodexCli(): string {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
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
  /** Invoked after a successful (re)connect and handshake. Used by the adapter
   * to re-subscribe to live threads. */
  onReady?: () => void | Promise<void>;
  /** Invoked when the child process exits and cannot be restarted. */
  onFatal?: (err: Error) => void;
}

export class AppServerClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private ready = false;
  private stopped = false;
  private restartAttempt = 0;
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

  /** Stop the child. After this, start() cannot be called again. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const proc = this.proc;
    this.proc = null;
    this.failAllPending(new Error('AppServerClient stopped'));
    if (proc) {
      proc.kill('SIGTERM');
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
    this.restartAttempt = 0;
    console.log(
      `[AppServer] Ready: ${result.userAgent} (${result.platformOs})`
    );

    // Fire onReady – the adapter uses this to re-subscribe live threads.
    try {
      await this.options.onReady?.();
    } catch (err) {
      console.error('[AppServer] onReady handler threw:', err);
    }

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
          new Error(`${pending.method}: ${err.error.code} ${err.error.message}`)
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
    this.ready = false;
    this.proc = null;
    this.failAllPending(err);
    this.initializePromise = null;
    if (this.stopped) return;

    const delay =
      RESTART_BACKOFF_MS[
        Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)
      ];
    this.restartAttempt++;
    console.log(
      `[AppServer] Restarting in ${delay}ms (attempt ${this.restartAttempt})`
    );
    setTimeout(() => {
      if (this.stopped) return;
      this.spawnAndInitialize().catch((e) => {
        console.error('[AppServer] Restart failed:', e);
        this.options.onFatal?.(e instanceof Error ? e : new Error(String(e)));
      });
    }, delay);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
