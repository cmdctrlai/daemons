import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import type { OpenCodeCommand } from '../adapter/opencode';
import type { OpenCodeMessage } from '../adapter/transcript';

/**
 * A stand-in for `opencode serve` with the behaviour the daemon depends on, as
 * observed on opencode 1.18.25: commands are read once per project instance and
 * re-read only after that instance is disposed; turns start with `prompt_async`
 * and are reported on `/global/event`.
 */
export class FakeOpenCode {
  /** What is on disk per project – what a fresh instance would load. */
  disk = new Map<string, OpenCodeCommand[]>();
  sessions: Array<Record<string, unknown>> = [];
  transcripts = new Map<string, OpenCodeMessage[]>();
  sessionDirs = new Map<string, string>();
  /** A child session's parent, as opencode reports it for a subagent's session. */
  parents = new Map<string, string>();
  /** Per project, the sessions this server is running a turn in, as /session/status reports them. */
  statuses = new Map<string, Record<string, { type: string }>>();
  permissions: unknown[] = [];
  questions: unknown[] = [];
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
  /** Set by holdRoute: a route's response waits until released. */
  hold = new Map<string, Promise<void>>();

  private instances = new Map<string, OpenCodeCommand[]>();
  private streams = new Set<ServerResponse>();
  private releases: Array<() => void> = [];
  private server: Server = createServer((req, res) => void this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Releases anything still held, so a failed test can't leave a request hanging. */
  stop(): Promise<void> {
    for (const release of this.releases) release();
    for (const stream of this.streams) stream.end();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  holdRoute(key: string): () => void {
    let release!: () => void;
    this.hold.set(key, new Promise<void>((resolve) => { release = resolve; }));
    this.releases.push(release);
    return release;
  }

  calls(method: string, path: string) {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  /** Publish an event to every open `/global/event` stream. */
  emit(type: string, properties: Record<string, unknown>, directory = '/srv/daemon'): void {
    const data = JSON.stringify({ directory, payload: { id: 'evt_x', type, properties } });
    for (const stream of this.streams) stream.write(`data: ${data}\n\n`);
  }

  /** Cut every event stream, as a restart or network blip would. */
  dropStreams(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  get streamCount(): number {
    return this.streams.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://fake');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const key = `${req.method} ${url.pathname}`;
    this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });

    await this.hold.get(key);
    const directory = url.searchParams.get('directory') ?? '/srv/daemon';
    const json = (value: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const session = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);

    if (key === 'GET /global/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (key === 'GET /experimental/session') return json(this.sessions);
    if (key === 'GET /session/status') return json(this.statuses.get(directory) ?? {});
    if (key === 'GET /path') return json({ directory: '/srv/daemon' });
    if (key === 'POST /session') return json({ id: 'ses_new', directory });
    if (key === 'POST /instance/dispose') {
      this.instances.delete(directory);
      return json(true);
    }
    if (key === 'GET /command') {
      if (!this.instances.has(directory)) {
        this.instances.set(directory, [...(this.disk.get(directory) ?? [])]);
      }
      return json(this.instances.get(directory));
    }
    if (key === 'GET /permission') return json(this.permissions);
    if (key === 'GET /question') return json(this.questions);
    if (/^POST \/(permission|question)\/[^/]+\/reply$/.test(key)) return json(true);
    if (session && session[1] === 'ses_gone') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (session && req.method === 'GET' && !session[2]) {
      return json({ id: session[1], directory: this.sessionDirs.get(session[1]) ?? '/srv/daemon', parentID: this.parents.get(session[1]) });
    }
    if (session && req.method === 'GET' && session[2] === '/message') {
      const all = this.transcripts.get(session[1]) ?? [];
      const limit = Number(url.searchParams.get('limit') ?? 0);
      return json(limit ? all.slice(-limit) : all);
    }
    if (session && req.method === 'POST' && session[2] === '/prompt_async') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (session && req.method === 'POST' && ['/command', '/summarize', '/message', '/abort'].includes(session[2] ?? '')) {
      return json(true);
    }
    res.statusCode = 404;
    res.end();
  }
}

/** A message as opencode stores it, for building transcripts in tests. */
export function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<OpenCodeMessage['info']> = {},
  parts: OpenCodeMessage['parts'] = [],
): OpenCodeMessage {
  return {
    info: { id, role, time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 }, finish: 'stop', ...extra },
    parts: [...(text ? [{ type: 'text', text }] : []), ...parts],
  };
}

export async function waitFor(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error(`${what} never became true`);
}
