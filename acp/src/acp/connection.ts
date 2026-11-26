/**
 * JSON-RPC 2.0 over a pair of streams, one message per line – the transport ACP
 * runs on between a client and the agent it spawned.
 *
 * Both sides send requests: we ask the agent to prompt, and the agent asks us for
 * permission. Ids are only unique per direction, so an id the agent uses for its
 * request says nothing about ours; and ids may be 0, which is still an id.
 */
import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A request we sent that the agent answered with an error. The message carries
 * the agent's detail when it gives one – Qwen Code answers "Internal error" and
 * puts the cause, a bad key or a rate limit, in `data.details`.
 */
export class RpcRequestError extends Error {
  constructor(readonly method: string, readonly error: RpcError) {
    const summary = error.message || `${method} failed (${error.code})`;
    const detail = errorDetail(error.data);
    super(detail && detail !== summary ? `${summary}: ${detail}` : summary);
  }
}

function errorDetail(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (!data || typeof data !== 'object') return '';
  const { details, message } = data as { details?: unknown; message?: unknown };
  if (typeof details === 'string') return details.trim();
  return typeof message === 'string' ? message.trim() : '';
}

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
export const REQUEST_CANCELLED = -32800;

type Id = number | string;

/** Handles a request the agent sends us; the resolved value is the result. */
export type RequestHandler = (method: string, params: any, id: Id) => Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class JsonRpcConnection extends EventEmitter {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: RequestHandler,
    private readonly onNotification: NotificationHandler,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    super();
    input.setEncoding('utf-8');
    input.on('data', (chunk: string) => this.receive(chunk));
    input.on('end', () => this.close(new Error('The agent closed its output')));
    input.on('error', (err) => this.close(err));
    output.on('error', (err) => this.close(err));
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The agent is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Fail everything still waiting, once. The agent is gone or unusable. */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    this.emit('close', reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private write(message: object): void {
    const line = JSON.stringify(message);
    this.log(`>> ${line}`);
    this.output.write(`${line}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    this.log(`<< ${line}`);
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      // An agent that logs to stdout corrupts nothing as long as its frames stay whole.
      return;
    }
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;

    if (typeof message.method === 'string') {
      if (hasId) void this.answer(message.id, message.method, message.params);
      else this.notifySafely(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcRequestError(pending.method, message.error));
    else pending.resolve(message.result ?? null);
  }

  private notifySafely(method: string, params: unknown): void {
    try {
      this.onNotification(method, params);
    } catch (err) {
      this.log(`!! notification ${method} handler threw: ${(err as Error).message}`);
    }
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params, id);
      if (!this.closed) this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      if (this.closed) return;
      const error: RpcError = isRpcError(err)
        ? err
        : { code: INTERNAL_ERROR, message: (err as Error)?.message ?? 'Internal error' };
      this.write({ jsonrpc: '2.0', id, error });
    }
  }
}

function isRpcError(value: unknown): value is RpcError {
  return !!value && typeof value === 'object' && typeof (value as RpcError).code === 'number'
    && typeof (value as RpcError).message === 'string' && !(value instanceof Error);
}
