import { get, type ClientRequest } from 'http';

/** One event from opencode's bus, e.g. `session.idle` or `permission.asked`. */
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, any>;
  /** The project instance it came from; replies to its requests go back there. */
  directory?: string;
}

/** Where an opencode server publishes its events, and how to read one. */
export interface EventFeed {
  path: string;
  /** Read at every connect: a server's password can be learned after the feed is made. */
  headers?: () => Record<string, string>;
  /** One `data:` payload as the events it carries; opencode 1.x's own shape when omitted. */
  parse?: (data: string) => OpenCodeEvent[];
}

const GLOBAL_EVENTS: EventFeed = { path: '/global/event' };
const RECONNECT_MS = 1000;

/**
 * opencode's global event stream: every project's events on one connection.
 *
 * Plain `http` rather than fetch, whose body timeout would cut the stream during a
 * quiet stretch. Reconnects by itself; `onConnect` runs after every connect so the
 * caller can catch up on anything that happened while the stream was down.
 */
export class OpenCodeEvents {
  private request?: ClientRequest;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly onEvent: (event: OpenCodeEvent) => void,
    private readonly onConnect: () => void,
    private readonly source: EventFeed = GLOBAL_EVENTS,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.request?.destroy();
  }

  private connect(): void {
    if (this.stopped) return;
    let retried = false;
    const retry = () => {
      if (retried || this.stopped) return;
      retried = true;
      setTimeout(() => this.connect(), RECONNECT_MS);
    };

    const headers = { Accept: 'text/event-stream', ...this.source.headers?.() };
    this.request = get(`${this.baseUrl}${this.source.path}`, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        retry();
        return;
      }
      this.onConnect();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) this.dispatch(line.slice(5));
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    this.request.on('error', retry);
  }

  private dispatch(data: string): void {
    for (const event of (this.source.parse ?? parseGlobalEvent)(data)) {
      if (event?.type) this.onEvent(event);
    }
  }
}

function parseGlobalEvent(data: string): OpenCodeEvent[] {
  try {
    const parsed = JSON.parse(data);
    return [parsed.payload ? { ...parsed.payload, directory: parsed.directory } : parsed];
  } catch {
    return [];
  }
}
