import { readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import type { V2Message } from '../v2/transcript';

const FIXTURES = join(__dirname, '..', 'v2', 'fixtures');

/** A fixture captured from a real opencode 2.2.5 run. */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
}

/** The `data:` payloads of a captured event stream, in order. */
export function frames(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

export const PASSWORD = 'test-password';

/**
 * A stand-in for opencode 2.2.5's server: every route under `/api`, behind Basic
 * auth, answered from captured fixtures. Events are replayed by the test.
 */
export class FakeOpenCodeV2 {
  /** Each session's messages, oldest first, as `/message` serves them. */
  transcripts = new Map<string, V2Message[]>();
  sessions: Array<Record<string, any>> = [];
  commands: unknown[] = [];
  skills: unknown[] = [];
  permissions: unknown[] = [];
  forms: unknown[] = [];
  /** Per session and user message, the files `/diff?from=` returns. */
  diffs = new Map<string, unknown[]>();
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: any; auth?: string }> = [];

  private streams = new Set<ServerResponse>();
  private server: Server = createServer((req, res) => void this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  calls(method: string, path: string) {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  /** Replay captured frames to every open `/api/event` stream. */
  emit(...payloads: string[]): void {
    for (const data of payloads) {
      for (const stream of this.streams) stream.write(`data: ${data}\n\n`);
    }
  }

  get streamCount(): number {
    return this.streams.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://fake');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body, auth: req.headers.authorization });

    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`) {
      return json({ _tag: 'UnauthorizedError', message: 'Unauthorized' }, 401);
    }
    const key = `${req.method} ${url.pathname}`;
    const session = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);

    if (key === 'GET /api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (key === 'GET /api/location') return json({ directory: '/srv/daemon', project: { id: 'global' } });
    if (key === 'GET /api/command') return json({ location: { directory: url.searchParams.get('location[directory]') }, data: this.commands });
    if (key === 'GET /api/skill') return json({ data: this.skills });
    if (key === 'GET /api/permission/request') return json({ data: this.permissions });
    if (key === 'GET /api/form') return json({ data: this.forms });
    if (key === 'GET /api/session') return json({ data: this.sessions, cursor: { previous: null, next: null } });
    if (key === 'POST /api/session') return json({ data: { id: 'ses_new', location: body?.location ?? { directory: '/srv/daemon' } } });
    if (!session) return json({ message: 'not found' }, 404);

    const [, id, rest = ''] = session;
    if (req.method === 'GET' && rest === '') {
      const found = this.sessions.find((s) => s.id === id);
      return found ? json({ data: found }) : json({ _tag: 'SessionNotFoundError', sessionID: id, message: 'Session not found' }, 404);
    }
    if (req.method === 'GET' && rest === '/message') return json(this.page(id, url.searchParams));
    if (req.method === 'GET' && rest === '/diff') return json({ data: this.diffs.get(`${id} ${url.searchParams.get('from')}`) ?? [] });
    if (req.method === 'POST' && rest === '/prompt') return json({ data: { id: 'msg_queued', type: 'user' } });
    if (req.method === 'POST' && rest === '/compact') return json({ data: { id: 'msg_compaction', type: 'compaction' } });
    if (req.method === 'POST' && rest === '/interrupt') return json({ interrupted: true });
    if (req.method === 'POST' && (rest === '/command' || /^\/(permission|form)\/[^/]+\/reply$/.test(rest))) {
      res.writeHead(204);
      res.end();
      return;
    }
    json({ message: 'not found' }, 404);
  }

  /** v2's paging: newest or oldest first, at most 200, with a cursor past the page. */
  private page(id: string, query: URLSearchParams): { data: V2Message[]; cursor: { next: string | null } } {
    const all = this.transcripts.get(id) ?? [];
    const limit = Math.min(Number(query.get('limit') ?? 50), 200);
    const cursor = query.get('cursor');
    if (cursor) {
      const { from } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      const data = all.slice(from, from + limit);
      return { data, cursor: { next: data.length ? encode(from + limit) : null } };
    }
    if (query.get('order') === 'asc') {
      return { data: all.slice(0, limit), cursor: { next: encode(limit) } };
    }
    return { data: all.slice(-limit).reverse(), cursor: { next: null } };
  }
}

function encode(from: number): string {
  return Buffer.from(JSON.stringify({ from })).toString('base64url');
}
