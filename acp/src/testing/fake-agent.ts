/**
 * An ACP agent process for tests: newline-delimited JSON-RPC on in-memory
 * streams, answering the client's requests from a table of handlers and able to
 * send its own requests and notifications.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

export type Handler = (params: any) => unknown | Promise<unknown>;

export class FakeAgentProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  /** Every message the client sent, in order. */
  readonly received: any[] = [];
  private nextId = 0;
  private pending = new Map<number, (message: any) => void>();
  private buffer = '';

  constructor(private readonly handlers: Record<string, Handler>) {
    super();
    this.stdin.setEncoding('utf-8');
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) void this.receive(JSON.parse(line));
      }
    });
  }

  /** A notification from the agent, e.g. session/update. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** A request from the agent; resolves with the client's whole response message. Ids start at 0, as dsh's do. */
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Raw line onto stdout, for malformed-input cases. */
  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.emit('exit', code, null);
  }

  kill(): boolean {
    this.exit(143);
    return true;
  }

  get pid(): number {
    return 4242;
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  sentMethods(): string[] {
    return this.received.filter((m) => m.method).map((m) => m.method);
  }

  private async receive(message: any): Promise<void> {
    this.received.push(message);
    if (message.method === undefined) {
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve?.(message);
      return;
    }
    if (message.id === undefined) return;
    const handler = this.handlers[message.method];
    if (!handler) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (err) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: (err as Error).message } });
    }
  }

  private write(message: object): void {
    if (this.exitCode === null) this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

export const INIT_OK = (capabilities: object = {}) => () => ({
  protocolVersion: 1,
  agentInfo: { name: 'fake', title: 'Fake Agent', version: '1.0.0' },
  agentCapabilities: capabilities,
  authMethods: [],
});

/** Resolve after pending stream callbacks and microtasks have run. */
export function flush(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
